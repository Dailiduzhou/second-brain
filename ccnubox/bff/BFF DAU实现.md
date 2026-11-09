---
category: ccnubox
type: deep-dive
topic: dau
module: bff
status: done
title: BFF DAU 实现
aliases:
  - DAU 统计机制
  - BFF DAU实现
  - 活跃用户指标实现
tags:
  - ccnubox
  - ccnubox/bff
  - ccnubox/dau
---
# DAU 统计实现

本文说明 `ccnubox-be` 中"日活"相关的两条链路：

- **近似指标**：Prometheus Gauge `ccnubox_active_users_24h`，统计滚动 24 小时窗口内的去重活跃学号；
- **精确明细**：Redis 集合 `activity:daily:v2:{date}`，按北京时间自然日保存去重学号，供名单类业务使用。

相关补充见：

- [[BFF DAU验证与运维]] — Redis key 设计、测试、监控与常见问题
- [[华师匣子用户活跃度统计]] — 按活跃度分档刷新数据（`tieredx`），是"活跃度如何影响调度"，与本文的统计口径不是一回事

> [!note] 源码版本
> 本文分析基于 submodule `source/ccnubox-be` 的 commit `a5d65f8`（`a5d65f8844014ad04eb35bafc401bf1513ee5b38`）。核心文件：`common/pkg/metricsx/user.go`、`bff/web/middleware/prometheus.go`、`bff/cron/active_users.go`、`bff/ioc/cron.go`、`bff/web/middleware/login.go`、`bff/service/activity/daily.go`。

