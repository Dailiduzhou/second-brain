---
title: "`be-ccnu` Crawler 创建/使用问题与改造方案"
category: ccnubox
type: refactor-plan
topic: crawler
subtopic: session-abstraction
module: be-ccnu
submodule: crawler
frameworks:
  - go
  - net/http
  - ants
  - go-kratos
  - google-wire
status: seedling
aliases:
  - be-ccnu crawler 优化
  - crawlerx.Session 改造方案
  - crawler client 复用与 Session 抽象
tags:
  - ccnubox
  - ccnubox/be-ccnu
  - ccnubox/refactor
  - programming-language/go
  - programming-language/go/http
  - concurrency/session
---

# `be-ccnu` Crawler 创建/使用问题与改造方案

> 适用项目：[[华师匣子]]
> 相关文档：[[华师匣子框架]] · [[华师匣子-代码结构]] · [[整体代理(proxy)使用]] · [[BFF 中间件错误处理]] · [[华师匣子用户活跃度统计]]
> 涉及服务：`be-ccnu`（一站式登录）

本文梳理 `be-ccnu/service/ccnu.go` 中 4 个 crawler 业务方法在 `*http.Client` 创建与使用上的不一致问题，给出**以 `crawlerx.Session` 作为会话核心**的改造方案，并对改造前后的资源占用、可读性、可扩展性做量化对比。

---

## 1. 一句话问题

> **`*http.Client` 这个"会话核心"在 4 个 crawler 里被以 4 种方式管理，导致 `service` 层到处是重复创建 + 字段覆盖。**

具体表现：

- 同一请求里 `crawler.NewCrawlerClient(...)` 被调多次；
- 研究生 crawler 的 `client` 字段是小写，外部无法直接共享；
- `GetLibraryToken` 创建一个 `WithoutProxy` 的 client 后立即被覆盖。

> [!warning] 根因
> 4 个 crawler 的"构造"与"登录"职责重叠，且都把 `*http.Client` 当作普通字段处理，缺失"会话"这个抽象层级。

---

## 2. 现状：4 个业务方法如何创建 / 使用 crawler

### 2.1 `getUnderGradCookie` 本科路径（浪费最严重）

源码：`be-ccnu/service/ccnu.go:108`

```go
func (c *ccnuService) getUnderGradCookie(ctx context.Context, stuId, password string, tpe ...string) (string, error) {
    // ① 创建一个 client 喂给 ug（此时 ug 啥也没做）
    ug := crawler.NewUnderGrad(crawler.NewCrawlerClient(c.p, c.timeout))   // ← client #1 浪费

    // ② loginUnderGrad 内部又创建一个 client 喂给 Passport
    client, ok, err := c.loginUnderGrad(ctx, stuId, password)
    if err != nil {
        return "", errorx.Errorf("getUnderGradCookie loginUnderGrad error: %w", err)
    }
    if !ok {
        return "", Invalid_SidOrPwd_ERROR(errorx.New("getUnderGradCookie login failed"))
    }

    // ③ 把 Passport 的 client 覆盖到 ug 上
    ug.Client = client   // ← 覆盖 client #1
    // ...
}
```

被调用的 `loginUnderGrad`（`be-ccnu/service/ccnu.go:96`）：

```go
func (c *ccnuService) loginUnderGrad(ctx context.Context, studentId, password string) (*http.Client, bool, error) {
    ps := crawler.NewPassport(crawler.NewCrawlerClient(c.p, c.timeout))   // ← client #2
    flag, err := ps.LoginPassport(ctx, studentId, password)
    // ...
    return ps.Client, flag, nil
}
```

> [!danger] 资源浪费
> **同一个请求内 `NewCrawlerClient` 被调了 2 次**，产生 2 个 `*http.Client` + 2 个 `cookiejar` + 2 条代理传输链。`client #1` 在被覆盖前**没有任何使用**。

---

### 2.2 `getGradCookie` 研究生路径（不调用 `loginGrad`，自己重建）

源码：`be-ccnu/service/ccnu.go:139`

```go
func (c *ccnuService) getGradCookie(ctx context.Context, stuId, password string) (string, error) {
    pg := crawler.NewPostGraduate(crawler.NewCrawlerClient(c.p, c.timeout))   // ← 新 client
    pubkey, err := tool.Retry(func() (*rsa.PublicKey, error) {
        return pg.FetchPublicKey(ctx)
    })
    if err != nil {
        return "", CCNUSERVER_ERROR(errorx.Errorf("getGradCookie FetchPublicKey error: %w", err))
    }

    cookie, err := pg.GetCookie(ctx, stuId, password, pubkey)
    // ...
}
```

