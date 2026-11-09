---
category: ccnubox
type: deep-dive
topic: dau
module: bff
status: done
title: BFF DAU 验证与运维
aliases:
  - BFF DAU测试与运维
tags:
  - ccnubox
  - ccnubox/bff
  - ccnubox/dau
---
# DAU 验证与运维

本文档补充 [[BFF DAU实现]]，聚焦 Redis key 设计、测试覆盖、监控要点和常见排障问题。

> [!note] 源码版本
> 基于 submodule `source/ccnubox-be` 的 commit `a5d65f8`（`a5d65f8844014ad04eb35bafc401bf1513ee5b38`）。指标名、窗口语义与旧实现不同，历史排障经验不通用，见 [[BFF DAU实现#与旧实现的差异]]。

## Redis Key 设计

### 近似指标（`ccnubox_active_users_24h`）

| Key 类型 | 格式 | 示例 | TTL |
|----------|------|------|-----|
| 15 分钟桶 | `dau:{date}-{hour}-{minute}` | `dau:2024-01-15-14-30` | 48 小时（每次写入续期） |
| 合并临时值 | `active_users_24h:tmp:{hostname}:{pid}` | `active_users_24h:tmp:bff-7d9f-abc:1` | 1 小时 |

- 桶前缀仍是 `dau:`，属于改名时保留的旧命名，与指标名已不一致，按前缀检索时别被误导。
- 桶 TTL 从旧的 30 天（`30*24h+1h`）缩短到 48 小时：滚动窗口只需要 24 小时加余量，因此**无法再回溯某一天的指标值**，需要历史只能查明细集合。
- 临时 key 按进程隔离，多个 Pod 并发 `PFMERGE` 不会互相覆盖；Pod 重建后残留 key 1 小时内自然过期。

### 精确明细（`activity:daily:v2`）

| Key | 类型 | 格式 | TTL |
|-----|------|------|-----|
| 当日集合 | Set | `activity:daily:v2:{date}` | 日期 + 32 天（`EXPIREAT`） |
| 待落库意图 | Set | `activity:daily:v2:{date}:pending` | 同上 |
| 已受理计数 | String | `activity:daily:v2:{date}:accepted` | 同上 |
| 完成标记 | String | `activity:daily:v2:{date}:complete` | 同上（`EXAT`） |
| 采集起点 | String | `activity:daily:v2:started_at` | 无 |

- 日期按固定 `Asia/Shanghai`（`time.FixedZone`）切分，不受容器时区影响。
- 每个集合里有一个空串哨兵，用来区分"完整但 0 人活跃"和"key 丢失"；`SCARD` 恒等于"人数 + 1"。
- `started_at` 只写一次（`SET NX`），代表明细链路的上线时刻，是 `409/40804` 提示的"最早可用日期"的来源。

### Key 生成函数

```go
func ActiveUsersBucketKey(t time.Time) string {
    return activeUsersBucketPrefix + t.Local().Truncate(activeUsersBucketMinutes*time.Minute).Format("2006-01-02-15-04")
}

func ActiveUsersBucketTTL() time.Duration { return activeUsersBucketTTL } // 48h

func Day(t time.Time) time.Time  // 北京时间自然日零点
func Key(t time.Time) string     // activity:daily:v2:{date}
```

### 设计含义

- 15 分钟桶是唯一的统计源，滚动窗口靠"合并最近 96 个桶"实现，没有日聚合 key。
- 临时 key 只服务于单次 `Refresh`，不进任何报表。
- 明细集合是名单类业务的唯一权威来源，不接受"用指标反推名单"。

## 测试覆盖

### 滚动窗口

`bff/cron/active_users_test.go` 覆盖三个关键场景：

| 测试 | 验证点 |
|------|--------|
| `TestActiveUsers24hRefresherCountsRollingWindow` | 窗口是 `[前一天同刻, 当前整刻)`；当前未满桶和超过 24 小时的桶都被排除 |
| `TestActiveUsers24hRefresherCrossesMidnight` | 00:00 刷新不会清零，跨零点仍是完整 24 小时 |
| `TestActiveUsers24hRefresherKeepsLastValueOnRedisError` | Redis 报错时 Gauge 保留上一次成功值，不会被写成 0 |

窗口边界测试的形状：

```go
now := time.Date(2026, 6, 16, 10, 15, 0, 0, time.Local)

mr.PfAdd(ActiveUsersBucketKey(now.Add(-24*time.Hour)), "stu-1")
mr.PfAdd(ActiveUsersBucketKey(now.Add(-15*time.Minute)), "stu-1", "stu-2")
// 当前未满桶与超出窗口的桶都不该计入
mr.PfAdd(ActiveUsersBucketKey(now), "stu-current")
mr.PfAdd(ActiveUsersBucketKey(now.Add(-24*time.Hour-15*time.Minute)), "stu-old")

refresher.refreshAt(context.Background(), now) // 期望 gauge == 2
```

### 请求侧写入

`bff/web/middleware/prometheus_test.go` 中的 `TestPrometheusMiddlewareRecordsCurrentBucket` 验证：

- 同一桶内两个学号 → `PFCOUNT` 为 2；
- 桶 TTL 落在 `(24h, 48h]` 区间；
- **指标链路不写明细**：`activity:daily:v2:{date}` 必须不存在。这条断言保证了"估算"和"权威名单"不会互相污染。

### 明细准入

`bff/web/middleware/login_activity_test.go` 的 `TestAuthenticationRequiresDurableActivityAdmission` 验证 fail-closed 行为：

- Redis 报错时返回 503，业务 handler 一次都没执行；
- handler 执行前，该学号已经出现在 `:pending` 里（先登记后放行）；
- Redis 恢复后同一请求可以正常通过。

### 明细集合

`bff/service/activity/daily_test.go` 覆盖了最容易出错的地方：

- **时区**：`2026-10-18 16:00 UTC` 等于北京时间次日零点，按北京时间归档而不是宿主时区；
- **保留期**：`TTL == 32 天`；
- **采集起点**：`started_at` 首次写入后不再变化；
- **就绪判定**：`not_started` / `collecting` / `missing_dates` 三种原因及对应提示，`collecting` 要给出"最早可用日期"；
- **缺失日**：能列出具体缺失日期；
- **已知空日**：完整但 0 人活跃的日期算可用，不报缺失。

`bff/service/feed/whitelist_test.go` 与 `bff/web/feed/white_list_test.go` 从消费侧验证：窗口不足时 `Set("high_activity")` 返回 `activity.ErrNotReady`，HTTP 层映射为 `409` + 业务码 `40804`，msg 里包含缺失日期或最早可用日期。

## 监控与排障

### 重点观测项

- `ccnubox_active_users_24h`（每个 Pod 一条时间序列）
- `ccnubox_redis_errors_total{operation=~"PFADD|EXPIRE"}`：请求侧埋点
- `ccnubox_redis_errors_total{operation="PIPELINE"}`：15 分钟汇总的 `PFMERGE` / `PFCOUNT` / `EXPIRE` 走 `Pipeline`，只上报一次整体结果
- 定时任务日志：`active users 24h refresh ok`、`active users 24h refresh: count failed`、`daily activity heartbeat failed`、`daily activity initialization failed`
- HTTP 503 比例与 `活跃明细登记暂时不可用，请稍后重试` 日志

> [!warning] Lua 脚本不在 Redis 埋点覆盖范围内
> `activity.Record` / `EnsureDay` / `ReadDay` 全部走 `Eval`，而 `InstrumentedRedis` 没有包装 `Eval`。明细链路的 Redis 异常只能通过 503 比例、名单接口的 409/40804 和业务日志发现，指标上看不到。

### 建议告警

```promql
# 请求侧写桶失败
rate(ccnubox_redis_errors_total{operation=~"PFADD|EXPIRE"}[5m]) > 0

# 汇总任务连续失败（PIPELINE 是 refresh 的唯一 Redis 出入点）
rate(ccnubox_redis_errors_total{operation="PIPELINE"}[15m]) > 0

# 明细登记失败导致的 503（status 标签取 http.StatusText，值为 "Service Unavailable"）
rate(ccnubox_http_requests_total{status="Service Unavailable"}[5m]) > 0
```

### 排障路径

指标异常（不涨、归零、各 Pod 不一致）时按此顺序检查：

1. `ccnubox_active_users_24h` 是否长时间不动 → 任务是否注册成功，日志里有没有 `active users 24h refresh: register cron task failed`。
2. 当前 15 分钟 key `dau:{date}-{hh}-{mm}` 是否存在且在增长 → 请求侧埋点是否正常（`PFADD` 错误率）。
3. 把该时刻往前 96 个桶逐个 `EXISTS` → 是否因 Redis 淘汰或 TTL 误配导致缺桶（缺桶会让读数偏低）。
4. 各 Pod 的读数是否一致 → 不一致说明某个 Pod 的 cron 没跑或系统时钟漂移。
5. 汇总日志里的 `window_end` 与 `count` 是否与面板一致 → 确认是采集问题还是抓取问题。

明细侧异常（名单接口 409/40804）时：

1. `EXISTS activity:daily:v2:started_at`：不存在说明明细采集没上线（`not_started`）。
2. `SCARD activity:daily:v2:{date}:pending` 是否持续堆积 → `EnsureDay` 心跳没跑或落库失败。
3. `EXISTS activity:daily:v2:{date}:complete` 与 `SCARD activity:daily:v2:{date}` 是否满足 `SCARD == complete + 1`。
4. 直接读接口 msg：`HistoryNotReadyError` 会给出 `not_started` / `collecting` / `missing_dates` 和具体日期。

## 常见问题

### 为什么指标用 HyperLogLog，明细用 Set？

指标只需要基数，HyperLogLog 内存固定（16384 桶，标准误差约 0.81%），适合 96 个桶滚动合并。明细需要枚举学号并做"N 天里活跃 M 天"的交集统计，只能落 Set；人数上限由 `ReadDay` 的 10 万保护。

### 为什么窗口是滚动 24 小时而不是自然日？

自然日口径要么在零点让读数断崖式下跌，要么得等 00:05 定版才有确定值。滚动窗口的读数连续，曲线更适合看趋势和做告警基线。代价是不能直接当"今日 DAU"用。

### 为什么排除当前未满的 15 分钟桶？

半桶合并会让读数在每个 15 分钟周期里先降后升。固定用 96 个已满桶，代价是最多 15 分钟的滞后。

### 为什么不再需要分布式锁？

Gauge 是进程内变量，Prometheus 按 Pod 抓取，每个 Pod 都必须自己算一遍。旧实现加锁是因为只有抢到锁的 Pod 才会写共享的 `dau:latest`；现在合并成本很低（一次 pipeline 96 个 key），干脆每个 Pod 都算。

### 为什么 TTL 从 30 天缩到 48 小时？

滚动窗口只需要 24 小时的数据，48 小时留出跨时区/时钟抖动余量。副作用是无法再"补算"上周某天的指标值。

### BFF 重启后 Gauge 会归零吗？

正常不会：`InitCronxManager` 在注册 cron 前会同步跑一次 `Refresh`。但这次刷新是"尽力而为"——如果启动时 Redis 不可用，Gauge 会保持 0，直到 15 分钟后任务成功。旧实现有 `dau:latest` 兜底，新实现没有，这是刻意的简化。

### Redis 故障时会发生什么？

- 指标链路：`PFADD` 失败只丢一次近似计数，请求正常返回，Gauge 保留上一次成功值。
- 明细链路：`activity.Record` 失败会让请求直接返回 503，不会放进未登记的流量。
- 整体宕机：Redis 全挂时请求在更早的 `CheckSession` 就失败了（401），轮不到这两条链路。

指标与明细的失败策略不同是设计选择，不是遗漏；调整前需确认业务能接受"漏统计"还是"拒请求"。

### 名单接口返回 409 / 40804 是什么意思？

`activity.ErrNotReady` 的映射。说明要求的自然日窗口内还有日期没有完成采集：可能刚开始采集（`collecting`，msg 会给最早可用日期）、从未上线（`not_started`），或存在缺失日期（`missing_dates`）。这时不要用指标反推名单，也不要把缺失日当作空结果。

### 为什么 `dau:` 前缀还在，指标名却改了？

改名只动了指标定义和刷新器文件，桶前缀 `dau:` 保留了下来。检索 Redis key 时按 `dau:` 前缀找，检索指标时按 `ccnubox_active_users_24h` 找，两者名字已经对不上。

## 参考资料

- [Redis HyperLogLog](https://redis.io/docs/data-types/hyperloglog/)
- [Prometheus Gauge](https://prometheus.io/docs/concepts/metric_types/#gauge)
- [Redis EVAL / Lua 脚本](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
