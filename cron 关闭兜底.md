---
category: ccnubox
type: deep-dive
topic: cron
frameworks:
  - robfig/cron
  - go-kratos
module: common
status: seedling
title: cron 关闭兜底
aliases:
  - cron 停机兜底
  - cron 优雅停机
  - cron 生命周期管理
tags:
  - ccnubox
  - ccnubox/common
  - ccnubox/common/cron
  - programming-language/go/cron
  - programming-language/go/graceful-shutdown
  - microservice/go-kratos
---

# cron 关闭兜底

本文档说明 `ccnubox-be` 中 robfig/cron 的关闭模式、当前各服务的不一致现状，以及把 cron 接入 [[go-kratos架构|go-kratos]] 优雅停机链路的统一做法。

> 适用项目：[[华师匣子]]
> 相关文档：[[定时任务实现]] · [[robfig cron 的使用]] · [[整体代理(proxy)使用]]

## 目标

- 说明 robfig/cron 关闭的**正确姿势**（`Stop()` + 等待 `doneCtx`）。
- 梳理 `be-class` / `be-proxy` / `bff` / `be-classlist` / `common/bizpkg/proxy` 五处实现的差异。
- 给出一个**统一**的 `Close(ctx)` 包装 + Kratos 接入示例，作为后续重构的参考实现。

## 为什么 cron 需要显式停机

`cron.Cron` 在 `Start()` 后会派生一个**调度 goroutine**，并把任务分发到独立的 worker goroutine：

- `Start()` 之后**不会**在进程退出时自动清理，依赖外部显式调用 `Stop()`。
- `Stop()` 只**阻止新任务触发**，**不会**中断已经启动的 goroutine；它返回一个 `doneCtx`，所有 in-flight 任务结束后才会 close。
- 如果直接 `os.Exit` / `SIGKILL` / `panic`，in-flight 任务可能被截断，触发以下问题：
  - 任务体写到一半的副作用（半条 SQL、半条 Kafka 消息）。
  - 没有 `defer` 释放的资源（文件句柄、Redis 连接）。
  - 进程退出日志缺失 `cron stopped` 之类的收尾记录，排障时无法判断任务是否执行过。

> [!warning]
> `cron.Stop()` **不会**中断正在执行的 goroutine。
> 真正的兜底是：**调用 `Stop()` → 等 `doneCtx` → 再退出进程**。[[定时任务实现]] 中 `cronx.Manager.Stop` 就是按这个模式实现的。

## 关闭模式

### 1. 原生 `cron.Cron` 关闭

