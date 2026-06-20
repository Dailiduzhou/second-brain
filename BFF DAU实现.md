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
tags:
  - ccnubox
  - ccnubox/bff
  - ccnubox/dau
---
# DAU 统计实现

本文档说明 `ccnubox-be` 中 DAU（日活跃用户）的实现方案，覆盖指标定义、实时采集、定时刷新和启动恢复四个核心环节。

相关补充见：

- [[BFF DAU验证与运维]] — Redis key 设计、测试、监控与常见问题

## 目标

这套实现需要满足以下约束：

1. 对同一学号按天去重统计。
2. 请求侧更新尽量轻量，不阻塞主链路。
3. 多 Pod 部署下只能有一个实例执行日终汇总。
4. BFF 重启后 Prometheus Gauge 不能回到 0。

## 架构概览

项目采用 **Redis HyperLogLog + Prometheus Gauge** 的两层架构统计 DAU：

```text
┌─────────────────────────────────────────────────────────────────┐
│                         BFF 请求流程                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  HTTP Request ──► PrometheusMiddleware ──► recordDAU()          │
│                                              │                  │
│                                              ▼                  │
│                                    ┌─────────────────┐          │
│                                    │  Redis PFADD    │          │
│                                    │  (15min桶+日key) │          │
│                                    └────────┬────────┘          │
│                                             │                   │
│                                             ▼                   │
│                                    ┌─────────────────┐          │
│                                    │  Redis PFCOUNT  │          │
│                                    │  (实时计算DAU)   │          │
│                                    └────────┬────────┘          │
│                                             │                   │
│                                             ▼                   │
│                                    ┌─────────────────┐          │
│                                    │  Gauge.Set()    │          │
│                                    │  (更新Prometheus)│          │
│                                    └─────────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         定时刷新流程                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Cron (00:05) ──► DAURefresher.Refresh()                       │
│                          │                                      │
│                          ▼                                      │
│                ┌───────────────────┐                            │
│                │  获取分布式锁      │                            │
│                │  (redsync)        │                            │
│                └─────────┬─────────┘                            │
│                          │                                      │
│                          ▼                                      │
│                ┌───────────────────┐                            │
│                │  PFMERGE 96个桶   │                            │
│                │  + 日聚合key      │                            │
│                └─────────┬─────────┘                            │
│                          │                                      │
│                          ▼                                      │
│                ┌───────────────────┐                            │
│                │  PFCOUNT 计算总数  │                            │
│                └─────────┬─────────┘                            │
│                          │                                      │
│                          ▼                                      │
│                ┌───────────────────┐                            │
│                │  Gauge.Set()      │                            │
│                │  + 写入Redis兜底   │                            │
│                └───────────────────┘                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 设计要点

| 特性 | 实现方式 | 作用 |
|------|----------|------|
| 去重统计 | Redis HyperLogLog (`PFADD` / `PFCOUNT`) | 内存固定且适合大规模去重 |
| 实时性 | 每次请求后异步更新 | Gauge 反映当天实时 DAU |
| 准确性 | 每天 00:05 定时合并所有桶 | 修正可能的遗漏 |
| 容错性 | Redis `dau:latest` 兜底 | 防止重启后 Gauge 归零 |
| 分布式安全 | redsync 分布式锁 | 防止多 Pod 重复计算 |

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `UserMetrics` | `common/pkg/metricsx/user.go` | 定义 DAU Gauge |
| `Metrics` | `common/pkg/metricsx/metrics.go` | 注册所有 Prometheus 指标 |
| `PrometheusMiddleware` | `bff/web/middleware/prometheus.go` | 实时采集 DAU |
| `DAURefresher` | `bff/cron/dau.go` | 定时刷新与启动恢复 |
| `registerDAURefreshTask` | `bff/ioc/cron.go` | 注册定时任务 |

## 指标定义与注册

### 定义 Gauge

`common/pkg/metricsx/user.go` 定义无标签 Gauge：

```go
package metricsx

import "github.com/prometheus/client_golang/prometheus"

// UserMetrics 用户行为相关指标
// DAU 是一个无标签 Gauge, 由 cron 任务在每天 00:05 写入"昨天"的最终值
type UserMetrics struct {
    DAU prometheus.Gauge
}