问题：

- **没有复用** `LoginCCNU` 研究生路径里的 `loginGrad` 逻辑；
- `FetchPublicKey` 和 `GetCookie` 在一次调用内都建在**同一个新 client** 上（对的），但**和本科路径的 client 没有任何联系**——这恰好说明研究生也本可以走同一套 session 模型。

---

### 2.3 `LoginCCNU` 研究生路径（唯一传 crawler 实例的形态）

源码：`be-ccnu/service/ccnu.go:49`

```go
case tool.PostGraduate:
    pg := crawler.NewPostGraduate(crawler.NewCrawlerClient(c.p, c.timeout))
    ok, err := c.loginGrad(ctx, pg, studentId, password)   // ← 把 pg 实例传进去
    // ...

func (c *ccnuService) loginGrad(ctx context.Context, pg *crawler.PostGraduate, studentId, password string) (bool, error) {
    pubkey, err := tool.Retry(func() (*rsa.PublicKey, error) {
        return pg.FetchPublicKey(ctx)        // ← 闭包捕获 pg
    })
    // ...
    err = pg.LoginPostgraduateSystem(ctx, studentId, password, pubkey)
    // ...
}
```

为什么必须传 `pg`？因为 `PostGraduate.client` 在 `be-ccnu/crawler/postgraduate.go:28` 是**小写**：

```go
// be-ccnu/crawler/postgraduate.go:27
type PostGraduate struct {
    client *http.Client   // ← 小写，外部无法赋值
}
```

> [!note] API 不一致的根源
> 这是**唯一的"小写 client" crawler**，导致 `service` 层不得不把整个实例传进 helper。
> `Passport` / `UnderGrad` / `Library` 都是大写 `Client`（`passport.go:20` / `undergrad.go:21` / `library.go:31`），可以外部赋值。

---

### 2.4 `GetLibraryToken` 路径（创建 2 个 client，只留 1 个）

源码：`be-ccnu/service/ccnu.go:155`

```go
func (c *ccnuService) GetLibraryToken(ctx context.Context, studentId, password string, service ccnuv1.LIBRARY_TYPE) (string, error) {
    // ① 为 Library 建一个 client（用 WithoutProxy）
    l := crawler.NewLibrary(
        crawler.NewCrawlerClient(c.p, c.timeout, proxy.WithoutProxy()),   // ← client #1
        c.secret,
    )
    // ② loginUnderGrad 内部又建一个新 client（走代理）
    client, ok, err := c.loginUnderGrad(ctx, studentId, password)         // ← client #2
    if err != nil { /* ... */ }
    if !ok { /* ... */ }

    l.Client = client   // ← 覆盖 client #1
    err = l.LoginLibrary(ctx)
    // ...
}
```

> [!warning] 死代码：`WithoutProxy` 在这里实际无效
> `client #1`（直连 `WithoutProxy`）**从诞生到被覆盖中间没有任何使用**。`WithoutProxy` 这个 option 写在这里实际是**无效的**——因为登录用的 `loginUnderGrad` 走的是 `Passport` 那条带代理的 client，最终的 client 一定走代理。
>
> 如果业务上**真的需要**图书馆登录走直连（可能某种网络环境下 SSO 直连更稳），那 `WithoutProxy` 应该作用在 `client #2` 上，而不是 `client #1` 上。

---

## 3. 4 个 crawler 的 client 字段对比

| crawler       | 文件:行                       | 字段名        | 可外部赋值?  | 构造后是否立即可用?     |
| ------------- | ----------------------------- | ------------- | ------------ | ---------------------- |
| `Passport`    | `crawler/passport.go:20`      | `Client`（大写） | ✅           | ✅ 但 cookiejar 空      |
| `UnderGrad`   | `crawler/undergrad.go:21`     | `Client`（大写） | ✅           | ✅ 但 cookiejar 空      |
| `PostGraduate`| `crawler/postgraduate.go:28`  | `client`（小写） | ❌           | ❌ 必须先建实例时传     |
| `Library`     | `crawler/library.go:31`       | `Client`（大写） | ✅           | ✅ 但 cookiejar 空      |

> **API 不一致**导致 `service` 层要写 4 种不同的"创建 crawler"代码，这是混乱的根源。

---

## 4. 混乱的 5 个具体表现汇总

