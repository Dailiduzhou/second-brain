---
title: 整体代理（proxy）使用
category: ccnubox
type: deep-dive
topic: proxy
frameworks:
  - net/http
module: common
status: seedling
aliases:
  - 整体代理使用
  - ccnubox proxy
tags:
  - ccnubox
  - ccnubox/common
  - ccnubox/common/middleware
  - ccnubox/common/middleware/proxy
  - programming-language/go/http
---

# 整体代理（proxy）使用

本文档说明 `ccnubox-be` 中 `common/bizpkg/proxy` 模块的设计与使用方式，包括为何需要代理、配置方式、`HttpProxy` 内部实现以及微服务中的典型调用流程。

> 适用模块：`common/bizpkg/proxy`
> 相关模块：[[华师匣子]] · [[华师匣子框架]] · [[华师匣子BFF结构]] · [[定时任务实现]] · [[整体gRPC 配置字段]] · [[go-kratos 中间件实现]]

## 目标

- 说明生产环境为何需要走 IP 代理池访问 `华师教务系统`。
- 说明 `proxy.mode` 在开发与生产环境下的配置差异。
- 说明 `HttpProxy` 的结构、刷新机制、并发模型与函数选项式 API。
- 说明微服务中如何构造带代理的 `*http.Client`。

## 为什么需要代理

- 开发环境位于校园内网，可以**直连** [[华师匣子框架]] 中描述的 `华师教务系统`。
- 生产环境部署在云端，IP 来源不属于校园出口，对教务系统的高频访问容易被风控封禁。
- 通过 IP 代理池（`be-proxy`）做一层转发，可以**分散来源、降低被封概率**。

## 如何配置区分生产和开发环境

通过 `proxy.mode` 控制：

```yaml
# config-infra.yaml
proxy:
  mode: "remote"  # 生产环境走 be-proxy
  # mode: "direct"  # 开发环境绕过代理
```

- `remote`：通过 gRPC 调用 `be-proxy` 拉取主/备代理地址，并通过定时任务每 15 秒刷新。
- `direct`：直接访问目标地址，不走代理。

> ![info] 代理模式的改进
> [[Failover 代理传输层实现]]

## 整体架构

模块按三层组织：

```text
HttpProxy
  └─> 保存 gRPC client (proxyv1.ProxyClient) + 主/备地址
        └─> 通过 cron 每 15s 调用 be-proxy.GetProxyAddr 刷新地址
              └─> HttpTransport (http.Transport 的薄封装)
                    └─> HttpClient  (*http.Client 的薄封装)
```

每一层都通过**函数选项式**配置（参考 [[BFF Otel使用]] 的 `SetupOTel` 风格）：

```text
配置 HttpProxy
   |
配置 HttpTransport (http.Transport 的薄封装)
   |
配置 HttpClient (*http.Client 的薄封装)
```

## `HttpProxy` 结构

```go
type HttpProxy struct {
    Addr       string
    AddrBackup string

    direct bool
    mu     sync.RWMutex
    p      proxyv1.ProxyClient
    l      logger.Logger
}
```

字段语义：

| 字段 | 作用 |
|------|------|
| `Addr` | 主代理地址 |
| `AddrBackup` | 备代理地址 |
| `direct` | 是否直连模式（开发环境） |
| `mu` | 保护 `Addr` / `AddrBackup` 的 `sync.RWMutex` |
| `p` | `be-proxy` 的 gRPC client，用于拉取最新代理地址 |
| `l` | 项目统一 logger |

`Addr` / `AddrBackup` 由**定时任务**周期性更新；读取走 `RWMutex` 读锁以保证并发安全。

## 代理地址的存储与刷新

```go
func NewHttpProxy(p proxyv1.ProxyClient, l logger.Logger) Client {
    globalProxy = &HttpProxy{p: p, l: l}

    globalProxy.update()
    c := cron.New()
    _, _ = c.AddFunc("@every 15s", globalProxy.update) // 定时任务
    c.Start()

    return globalProxy
}
```

