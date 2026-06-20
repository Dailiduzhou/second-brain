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

本文档补充 [[BFF DAU实现]]，聚焦 DAU 方案的 Redis key 设计、测试覆盖、监控要点和常见排障问题。

## Redis Key 设计

### Key 命名规则

| Key 类型 | 格式 | 示例 | TTL |
|----------|------|------|-----|
| 15 分钟桶 | `dau:{date}-{hour}-{minute}` | `dau:2024-01-15-14-30` | 31 天 |
| 日聚合 | `dau:day:{date}` | `dau:day:2024-01-15` | 31 天 |
| 临时合并 | `dau:tmp:{date}` | `dau:tmp:2024-01-15` | 60 秒 |
| 最新值 | `dau:latest` | - | 7 天 |
| 分布式锁 | `dau:daily:lock` | - | 2 分钟 |

### Key 生成函数

```go
func DAUBucketKey(t time.Time) string {
    return "dau:" + t.Local().Truncate(dauBucketMin*time.Minute).Format("2006-01-02-15-04")
}

func DAUDayKey(date string) string {
    return dauDayPrefix + date
}

func DAUDayKeyForTime(t time.Time) string {
    return DAUDayKey(t.Local().Format("2006-01-02"))
}
```

### 设计含义

- 15 分钟桶用于回溯某一天的完整活跃轨迹。
- 日聚合 key 用于请求侧快速读取当天 DAU。
- 临时合并 key 只服务于 `Refresh`。
- `dau:latest` 只用于 Gauge 启动恢复。

## 测试覆盖

### 实时采集测试

`bff/web/middleware/prometheus_test.go` 验证 `recordDAU` 会正确写 Redis 并更新 Gauge：

```go
func TestPrometheusMiddlewareRecordDAUUpdatesGauge(t *testing.T) {
    mr, err := miniredis.Run()
    if err != nil {
        t.Fatalf("start miniredis: %v", err)
    }
    t.Cleanup(mr.Close)

    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    t.Cleanup(func() { _ = client.Close() })

    metrics := metricsx.NewWithRegisterer(prometheus.NewRegistry(), "test")
    middleware := NewPrometheusMiddleware(metrics, client)
    now := time.Date(2026, 6, 16, 10, 7, 0, 0, time.Local)

    if err := middleware.recordDAU(context.Background(), "stu-1", now); err != nil {
        t.Fatalf("record first dau: %v", err)
    }
    if err := middleware.recordDAU(context.Background(), "stu-2", now.Add(time.Minute)); err != nil {
        t.Fatalf("record second dau: %v", err)
    }

    if got := testutil.ToFloat64(metrics.User.DAU); got != 2 {
        t.Fatalf("gauge got %v, want 2", got)
    }

    dayCount, err := client.PFCount(context.Background(), cron.DAUDayKeyForTime(now)).Result()
    if err != nil {
        t.Fatalf("count day key: %v", err)
    }
    if dayCount != 2 {
        t.Fatalf("day key count got %d, want 2", dayCount)
    }
}
```

验证重点：

- 同一天内不同学号能正确去重计数。
- 请求侧写入日聚合 key 后，Gauge 会同步更新。

### 定时刷新测试

`bff/cron/dau_test.go` 验证 `Refresh` 能正确合并桶、写入 Gauge 和 Redis 兜底值：

```go
func TestDAURefresher_Refresh_Ok(t *testing.T) {
    mr, client := newTestRedis(t)
    rs := newTestRedsync(client)
    gauge := newTestGauge()
    d := NewDAURefresher(client, gauge, rs, nopLogger{})

    yesterday := time.Now().Local().AddDate(0, 0, -1).Format("2006-01-02")
    for i, b := range []string{"00-00", "12-30", "23-45"} {
        mr.PfAdd(fmt.Sprintf("dau:%s-%s", yesterday, b), fmt.Sprintf("stu-%d", i))
    }

    d.Refresh(context.Background())

    if v := readGauge(t, gauge); v != 3 {
        t.Errorf("gauge: got %v, want 3", v)
    }

    v, err := client.Get(context.Background(), dauLatestKey).Int64()
    if err != nil {
        t.Fatalf("read dau:latest: %v", err)
    }
    if v != 3 {
        t.Errorf("dau:latest: got %d, want 3", v)
    }
}
```

额外场景还包括：

- 同时合并日聚合 key 和 15 分钟桶。
- 空日期时保持 Gauge 为 0。

### 启动恢复测试

`Bootstrap` 测试验证 BFF 重启后 Gauge 能从 Redis 恢复：

```go
func TestDAURefresher_Bootstrap_Ok(t *testing.T) {
    mr, client := newTestRedis(t)
    rs := newTestRedsync(client)
    gauge := newTestGauge()
    d := NewDAURefresher(client, gauge, rs, nopLogger{})

    mr.Set(dauLatestKey, "456")

    d.Bootstrap(context.Background())

    if v := readGauge(t, gauge); v != 456 {
        t.Errorf("gauge: got %v, want 456", v)
    }
}
```

## 监控与排障

### 重点观测项

- `ccnubox_dau`
- `ccnubox_redis_errors_total{operation=~"PFADD|EXPIRE|PFCOUNT"}`
- 定时任务执行日志：`dau refresh ok` / `dau refresh: count failed`
- 启动恢复日志：`dau bootstrap ok` / `dau bootstrap: read latest failed`

### 建议告警

```promql
rate(ccnubox_redis_errors_total{operation=~"PFADD|EXPIRE"}[5m]) > 0
```

### 排障路径

当 DAU 异常波动时，优先按以下顺序检查：

1. `ccnubox_dau` 是否突然归零或长时间不变。
2. `dau:latest` 是否存在，值是否合理。
3. 当天 `dau:day:{date}` 是否持续增长。
4. 对应日期的 15 分钟桶是否正常写入。
5. `dau_refresh` 定时任务是否按 00:05 执行且成功拿到锁。

## 常见问题

### 为什么使用 HyperLogLog 而不是 Set？

HyperLogLog 内存占用固定且很低，适合每天去重用户数统计。Set 的内存占用会随用户量线性增长。

### 为什么要双写 15 分钟桶和日聚合 key？

- 15 分钟桶提供回溯能力，方便定时任务做最终一致性汇总。
- 日聚合 key 提供实时查询能力，避免请求侧每次都合并 96 个桶。

### 为什么定时任务在 00:05 执行？

给跨天边界预留缓冲时间，降低因为延迟请求或时钟抖动导致的漏记风险。

### 多 Pod 部署时如何防止重复计算？

通过 redsync 分布式锁保证同一时间只有一个 Pod 执行 `Refresh`。

### BFF 重启后 Gauge 会归零吗？

正常不会。`Bootstrap` 会从 `dau:latest` 恢复最近一次写入值。

### Redis 故障时会发生什么？

- 实时采集可能失败，Gauge 保持上一次成功值。
- 定时刷新可能失败，导致当天最终值未更新。
- 应通过 Redis 错误指标和 cron 日志联动排查。

## 参考资料

- [Redis HyperLogLog](https://redis.io/docs/data-types/hyperloglog/)
- [Prometheus Gauge](https://prometheus.io/docs/concepts/metric_types/#gauge)
- [redsync 分布式锁](https://github.com/go-redsync/redsync)