| #  | 表现                                       | 位置                                      | 浪费/风险                              |
| -- | ------------------------------------------ | ----------------------------------------- | -------------------------------------- |
| 1  | 同一请求内 `NewCrawlerClient` 调多次       | `service/ccnu.go:108` + `:97`             | 多份 client/cookiejar/传输链           |
| 2  | `client` 字段大小写不统一                  | `crawler/postgraduate.go:28` vs 其他      | API 风格不一致                         |
| 3  | `loginGrad` 不得不传 `*PostGraduate` 实例   | `service/ccnu.go:68`                      | 调用形态不一致                         |
| 4  | 研究生公钥 `FetchPublicKey` 没缓存         | `service/ccnu.go:71` + `:141`             | 同一调用内 2 次拉公钥（分属 2 条路径）  |
| 5  | `GetLibraryToken` 创建一个 client 后立即覆盖 | `service/ccnu.go:156`                  | `WithoutProxy` 实际无效                |

---

## 5. 根因分析

### 5.1 `*http.Client` 是"会话核心"，但被当成普通字段

`*http.Client` 在 `crawler` 里实际承担了三件事：

- **cookiejar 容器**：跨请求保存 Cookie（登录的核心）；
- **Transport**：决定代理、超时、TLS 配置；
- **共享句柄**：多个 goroutine 安全复用。

但当前代码把它当成"普通属性"，**没有"会话"这个概念**。

### 5.2 "构造"和"登录"职责重叠

每个 crawler 的使用模式都是：

```text
NewXxx(client) → client 字段存好
.LoginXxx(ctx) → 用 client.Do 发请求，cookiejar 累积
```

`NewXxx` 和 `LoginXxx` 都接受/依赖 client，导致"谁来创建 client"成为开放问题。

### 5.3 业务方法各自为政

`service/ccnu.go` 里的 4 个业务方法（`getUnderGradCookie` / `getGradCookie` / `loginUnderGrad` / `loginGrad` / `GetLibraryToken`）各自有各自的 client 创建 + 登录 + 覆盖 client 的模式，**没有统一的"会话"概念把它们串起来**。

---

## 6. 改造方案：引入 `crawlerx.Session`

### 6.1 设计原则

| 原则                                                | 落地                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Session 是 client 的唯一持有人**                  | `crawlerx.NewSession` 创建，内部 `*http.Client` 对外只读                              |
| **所有 crawler 一律接收 `*http.Client`**            | 构造时传入，字段小写，无 setter                                                       |
| **`service` 层只持有 Session，不持有 client**       | `sess := crawlerx.NewSession(...)` 后只调 `sess.Client()` getter                      |
| **Option 集中在 Session 构造时**                    | `WithoutProxy` / `WithTimeout` 等都进 Session，不在各个 crawler 入口散布              |

### 6.2 新增 `common/pkg/crawlerx/session.go`

```go
package crawlerx

import (
    "net/http"
    "net/http/cookiejar"
    "time"

    "github.com/asynccnu/ccnubox-be/common/bizpkg/proxy"
)

// Session 代表一次"已登录的浏览器会话"。
// 同一 Session 内所有 HTTP 请求共享 cookiejar / Transport / 超时。
type Session struct {
    client *http.Client
}

// NewSession 构造一个干净的 Session。
// options 追加在默认选项之后（如 proxy.WithoutProxy()）。
func NewSession(pc proxy.Client, timeout time.Duration, options ...proxy.Option) *Session {
    j, _ := cookiejar.New(&cookiejar.Options{})
    opts := []proxy.Option{
        proxy.WithProxyTransport(),
        proxy.WithRedirectPolicy(proxy.RedirectPolicyAllow),
        proxy.WithTimeout(timeout),
        proxy.WithCookieJar(j),
    }
    opts = append(opts, options...)
    return &Session{client: pc.NewProxyClient(opts...).Client}
}

// Client 暴露底层 client（给 crawler 用）。
func (s *Session) Client() *http.Client { return s.client }
```

> [!tip] 依赖
> `proxy.Client` / `proxy.Option` 的定义与函数选项式 API 见 [[整体代理(proxy)使用]]。

### 6.3 改 `crawler/*.go`：字段统一小写 + getter

| 文件                              | 改动                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `crawler/passport.go:20`          | `Client *http.Client` → `client *http.Client` + `(p *Passport) Client() *http.Client`   |
| `crawler/undergrad.go:21`         | 同上                                                                                    |
| `crawler/postgraduate.go:28`      | 保持小写（已一致），加 `Client()` getter                                                 |
| `crawler/library.go:31`           | `Client *http.Client` → `client *http.Client` + getter                                  |
| `crawler/common.go:15`            | `NewCrawlerClient` 函数**保留**（作为 Session 内部使用）                                |

### 6.4 改 `service/ccnu.go`：用 Session 串联登录