> [!warning]
> 上述写法把 `*cron.Cron` 的引用丢失了，进程退出时拿不到调度器做优雅停机。
> 修复方案见 [[cron 关闭兜底]]。

```go
func (s *HttpProxy) GetProxyAddr(_ context.Context, cnt int) []string {
    if s.direct {
        return make([]string, cnt)
    }

    s.mu.RLock()
    defer s.mu.RUnlock()

    addrs := make([]string, cnt)
    for i := 0; i < cnt; i++ {
        if i == 0 {
            addrs[i] = s.Addr
        } else {
            addrs[i] = s.AddrBackup
        }
        if addrs[i] == "" && i > 0 {
            addrs[i] = addrs[0]
        }
    }
    return addrs
}

func (s *HttpProxy) update() {
    if s.direct {
        return
    }
    if s.p == nil {
        return
    }

    ctx, cancel := context.WithTimeout(context.Background(), time.Second*2)
    defer cancel()

    res, err := s.p.GetProxyAddr(ctx, &proxyv1.GetProxyAddrRequest{})
    if err != nil {
        if l := s.logger(ctx); l != nil {
            l.Warn("从 be-proxy 获取代理地址失败", logger.Error(err))
        }
        return
    }

    s.mu.Lock()
    s.Addr, s.AddrBackup = res.Addr, res.Backup
    s.mu.Unlock()
}
```

### 关键设计点

- **定时刷新**：`@every 15s` 触发 `update()`，从 `be-proxy` 拉取主/备地址并写回。
- **启动即用**：`NewHttpProxy` 构造时先同步调用一次 `update()`，避免首次请求落在空地址上。
- **并发安全**：读路径使用 `RLock`，写路径使用 `Lock`，保证 `Addr` / `AddrBackup` 不会出现读写撕裂。
- **降级策略**：`GetProxyAddr` 中若 `AddrBackup` 为空，回退到 `Addr`；若 `Addr` 也为空，调用方上层会拿到空字符串并回退到直连（见下文 `WithProxyTransport`）。
- **错误处理**：gRPC 调用失败仅 `Warn` 不 panic，确保定时刷新不会拖垮进程。

> [!info]
> `common/bizpkg/proxy` 维护了一个**全局单例**的 `globalProxy`（`globalProxy = new(HttpProxy)`），保证同一进程中的所有微服务共享代理。
> 相关定时任务的实现细节可参考 [[定时任务实现]] 与 [[robfig cron 的使用]]。

> [!warning]
> 全局单例模式**违反了 DI 原则**，对全局状态的配置会牵连所有服务。
> 后续若引入多租户或按服务隔离代理的需求，需要重构为按依赖注入的实例。

## 代理具体实现

模块基于标准库 `net/http` 的 `http.Transport`，并通过函数选项式 API 控制最大连接数、保活时间、空闲连接数等参数。

### `HttpClient` 与 `Option`

```go
func (c *HttpClient) Use(options ...Option) {
    if len(options) == 0 {
        return
    }
    for _, option := range options {
        option(c)
    }
}

func WithTransport(tr *HttpTransport) Option {
    return func(client *HttpClient) {
        client.Transport = tr
    }
}
```

### `WithProxyTransport`：核心选项

```go
func WithProxyTransport(options ...RoundTripperOption) Option {
    return func(client *HttpClient) {
        tr := globalProxy.NewProxyTransport()
        if globalProxy.direct { // 使用直连模式
            tr.Use(options...)
            client.Transport = tr
            return
        }

        // 使用代理模式
        // 这里 tr.Proxy 的类型本来就是 func(*http.Request) (*url.URL, error)
        tr.Proxy = func(req *http.Request) (*url.URL, error) {
            ctx := req.Context()
            addrs := globalProxy.GetProxyAddr(ctx, 1)
            proxyAddr := strings.TrimSpace(addrs[0])
            if proxyAddr == "" {
                return nil, nil
            }
            proxyURL, err := url.Parse(proxyAddr)
            if err != nil {
                if l := globalProxy.logger(ctx); l != nil {
                    l.Warn("代理地址解析失败，fallback 到直连",
                        logger.String("proxy_addr", proxyAddr),
                        logger.Error(err),
                    )
                }
                return nil, nil
            }
            return proxyURL, nil
        }

        tr.Use(options...)
        client.Transport = tr
    }
}
```