参考 [[robfig cron 的使用#动态管理]]：

```go
doneCtx := c.Stop()
select {
case <-doneCtx.Done():
    log.Info("cron stopped")
case <-ctx.Done():
    log.Warn("cron stop aborted", logger.String("reason", ctx.Err().Error()))
}
```

### 2. `cronx.Manager` 关闭（项目内首选）

[[定时任务实现]] 已经在 `common/pkg/cronx` 里把这层封装做掉了。调用方只需一行：

```go
if err := cronMgr.Stop(ctx); err != nil {
    l.Warn("cron stop failed", logger.Error(err))
}
```

> 只要任务注册走 `cronx.Manager.AddTask`，停机就**自动正确**。这条线是项目内最干净的实现。

### 3. 直接持有 `*cron.Cron`（推荐统一为 `Close(ctx)`）

在持有 `*cron.Cron` 字段的结构体上暴露 `Close(ctx context.Context) error`，由 `wire` 注入到 Kratos 的停机链路：

```go
type HttpProxy struct {
    Addr       string
    AddrBackup string

    direct bool
    mu     sync.RWMutex
    p      proxyv1.ProxyClient
    l      logger.Logger

    cron *cron.Cron // 持有调度器，便于停机
}

// Close 优雅停机：阻止新任务触发并等待 in-flight 任务结束。
// 适用场景：与 Kratos server 关闭链路对接。
func (s *HttpProxy) Close(ctx context.Context) error {
    if s.cron == nil {
        return nil
    }

    doneCtx := s.cron.Stop()

    select {
    case <-doneCtx.Done():
        if s.l != nil {
            s.l.Info("http proxy cron stopped")
        }
        return nil
    case <-ctx.Done():
        if s.l != nil {
            s.l.Warn("http proxy cron stop aborted",
                logger.String("reason", ctx.Err().Error()))
        }
        return ctx.Err()
    }
}
```

`NewHttpProxy` 同步保留 cron 字段：

```go
func NewHttpProxy(p proxyv1.ProxyClient, l logger.Logger) Client {
    globalProxy = &HttpProxy{p: p, l: l}

    globalProxy.update()
    c := cron.New()
    _, _ = c.AddFunc("@every 15s", globalProxy.update)
    c.Start()
    globalProxy.cron = c // 关键：把 cron 引用保存到结构体，停机时才能 Stop

    return globalProxy
}
```

> [!tip]
> 关键点是把 `*cron.Cron` **保存到结构体字段**。
> 原实现里 `c := cron.New(); c.Start()` 之后 `c` 立刻被丢弃，停机时拿不到引用，所以只能靠 OS 信号兜底。
> 相关 issue 详见 [[整体代理(proxy)使用#已知问题]]。

## 接入 Kratos 优雅停机

Kratos 的 `kratos.App` 在收到退出信号时会**并行**调用所有已注册 `Server` 的 `Stop(ctx)`。
要触发 `HttpProxy.Close` 这类非网络服务，有两条主流路径：

### 路径 A：把 `Close` 包装成 `Server`（推荐）

```go
type LifecycleServer struct {
    grpcx.Server
    closer func(context.Context) error
    name   string
}

func (s *LifecycleServer) Stop(ctx context.Context) error {
    return s.closer(ctx)
}

func NewLifecycleServer(closer func(context.Context) error, name string) *LifecycleServer {
    return &LifecycleServer{closer: closer, name: name}
}
```

`wire` 注入时把 `HttpProxy.Close` 当作 closer：

```go
func provideProxyLifecycle(p *HttpProxy) grpcx.Server {
    return NewLifecycleServer(p.Close, "http-proxy-cron")
}
```

这样 `app.Stop` 链路就会自动调用 `HttpProxy.Close`，不需要在 `main` 里硬编码 `globalProxy` 引用。

> [!tip]
> 路径 A 与 Kratos 现有的「所有 server 并行 Stop」模型契合，与 [[river in go-kratos#保证优雅停机 (Graceful Shutdown)|River 接入 Kratos]] 的思路一致。
> 同类泛化场景（Kafka 消费者、MQ 订阅、cron 调度器）都可以走这条路径。

### 路径 B：`app.AfterStop` 钩子

Kratos `App` 支持 `kratos.BeforeStart` / `kratos.AfterStart` / `kratos.BeforeStop` / `kratos.AfterStop` 钩子：

```go
kratos.New(
    kratos.Server(servers...),
    kratos.AfterStop(func(ctx context.Context) error {
        return globalProxy.Close(ctx)
    }),
)
```

> 路径 B 适合**已经存在**全局变量、无法 wire 化的存量代码。
> 新代码优先走路径 A，调用链更可追踪。

## 项目现状

> 状态：截至 `ccnubox` 当前分支。服务列表见 [[华师匣子#服务一览]]。

| 文件 | cron 字段保留 | 显式 Stop | Kratos 接入 |
|------|---------------|-----------|-------------|
| `bff/cronx` | ✅ | ✅ `Manager.Stop` | ⚠️ 由 usecase `Close` 串接 |
| `be-classlist/internal/biz/classer.go` | ✅ | ✅ `Manager.Stop` | ✅ `usecase.Close()` |
| `be-class/internal/timedTask/timedTask.go` | ✅ | ⚠️ `c.Stop()` 直接调用 | ❌ 没有 `Stop` 出口 |
| `be-proxy/service/proxy.go` | ❌ | ❌ | ❌ 进程退出靠 OS 信号 |
| `common/bizpkg/proxy/http.go` | ❌ | ❌ | ❌ 进程退出靠 OS 信号 |

> 详细分析见 [[定时任务实现]]。

**结论**：

- `cronx` 系列已经做对（`be-classlist` / `bff`）。
- `be-proxy` / `common/bizpkg/proxy.http` 的 `@every Ns` / `@every 15s` 是**历史债**，需要按本文档 3.3 节的 `Close(ctx)` 模式补齐。
- `be-class` 有 `c.Stop` 但没有挂到 server 停机链路上，属于**半截子**。

## 重构建议

按收益和改动面排序：

1. **优先级高**：`common/bizpkg/proxy` 是所有服务共享的模块，按本文档「直接持有 `*cron.Cron`」一节的 `Close(ctx)` 模式补齐后影响面最大。配合 [[整体代理(proxy)使用]] 的现有改造一起做。
2. **优先级中**：`be-proxy` 把 cron 字段提到 `service.ProxyServer` 结构体上，并把 `Stop` 暴露为 `grpcx.Server.Stop`。
3. **优先级低**：`be-class` 把 `c.Stop` 挂到 `internal/server` 上。

> 抽象为 `LifecycleServer` 后，未来接入 Kafka 消费者、MQ 订阅等同类横切组件，**可以复用同一套模板**。

## 实现结论

- robfig/cron 的关闭必须**显式调用** `Stop()` 并等待 `doneCtx`，否则 in-flight 任务可能被截断。
- 项目内推荐两条路：
  1. **首选** `cronx.Manager`（[[定时任务实现]]），一行 `Stop(ctx)` 解决。
  2. **次选** 在结构体上保存 `*cron.Cron` 字段，暴露 `Close(ctx)`，并包装成 `LifecycleServer` 接入 Kratos 停机链路。
- 剩下的 `be-proxy` / `common/bizpkg/proxy` / `be-class` 是历史债，可按本文档统一收口。
- 与 [[BFF Otel使用]] 的 `errors.Join` 关闭模式属于同一类「**shutdown 错误聚合**」实践，可互相参照。