func newUserMetrics(namespace string) *UserMetrics {
    return &UserMetrics{
        DAU: prometheus.NewGauge(prometheus.GaugeOpts{
            Name: prometheus.BuildFQName(namespace, "", "dau"),
            Help: "Daily active users (unique StudentId per day, finalized at 00:05 local).",
        }),
    }
}
```

关键点：

- 指标名最终为 `{namespace}_dau`
- DAU 是全局值，不按标签拆分

### 注册到 Prometheus

`common/pkg/metricsx/metrics.go` 统一注册所有指标：

```go
func NewWithRegisterer(reg prometheus.Registerer, namespace string) *Metrics {
    m := &Metrics{
        HTTP:      newHTTPMetrics(namespace),
        Redis:     newRedisMetrics(namespace),
        MQMetrics: newMQMetrics(namespace),
        User:      newUserMetrics(namespace),
    }

    m.User.DAU = registerVec(reg, m.User.DAU)
    return m
}

func registerVec[T prometheus.Collector](reg prometheus.Registerer, c T) T {
    if err := reg.Register(c); err != nil {
        var alreadyRegistered prometheus.AlreadyRegisteredError
        if errors.As(err, &alreadyRegistered) {
            if existing, ok := alreadyRegistered.ExistingCollector.(T); ok {
                return existing
            }
        }
        panic(err)
    }
    return c
}
```

关键点：

- 通过泛型保留 collector 的具体类型
- 避免重复注册导致 panic

## 实时采集

### 中间件入口

`bff/web/middleware/prometheus.go` 在每个请求完成后异步记录 DAU：

```go
func (m *PrometheusMiddleware) MiddlewareFunc() gin.HandlerFunc {
    return func(ctx *gin.Context) {
        start := time.Now()

        path := ctx.FullPath()
        if path == "" {
            path = "not found"
        }
        m.metrics.HTTP.ActiveConnections.WithLabelValues(path).Inc()

        defer func() {
            uc, _ := ginx.GetClaims[ijwt.UserClaims](ctx)
            studentId := uc.StudentId
            if studentId != "" {
                go func(studentId string) {
                    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
                    defer cancel()
                    _ = m.recordDAU(ctx, studentId, time.Now())
                }(studentId)
            }

            status := ctx.Writer.Status()
            m.metrics.HTTP.ActiveConnections.WithLabelValues(path).Dec()
            m.metrics.HTTP.RequestsTotal.WithLabelValues(ctx.Request.Method, path, http.StatusText(status)).Inc()
            m.metrics.HTTP.Duration.WithLabelValues(path, http.StatusText(status)).Observe(time.Since(start).Seconds())
        }()

        ctx.Next()
    }
}
```

关键点：

- 只统计已认证请求
- 通过 goroutine 降低对响应延迟的影响
- Redis 操作设置 3 秒超时

### `recordDAU` 实现

```go
func (m *PrometheusMiddleware) recordDAU(ctx context.Context, studentId string, now time.Time) error {
    if studentId == "" {
        return nil
    }

    bucketKey := cron.DAUBucketKey(now)
    dayKey := cron.DAUDayKeyForTime(now)
    ttl := 30*24*time.Hour + time.Hour

    if err := m.redisClient.PFAdd(ctx, bucketKey, studentId).Err(); err != nil {
        return err
    }
    if err := m.redisClient.Expire(ctx, bucketKey, ttl).Err(); err != nil {
        return err
    }

    if err := m.redisClient.PFAdd(ctx, dayKey, studentId).Err(); err != nil {
        return err
    }

    count, err := m.redisClient.PFCount(ctx, dayKey).Result()
    if err != nil {
        return err
    }
    if err := m.redisClient.Expire(ctx, dayKey, ttl).Err(); err != nil {
        return err
    }

    m.metrics.User.DAU.Set(float64(count))
    return nil
}
```

关键点：

- 同时写入 15 分钟桶和日聚合 key
- 日聚合 key 用于实时读数
- 15 分钟桶用于日终回溯合并

## 定时刷新任务

### 任务注册

`bff/ioc/cron.go` 注册每天 `00:05` 执行的刷新任务：

```go
const dauCronSpec = "5 0 * * *"

func registerDAURefreshTask(
    cronMgr *cronx.Manager,
    m *metricsx.Metrics,
    redisClient redis.Cmdable,
    rs *redsync.Redsync,
    l logger.Logger,
) {
    refresher := cron.NewDAURefresher(redisClient, m.User.DAU, rs, l)
    refresher.Bootstrap(context.Background())

    if err := cronMgr.AddTask("dau_refresh", dauCronSpec, func(ctx context.Context, log logger.Logger) {
        refresher.Refresh(ctx)
    }); err != nil {
        l.Warn("dau refresh: register cron task failed", logger.Error(err))
    }
}
```

### `DAURefresher` 结构

```go
const (
    dauLockKey   = "dau:daily:lock"
    dauLatestKey = "dau:latest"
    dauBucketMin = 15
    dauDayPrefix = "dau:day:"
)