```go
// 改造后的 getUnderGradCookie
func (c *ccnuService) getUnderGradCookie(ctx context.Context, stuId, password string) (string, error) {
    // 1) 一个 Session = 1 个 client + 1 个 cookiejar
    sess := crawlerx.NewSession(c.p, c.timeout)

    // 2) Passport 登录
    ps := crawler.NewPassport(sess.Client())
    ok, err := ps.LoginPassport(ctx, stuId, password)
    if err != nil {
        return "", mapErr(err)
    }
    if !ok {
        return "", Invalid_SidOrPwd_ERROR(errorx.New("login failed"))
    }

    // 3) 同一个 client 给 UnderGrad
    ug := crawler.NewUnderGrad(sess.Client())
    if err := tool.Retry(func() error { return ug.LoginUnderGradSystem(ctx) }); err != nil {
        return "", CCNUSERVER_ERROR(errorx.Errorf("login undergrad: %w", err))
    }
    return ug.GetCookieFromUnderGradSystem()
}
```

```go
// 改造后的 getGradCookie
func (c *ccnuService) getGradCookie(ctx context.Context, stuId, password string) (string, error) {
    sess := crawlerx.NewSession(c.p, c.timeout)
    pg := crawler.NewPostGraduate(sess.Client())
    pubkey, err := tool.Retry(func() (*rsa.PublicKey, error) { return pg.FetchPublicKey(ctx) })
    if err != nil {
        return "", CCNUSERVER_ERROR(errorx.Errorf("FetchPublicKey: %w", err))
    }
    return pg.GetCookie(ctx, stuId, password, pubkey)
}
```

```go
// 改造后的 GetLibraryToken
func (c *ccnuService) GetLibraryToken(ctx context.Context, studentId, password string, service ccnuv1.LIBRARY_TYPE) (string, error) {
    sess := crawlerx.NewSession(c.p, c.timeout)   // 一个 client

    ps := crawler.NewPassport(sess.Client())
    if ok, err := ps.LoginPassport(ctx, studentId, password); err != nil {
        return "", err
    } else if !ok {
        return "", Invalid_SidOrPwd_ERROR(errorx.New("library login failed"))
    }

    l := crawler.NewLibrary(sess.Client(), c.secret)   // 同一个 client
    if err := l.LoginLibrary(ctx); err != nil {
        return "", CCNUSERVER_ERROR(errorx.Errorf("LoginLibrary: %w", err))
    }
    // ...
}
```

### 6.5 顺手修：研究生公钥缓存

```go
type gradKeyCache struct {
    once sync.Once
    key  *rsa.PublicKey
    err  error
}

func (c *ccnuService) getGradCookie(ctx context.Context, stuId, password string) (string, error) {
    sess := crawlerx.NewSession(c.p, c.timeout)
    pg := crawler.NewPostGraduate(sess.Client())

    var cache gradKeyCache
    pubkey, err := cache.onceValue(func() (*rsa.PublicKey, error) {
        return tool.Retry(func() (*rsa.PublicKey, error) { return pg.FetchPublicKey(ctx) })
    })
    if err != nil {
        return "", CCNUSERVER_ERROR(errorx.Errorf("FetchPublicKey: %w", err))
    }
    return pg.GetCookie(ctx, stuId, password, pubkey)
}
```

> [!note] 公钥缓存粒度
> 当前 `getGradCookie` 只调一次 `FetchPublicKey`，问题不大；但 `LoginCCNU` 和 `GetXKCookie` 的研究生路径**各自调一次**（分属两个 service 方法），如果想跨调用共享，可以把公钥缓存进 `crawlerx.Session`（以 Session 为 key）。

---

## 7. 改造前后对比

### 7.1 资源消耗

| 场景                       | 改造前                                                          | 改造后                      |
| -------------------------- | --------------------------------------------------------------- | --------------------------- |
| `GetXKCookie` 本科         | 2 个 client + 2 个 cookiejar + 2 条传输链                       | 1 个 + 1 个 + 1 条          |
| `GetXKCookie` 研究生       | 1 个 client（只用了 1 个）                                       | 1 个 client                 |
| `LoginCCNU` 研究生         | 1 个 client                                                     | 1 个 client                 |
| `GetLibraryToken`          | **2 个 client**（1 个直连白建）+ 2 个 cookiejar                 | 1 个 + 1 个                 |
| **`WithoutProxy` 实际效果**| **无效**（被覆盖）                                              | **作用在唯一 client 上**    |

### 7.2 代码可读性