> [!important] 指标口径已从"自然日 DAU"改为"滚动 24 小时活跃用户"
> commit `ef8b7708`（*refactor:重写日活指标*）删除了 `bff/cron/dau.go`，指标 `ccnubox_dau` 改名为 `ccnubox_active_users_24h`：窗口为最近 96 个**已满**的 15 分钟桶，不按零点重置。分布式锁、日聚合 key、`dau:latest` 兜底随之删除。新旧差异见 [与旧实现的差异](#与旧实现的差异)。

## 目标

这套实现需要满足以下约束：

1. 同一学号在同一统计窗口内只计一次，且窗口不能随零点"归零"造成读数跳变。
2. 请求侧只做常量级写入，不阻塞主链路。
3. 多 Pod 部署下每个 Pod 的 Gauge 都要更新（Prometheus 按 Pod 抓取），因此不能用分布式锁串行化。
4. BFF 重启后 Gauge 不能停在 0。
5. 需要精确学号明细的业务（名单类）不能依赖 HyperLogLog 估算值。

前四条由近似指标满足，第 5 条由独立的 `activity:daily:v2` 明细集合满足。

## 架构概览

```text
┌───────────────────────────────────────────────────────────────────┐
│请求侧（只写一个桶）                                               │
├───────────────────────────────────────────────────────────────────┤
│ HTTP Request ──► LoginMiddleware ──► activity.Record()            │
│                   （失败即 503，不放过未登记的请求）              │
│                         │                                         │
│                         ▼                                         │
│         activity:daily:v2:{date}:pending / accepted               │
│                                                                   │
│ 请求结束 ──► PrometheusMiddleware ──► recordActiveUser()          │
│                                           │                       │
│                                           ▼                       │
│                          Redis PFADD dau:{date}-{hh}-{mm}         │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│每 15 分钟汇总（每个 Pod 各自跑）                                  │
├───────────────────────────────────────────────────────────────────┤
│ Cron (*/15) ──► ActiveUsers24hRefresher.Refresh()                 │
│                         │                                         │
│                         ▼                                         │
│      PFMERGE 最近 96 个已满桶 → active_users_24h:tmp:{host}:{pid} │
│                         │                                         │
│                         ▼                                         │
│      PFCOUNT ──► Gauge.Set(count) ──► 日志 window_end/count       │
└───────────────────────────────────────────────────────────────────┘
```

### 设计要点

| 特性 | 实现方式 | 作用 |
|------|----------|------|
| 去重统计 | Redis HyperLogLog（`PFADD` / `PFMERGE` / `PFCOUNT`） | 内存固定，适合大规模去重 |
| 滚动窗口 | 每 15 分钟合并最近 96 个已满桶 | 读数不随零点跳变 |
| 请求侧开销 | 只 `PFADD` + `EXPIRE` 一个 key | 单次请求 O(1) 写入，不再逐请求 `PFCOUNT` |
| 多 Pod 一致性 | 每个 Pod 各自 `PFMERGE` 到自己的临时 key | 无需分布式锁，各实例 Gauge 都能更新 |
| 启动恢复 | `InitCronxManager` 中先同步跑一次 `Refresh` | 进程启动即有值，不依赖 Redis 兜底 key |
| 精确明细 | Lua 脚本维护 `activity:daily:v2:*` 集合 | 提供可枚举的学号，且拒绝伪造的"完整日" |

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `UserMetrics` | `common/pkg/metricsx/user.go` | 定义 `active_users_24h` Gauge |
| `PrometheusMiddleware` | `bff/web/middleware/prometheus.go` | 请求结束后写入当前 15 分钟桶 |
| `ActiveUsers24hRefresher` | `bff/cron/active_users.go` | 15 分钟合并窗口并刷新 Gauge |
| `registerActiveUsers24hRefreshTask` | `bff/ioc/cron.go` | 注册 cron 任务并做启动时首次刷新 |
| `activity.Record` / `EnsureDay` | `bff/service/activity/daily.go` | 维护精确的每日活跃学号集合 |
| `LoginMiddleware` | `bff/web/middleware/login.go` | 在放行请求前登记明细，失败即拒绝 |

`InitCronxManager` 的签名也相应变化：`redsync` 参数被移除（`ioc.InitCronxManager(logger, metrics, cmdable)`），因为汇总不再需要分布式锁。

## 指标定义

`common/pkg/metricsx/user.go` 定义无标签 Gauge：

```go
// UserMetrics 用户行为相关指标。
// ActiveUsers24h 是最近 96 个已完成的 15 分钟桶内的去重活跃用户数。
type UserMetrics struct {
    ActiveUsers24h prometheus.Gauge
}

func newUserMetrics(namespace string) *UserMetrics {
    return &UserMetrics{
        ActiveUsers24h: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: prometheus.BuildFQName(namespace, "", "active_users_24h"),
            Help: "Unique active users over the latest 96 completed 15-minute buckets (rolling 24 hours).",
        }),
    }
}
```

关键点：

- BFF 的 namespace 固定为 `ccnubox`（`bff/ioc/metrics.go`），最终指标名是 `ccnubox_active_users_24h`。
- 无标签：Gauge 是单值，由汇总任务写入，不再有"同一请求同时写指标和明细"的耦合。
- `bff/conf/conf.go` 与 `config-example.yaml` 里对应的配置项改名为 `activeUsers24h`，但那段 `PrometheusConf` 仍是注释状态，实际指标名由 `metricsx` 代码固定。

## 实时采集

`bff/web/middleware/prometheus.go` 在请求结束时异步写一个桶：

```go
defer func() {
    // Record authenticated users in the current 15-minute HLL bucket.
    uc, _ := ginx.GetClaims[ijwt.UserClaims](ctx)
    studentID := uc.StudentId
    if studentID != "" {
        go func(studentID string) {
            ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
            defer cancel()
            _ = m.recordActiveUser(ctx, studentID, start)
        }(studentID)
    }
    // ... ActiveConnections / RequestsTotal / Duration
}()
```

`recordActiveUser` 只负责一个桶：

```go
func (m *PrometheusMiddleware) recordActiveUser(ctx context.Context, studentID string, now time.Time) error {
    if studentID == "" {
        return nil
    }

    bucketKey := cron.ActiveUsersBucketKey(now)
    if err := m.redisClient.PFAdd(ctx, bucketKey, studentID).Err(); err != nil {
        return err
    }
    if err := m.redisClient.Expire(ctx, bucketKey, cron.ActiveUsersBucketTTL()).Err(); err != nil {
        return err
    }
    return nil
}
```

关键点：

- 时间基准是请求开始时间 `start`，不是 defer 时刻；跨桶边界的长请求会记在它开始的那个桶里。
- 写入是 best-effort：失败只丢一次近似计数，不影响响应。
- 只统计**已通过鉴权中间件**的请求。`PrometheusMiddleware` 注册在全局 `/api/v1` 组上，鉴权中间件在路由级，claims 为空即跳过；而鉴权失败或明细登记失败（503）的请求不会被计入。
- 与精确明细完全解耦：这里不碰 `activity:daily:v2:*`，`prometheus_test.go` 也显式断言了这一点。

## 15 分钟汇总

### 任务注册

`bff/ioc/cron.go` 注册每 15 分钟执行一次的汇总任务：

```go
const activeUsers24hCronSpec = "*/15 * * * *"

func registerActiveUsers24hRefreshTask(
    cronMgr *cronx.Manager,
    m *metricsx.Metrics,
    redisClient redis.Cmdable,
    l logger.Logger,
) {
    refresher := cron.NewActiveUsers24hRefresher(redisClient, m.User.ActiveUsers24h, l)
    refresher.Refresh(context.Background())

    if err := cronMgr.AddTask("active_users_24h_refresh", activeUsers24hCronSpec, func(ctx context.Context, log logger.Logger) {
        refresher.Refresh(ctx)
    }); err != nil {
        l.Warn("active users 24h refresh: register cron task failed", logger.Error(err))
    }
}
```

`refresher.Refresh(ctx)` 在注册前同步执行一次，这就是启动恢复：进程起来就带着正确的窗口值，不再需要 `dau:latest`。

### `ActiveUsers24hRefresher`

```go
const (
    activeUsersBucketMinutes = 15
    activeUsersWindowBuckets = 24 * 60 / activeUsersBucketMinutes
    activeUsersBucketTTL     = 48 * time.Hour
    activeUsersBucketPrefix  = "dau:"
)

type ActiveUsers24hRefresher struct {
    redis redis.Cmdable
    gauge prometheus.Gauge
    log   logger.Logger
    temp  string
}
```

构造函数的 temp 字段用 `hostname:pid` 生成进程级临时 key：

```go
func NewActiveUsers24hRefresher(r redis.Cmdable, g prometheus.Gauge, l logger.Logger) *ActiveUsers24hRefresher {
    hostname, err := os.Hostname()
    if err != nil || hostname == "" {
        hostname = "unknown"
    }
    return &ActiveUsers24hRefresher{
        redis: r,
        gauge: g,
        log:   l,
        temp:  fmt.Sprintf("active_users_24h:tmp:%s:%d", hostname, os.Getpid()),
    }
}
```

### `refreshAt`

```go
func (r *ActiveUsers24hRefresher) refreshAt(ctx context.Context, now time.Time) {
    windowEnd := now.Local().Truncate(activeUsersBucketMinutes * time.Minute)
    keys := make([]string, 0, activeUsersWindowBuckets)
    for i := 1; i <= activeUsersWindowBuckets; i++ {
        keys = append(keys, ActiveUsersBucketKey(windowEnd.Add(-time.Duration(i)*activeUsersBucketMinutes*time.Minute)))
    }

    pipe := r.redis.Pipeline()
    pipe.PFMerge(ctx, r.temp, keys...)
    countCmd := pipe.PFCount(ctx, r.temp)
    pipe.Expire(ctx, r.temp, time.Hour)
    if _, err := pipe.Exec(ctx); err != nil {
        r.log.Error("active users 24h refresh: count failed", logger.Error(err))
        return
    }

    count := countCmd.Val()
    r.gauge.Set(float64(count))
    r.log.Info("active users 24h refresh ok",
        logger.String("window_end", windowEnd.Format(time.RFC3339)),
        logger.Int64("count", count))
}
```

关键点：

- `i` 从 1 开始，窗口是 `[windowEnd-24h, windowEnd)`：**当前未满的桶不参与统计**，避免半桶造成读数下滑又反弹。
- 合并源是 96 个桶，不再有"日聚合 key + 96 桶"的双写。
- 临时 key 按 `hostname:pid` 隔离，TTL 1 小时；即使 Pod 被重建，残留 key 也会自然过期。
- Redis 出错时直接 `return`，Gauge 保留上一次成功值，不会被写成 0。
- 每个 Pod 都跑这份逻辑。若沿用旧实现的 `redsync` 锁，只有抢到锁的 Pod 会更新自己的 Gauge，其余 Pod 永远停在旧值——代码注释明确写了这一点。

## 精确日活明细

近似指标给不了学号，名单类业务（按"N 天内有 M 天活跃"筛选推送对象）需要精确集合，这条链路单独维护。

### Key 与保留期

| Key | 类型 | 含义 |
|-----|------|------|
| `activity:daily:v2:{date}` | Set | 该自然日已入集合的学号（含一个空串哨兵） |
| `activity:daily:v2:{date}:pending` | Set | 已登记意图、尚未落库的学号 |
| `activity:daily:v2:{date}:accepted` | String(int) | 已受理的唯一学号数 |
| `activity:daily:v2:{date}:complete` | String | 该日已完成封账的计数（`EXAT` 过期） |
| `activity:daily:v2:started_at` | String | 明细采集起点（Unix 秒），用于判断历史是否可用 |

- 时区固定为 `time.FixedZone("Asia/Shanghai", 8*3600)`，不依赖容器 tzdata。
- 保留期 `RetentionDays = 32`，用 `EXPIREAT` 写在"日期 + 32 天"上。
- 正式集合里的空串哨兵让"0 人活跃的完整日"区别于"key 不存在"。

### 准入在鉴权中间件里

```go
if uc.StudentId != "" {
    recordCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    err := activity.Record(recordCtx, m.redis, uc.StudentId, m.now())
    cancel()
    if err != nil {
        const message = "活跃明细登记暂时不可用，请稍后重试"
        ctx.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
            "code": errs.INTERNAL_SERVER_ERROR_CODE, "msg": message, "data": nil,
        })
        return
    }
}
```

> [!warning] 明细链路是 fail-closed 的
> 指标链路失败只丢一个近似计数，明细链路失败会直接把请求挡成 503。原因是"漏记一个已放行的请求"无法事后补，而"多拒一次请求"可以重试。改动这段逻辑前先确认业务能接受哪种失败。

`Record` 用一段 Lua 脚本保证原子性：

```lua
if redis.call('EXISTS', KEYS[5]) == 1 then return -1 end
local count = redis.call('GET', KEYS[4])
local members = redis.call('SCARD', KEYS[2])
local pending = redis.call('SCARD', KEYS[3])
if count then
    if members == 0 or members + pending ~= tonumber(count) + 1 then
        return redis.error_reply('activity membership or pending intents lost')
    end
else
    -- 首次初始化：校验成员数与待落库计数都为 0，再写计数并种下空串哨兵
    redis.call('SET', KEYS[4], 0)
    redis.call('SADD', KEYS[2], '')
end
redis.call('SET', KEYS[1], ARGV[2], 'NX')
if ARGV[1] ~= '' and redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then
    if redis.call('SADD', KEYS[3], ARGV[1]) == 1 then
        redis.call('INCR', KEYS[4])
    end
end
```

关键点：

- `members + pending == count + 1` 是自检式不变量（`+1` 是空串哨兵）。集合被误删时直接报错，而不是悄悄把当天当作"0 人活跃"。
- 已封账的日期（`:complete` 存在）返回 `ErrDayClosed`，迟到写入不会被计入。
- 登记只写 pending，由 `EnsureDay` 分批搬到正式集合，worker 挂掉也不会丢掉意图。

### 落库与就绪判断

`EnsureDay` 由两条 cron 触发：`InitCronxManager` 启动时跑一次，之后 `daily_activity_heartbeat` 每分钟跑一次（`* * * * *`），每次回放最近 32 天：

- 对每一天循环执行 `flushScript`，每次 `SRANDMEMBER 512` 条，直到 pending 清空；
- 只有 pending 归零且当天已结束（`closed = 1`）时，才写 `:complete = count`，即"这一天确实完整"；
- 出错按天聚合返回 `errors.Join`，不阻塞其它日期；
- 成本上，即使所有日期都是空的，每分钟也会做 32 次以上 `Eval`（外加一次登记），这是"迟到写入永不丢"付的固定开销，与 QPS 无关。

读取侧有两道闸：

- `CheckWindow(ctx, r, start, days)`：先看 `started_at`，再逐日比对 `:complete` 与集合大小，返回带原因的 `HistoryNotReadyError`（`not_started` / `collecting` / `missing_dates`）。
- `ReadDay(ctx, r, day)`：一次 Lua 里校验完成计数并快照 `SMEMBERS`，避免"校验通过后集合被删掉一半"的情况；超过 10 万人的单日集合直接报错。

`bff/service/feed/whitelist.go` 的 `activeUsers` 就是这套 API 的消费者（默认窗口 7 天、最少 5 天活跃），错误会转成 HTTP 409 + 业务码 `40804`，并把"从哪天开始采集、最早哪天可用"写进 msg。

## 数据流摘要

一次已认证请求：

```text
HTTP request
  -> PrometheusMiddleware（开始计时）
  -> LoginMiddleware
       -> activity.Record：写 pending、accepted；失败则 503
  -> 业务 handler
  -> defer：PFADD dau:{date}-{hh}-{mm} + EXPIRE 48h
```

每 15 分钟（每个 Pod）：

```text
Cron active_users_24h_refresh
  -> 取 windowEnd = now 向下取整到 15 分钟
  -> PFMERGE 最近 96 个已满桶 → active_users_24h:tmp:{host}:{pid}
  -> PFCOUNT
  -> Gauge.Set(count)
  -> 日志 active users 24h refresh ok
```

每分钟（每 Pod）：

```text
Cron daily_activity_heartbeat
  -> EnsureDay：把最近 32 天的 pending 分批搬进正式集合
  -> 已结束且 pending 归零的日期写 :complete
```

## 与旧实现的差异

| 维度 | 旧实现（`afcc2ad` 及以前） | 现实现（`a5d65f8`） |
|------|--------------------------|---------------------|
| 指标名 | `ccnubox_dau` | `ccnubox_active_users_24h` |
| 统计窗口 | 自然日（白天随请求跳动，00:05 定版） | 最近 96 个已满 15 分钟桶（滚动 24 小时） |
| 请求侧 | 写 15 分钟桶 + 日聚合 key，并 `PFCOUNT` 后 `Gauge.Set` | 只写当前 15 分钟桶，不读 Gauge |
| 汇总任务 | 每天 `5 0 * * *`，合并日 key + 96 桶 | 每 `*/15 * * * *`，合并 96 桶 |
| 分布式锁 | `redsync` 锁 `dau:daily:lock` | 无锁，每 Pod 各刷自己的 Gauge |
| 启动恢复 | `Bootstrap` 读 `dau:latest` | 注册任务前同步执行一次 `Refresh` |
| 临时 key | 共享 `dau:tmp:{date}`，TTL 60s | `active_users_24h:tmp:{host}:{pid}`，TTL 1h |
| 桶 TTL | `30*24h+1h` | 48 小时 |
| 精确学号 | 无 | `activity:daily:v2:*`，32 天，fail-closed 准入 |

> [!warning] 迁移期的读图口径
> 新旧指标名不同，`ccnubox_dau` 的历史曲线不能与新指标直接拼成一条线：旧值白天是"当天累计去重数"（每次请求 `PFCOUNT` 后覆盖），00:05 后被"昨天定版值"覆盖，语义本身就不稳定；新值是固定的"过去 24 小时去重数"，天然高于单日值，且不再有定版时刻。告警和报表口径需要同步改。

## 设计结论

- 指标与明细彻底分流：Gauge 服务监控面板，集合服务名单业务，各自失败互不影响。
- 请求路径只保留一次 `PFADD`，把开销从"两次写 + 一次读"压到"一次写"。
- 15 分钟滚动窗口消除了零点跳变，代价是没法直接读出"自然日 DAU"；需要自然日数据时只能走明细集合。
- 去锁的前提是"每个 Pod 各自持有 Gauge"，这一点依赖 Prometheus 按 Pod 抓取；若将来改成汇总型 exporter，锁和共享临时 key 需要重新评估。
- `activity:daily:v2` 的设计重心是**拒绝不可信的历史**：宁可返回 409 让业务重试，也不把"缺数据的日期"当成"0 人活跃"。