type DAURefresher struct {
    redis redis.Cmdable
    gauge prometheus.Gauge
    rs    *redsync.Redsync
    log   logger.Logger
}

func NewDAURefresher(r redis.Cmdable, g prometheus.Gauge, rs *redsync.Redsync, l logger.Logger) *DAURefresher {
    return &DAURefresher{redis: r, gauge: g, rs: rs, log: l}
}
```

### `Refresh` 实现

```go
func (d *DAURefresher) Refresh(ctx context.Context) {
    mu := d.rs.NewMutex(dauLockKey, redsync.WithExpiry(2*time.Minute))
    if err := mu.LockContext(ctx); err != nil {
        d.log.Warn("dau refresh: acquire lock failed", logger.Error(err))
        return
    }
    defer func() {
        if _, err := mu.UnlockContext(ctx); err != nil {
            d.log.Warn("dau refresh: release lock failed", logger.Error(err))
        }
    }()

    yesterday := time.Now().Local().AddDate(0, 0, -1).Format("2006-01-02")
    count, err := d.countDay(ctx, yesterday)
    if err != nil {
        d.log.Error("dau refresh: count failed",
            logger.String("date", yesterday), logger.Error(err))
        return
    }

    d.gauge.Set(float64(count))
    d.log.Info("dau refresh ok",
        logger.String("date", yesterday), logger.Int64("count", count))

    if err := d.redis.Set(ctx, dauLatestKey, count, 7*24*time.Hour).Err(); err != nil {
        d.log.Warn("dau refresh: write latest failed", logger.Error(err))
    }
}
```

### `countDay` 实现

```go
func (d *DAURefresher) countDay(ctx context.Context, date string) (int64, error) {
    tempKey := "dau:tmp:" + date

    srcKeys := make([]string, 0, 1+24*60/dauBucketMin)
    srcKeys = append(srcKeys, DAUDayKey(date))
    for h := 0; h < 24; h++ {
        for m := 0; m < 60; m += dauBucketMin {
            srcKeys = append(srcKeys, fmt.Sprintf("dau:%s-%02d-%02d", date, h, m))
        }
    }

    pipe := d.redis.Pipeline()
    pipe.PFMerge(ctx, tempKey, srcKeys...)
    pfcountCmd := pipe.PFCount(ctx, tempKey)
    pipe.Expire(ctx, tempKey, 60*time.Second)

    if _, err := pipe.Exec(ctx); err != nil {
        return 0, err
    }
    return pfcountCmd.Val(), nil
}
```

关键点：

- 通过分布式锁保证多 Pod 下只计算一次
- 汇总时同时合并日聚合 key 与 96 个时间桶
- 临时 key 设置短 TTL，避免残留

## 启动恢复机制

### `Bootstrap` 实现

`bff/cron/dau.go` 在 BFF 启动时恢复最近一次成功值：

```go
func (d *DAURefresher) Bootstrap(ctx context.Context) {
    v, err := d.redis.Get(ctx, dauLatestKey).Int64()
    if err != nil {
        if errors.Is(err, redis.Nil) {
            d.log.Info("dau bootstrap: no previous value")
        } else {
            d.log.Warn("dau bootstrap: read latest failed", logger.Error(err))
        }
        return
    }
    d.gauge.Set(float64(v))
    d.log.Info("dau bootstrap ok", logger.Int64("count", v))
}
```

## 数据流摘要

一次已认证请求的数据流如下：

```text
HTTP request
  -> PrometheusMiddleware
  -> 解析 JWT 拿到 studentId
  -> PFADD 写入 15 分钟桶
  -> PFADD 写入日聚合 key
  -> PFCOUNT 读取当天去重值
  -> Gauge.Set(count)
```

每天 00:05 的汇总流如下：

```text
Cron trigger
  -> redsync 分布式锁
  -> 合并昨天的日 key + 96 个 15 分钟桶
  -> PFCOUNT 计算最终值
  -> Gauge.Set(count)
  -> SET dau:latest 作为重启兜底
```

## 设计结论

- 请求路径强调低开销与实时反馈。
- 定时任务负责做最终一致性修正。
- Redis HyperLogLog 是权威统计源，Gauge 是展示层状态。
- 在分布式部署下，`Refresh` 是唯一的日终定版动作。