| 维度                                | 改造前                  | 改造后                          |
| ----------------------------------- | ----------------------- | ------------------------------- |
| `PostGraduate.client` 字段          | 小写，无法外部共享      | 一致小写 + getter               |
| 调用方 `xxx.Client = client`        | 4 处                    | **0 处**                        |
| `loginGrad` 是否需要传 `*PostGraduate` | 要                  | 不需要                          |
| `getUnderGradCookie` 行数           | ~30 行                  | ~15 行                          |
| 新增站点的模板                      | 看 4 个 crawler 各自怎么建 | 一行 `sess := crawlerx.NewSession(...)` |

### 7.3 可扩展性

新加一个站点（假设 `be-ccnu` 要支持新的"图书馆研习间"）：

```go
// 1) 在 crawler/ 里写
type StudyRoomCrawler struct{ client *http.Client }

func NewStudyRoomCrawler(c *http.Client) *StudyRoomCrawler {
    return &StudyRoomCrawler{client: c}
}

func (c *StudyRoomCrawler) LoginStudyRoom(ctx context.Context) error { /* ... */ }

// 2) 在 service 里
sess := crawlerx.NewSession(c.p, c.timeout)
ps := crawler.NewPassport(sess.Client())
_ = ps.LoginPassport(ctx, /* ... */)

sr := crawler.NewStudyRoomCrawler(sess.Client())
_ = sr.LoginStudyRoom(ctx)
```

> 不需要再纠结"client 字段是大写还是小写""谁负责创建 client"。

---

## 8. 改造步骤（推荐顺序）

| 步骤 | 内容                                                                     | 风险                                                                                       |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1    | 新增 `common/pkg/crawlerx/session.go`                                    | 0（纯新增）                                                                                |
| 2    | 4 个 crawler 字段大小写统一 + 加 `Client()` getter                       | 低（对外 API 改名，需要 grep 调用方）                                                       |
| 3    | 删 `crawler/common.go` 的 `NewCrawlerClient` 导出，改 `crawlerx` 内部使用 | 低                                                                                          |
| 4    | 改 `service/ccnu.go` 用 Session                                          | 中（行为必须保持一致，建议先跑现有测试）                                                    |
| 5    | 验证 `GetLibraryToken` 的 `WithoutProxy` 语义（产品决策）                 | 中（如果产品原本就想要 SSO 直连，需要改 option 位置）                                      |
| 6    | 研究生公钥缓存（可选）                                                    | 低                                                                                          |

> [!tip] 回滚保障
> 步骤 2 把字段改小写时，旧代码 `xxx.Client = ...` 会编译失败——但 `service` 层本来就是改造目标，正好强制改造。`crawler/undergrad_test.go` 如果有外部使用 `UnderGrad.Client` 也要改。

---

## 9. 一句话总结

- **核心问题**：`*http.Client` 这个"会话核心"在 4 个 crawler 里被以 4 种方式（`Client` / `client`、构造时传 / 登录后赋值）管理，导致 `service` 层到处是重复创建 + 字段覆盖。
- **优化方案**：抽出 `crawlerx.Session` 作为 client 的唯一持有人，所有 crawler 一律以 `*http.Client` 为构造参数（字段小写 + getter），`service` 层只负责"建 Session → 调 crawler → 拿结果"的线性流程，不再持有或传递 `*http.Client`。
- **预期收益**：每个请求少 1~2 个 client/cookiejar，`service` 层 4 个方法统一形态，`WithoutProxy` 等 option 真正生效，新加 crawler 模板 1 行。

---

## 跨主题链接

- 项目与架构
  - [[华师匣子]] — 项目总览与笔记导航
  - [[华师匣子框架]] — 技术栈与分层架构
  - [[华师匣子-代码结构]] — 仓库目录与 Go workspace
  - [[华师匣子BFF结构]] — BFF 层职责
- 通用能力
  - [[整体代理(proxy)使用]] — `proxy.Client` / `proxy.Option` 详解
  - [[Failover 代理传输层实现]] — `FailoverTransport` 与传输链复用
  - [[华师匣子日志封装]] — `logger.Logger` 注入
  - [[华师匣子限流中间件]] — 业务侧限流
  - [[华师匣子用户活跃度统计]] — 另一种"批处理 + 协程池"模式
- BFF 风险与重构
  - [[BFF 中间件错误处理]] — `errorhandling` 中间件
  - [[BFF 取gRPC结构体字段风险报告]] — 字段取值 nil 风险
  - [[BFF 中表示不可用的接口列表]] — 占位但未实现的接口
- 依赖与模式
  - [[go-kratos架构]] — 借鉴的 Kratos 分层
  - [[kratos layout]] — 各服务 layout 模板
  - [[整体gRPC 配置字段]] — `GrpcConf` 字段语义