行为说明：

1. `WithProxyTransport` 是**入口选项**，它创建一个新的 `HttpTransport`。
2. 直连模式下，不设置 `tr.Proxy`，相当于让 `http.Transport` 使用默认的 `ProxyFromEnvironment` → `nil`。
3. 代理模式下，把 `tr.Proxy` 替换为**按请求取址**的闭包：每次请求时调用 `globalProxy.GetProxyAddr` 取最新地址。
4. 闭包内对空地址与解析失败都做了 `nil, nil` 兜底，由 `http.Transport` 退化为直连。
5. 最后通过 `tr.Use(options...)` 把 `RoundTripperOption` 应用到 transport 上。

> [!tip]
> `http.Transport.Proxy` 的函数签名 `func(*http.Request) (*url.URL, error)` 在每次请求时被调用，
> 因此把取址逻辑放在闭包里可以**自动跟随** `globalProxy` 的地址刷新，无需重建 transport。

## 微服务中的调用方式

典型流程（以 `be-ccnu/crawler/common.go` 为例）：

```go
// 注入 proxy.Client
func NewCrawlerClient(pc proxy.Client, t time.Duration, options ...proxy.Option) *http.Client {
    opts := []proxy.Option{
        proxy.WithProxyTransport(),          // 启用代理
        proxy.WithRedirectPolicy(proxy.RedirectPolicyAllow),
        proxy.WithTimeout(t),
        proxy.WithCookieJar(j),
    }
    return pc.NewProxyClient(opts...).Client  // 创建带代理的 http.Client
}
```

要点：

- 通过 `wire` 等 DI 容器把 `proxy.Client` 注入到调用方（参考 [[华师匣子框架#分层架构]]）。
- `WithProxyTransport()` 必选，启用代理能力。
- `WithRedirectPolicy` / `WithTimeout` / `WithCookieJar` 等按需组合，遵循**函数选项式**的可拓展性。
- `pc.NewProxyClient(opts...).Client` 返回一个标准 `*http.Client`，可直接用于业务侧 HTTP 调用。

## 适用范围

- 任何需要访问 [[华师匣子]] 中提到的 CCNU 教务/图书馆/电费/课表等下游系统的微服务。
- 生产环境与开发环境统一通过 `proxy.mode` 切换。
- 与 [[整体gRPC 配置字段]] 中的服务发现独立运行：proxy 是**出站 HTTP** 能力，gRPC conf 是**服务间 RPC** 配置。

## 已知问题

- **全局单例**：`globalProxy` 不支持多租户，按服务隔离代理需要重构。
- **cron 关闭兜底**：`@every 15s` 的 `cron.Cron` 引用未保存到结构体字段，进程退出时无法调用 `Stop()`。详见 [[cron 关闭兜底]]。
- **错误暴露粒度**：gRPC 拉取失败仅 `Warn`，没有暴露 Prometheus 指标，排障依赖日志检索。
- **无降级熔断**：上游 `be-proxy` 不可用时只会持续走直连（fallback），没有显式熔断或重试策略。

## 实现结论

- `common/bizpkg/proxy` 通过**全局单例 + 定时刷新**的方式，把 IP 代理池的复杂度收敛在 `HttpProxy` 内。
- **函数选项式 API** 让 `HttpClient` 的构造保持可拓展、默认值友好。
- 业务侧只需 `proxy.WithProxyTransport()` 即可启用代理，配置切换通过 yaml 中的 `proxy.mode` 完成。
- 与 [[定时任务实现]] / [[go-kratos 中间件实现]] / [[cron 关闭兜底]] 共同构成 `common` 模块的横切能力集合。
