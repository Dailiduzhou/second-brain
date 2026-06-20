---
category: ccnubox
type: vulnerability
topic: jwt-coupling
module: bff
status: seedling
tags:
  - ccnubox
  - ccnubox/bff
  - security/jwt
  - golang/architecture
vul-status: to-be-done
---

# BFF JWT / Session 耦合问题分析

## 1. 概述

BFF 层的认证体系由 `ijwt.Handler` 接口统一承载，实现类 `RedisJWTHandler` 同时负责：
JWT 签发/解析、密码加解密、HTTP 响应头管理、Redis session 黑名单管理。

本文档梳理该模块中存在的耦合问题和安全隐患。

### 涉及文件

| 文件 | 职责 |
|------|------|
| `bff/web/ijwt/types.go` | `Handler` 接口定义 |
| `bff/web/ijwt/redis.go` | `RedisJWTHandler` 实现 |
| `bff/web/middleware/login.go` | 认证中间件，每个受保护请求都会经过 |
| `bff/web/user/user.go` | Login / Logout / RefreshToken / DeleteAccount |
| `bff/ioc/jwt.go` | 依赖注入：创建 `RedisJWTHandler` |
| `bff/ioc/handler.go` | 依赖注入：`UserHandler` 内嵌 `ijwt.Handler` |

---

## 2. 问题一：`ClearToken` 混合了 HTTP 关注点与 Session 管理

### 2.1 代码

`bff/web/ijwt/redis.go:47-58`：

```go
func (r *RedisJWTHandler) ClearToken(ctx *gin.Context) error {
    // 要求客户端设置为空
    ctx.Header("x-jwt-token", "")
    ctx.Header("x-refresh-token", "")
    // 在 Redis 中记录已过期的会话 TODO 这里需要解耦合,但是写的太抽象了一时半会儿看不明白,先这么做
    uc, err := ginx.GetClaims[UserClaims](ctx)
    if err != nil {
        return err
    }

    return r.cmd.Set(ctx, fmt.Sprintf("ccnubox:users:ssid:%s", uc.Ssid), "", r.rcExpiration).Err()
}
```

### 2.2 问题分析

这个函数同时做了两件事：

1. **清 HTTP 响应头**（`ctx.Header("x-jwt-token", "")`）— 属于 HTTP/gateway 层的职责
2. **在 Redis 中标记 session 失效**（`r.cmd.Set(...)`）— 属于 session 管理的职责

代码中的 TODO 注释也承认了这一点：*"这里需要解耦合,但是写的太抽象了一时半会儿看不明白,先这么做"*。

这导致了两个后果：

**后果 A：隐式依赖 gin.Context 中的 claims**

`ClearToken` 依赖 `ginx.GetClaims[UserClaims](ctx)`（`bff/pkg/ginx/ginx.go:137-150`）获取 `Ssid`。
这要求调用前**必须**有 middleware（`bff/web/middleware/login.go:38`）提前将 `UserClaims` 写入 context。

如果未来有人在没有 auth middleware 的场景调用 `ClearToken`，会直接返回错误。

**后果 B：`Handler` 接口被迫绑定 `gin.Context`**

`bff/web/ijwt/types.go:8-18` 中的 `Handler` 接口所有方法都接收 `*gin.Context`：

```go
type Handler interface {
    ClearToken(ctx *gin.Context) error
    ExtractToken(ctx *gin.Context) string
    SetLoginToken(ctx *gin.Context, studentId string, password string) error
    SetJWTToken(ctx *gin.Context, cp ClaimParams) error
    CheckSession(ctx *gin.Context, ssid string) (bool, error)
    JWTKey() []byte
    RCJWTKey() []byte
    EncKey() []byte
    DecryptPasswordFromClaims(uc *UserClaims) (string, error)
}
```

JWT 签发和 session 管理本不依赖 HTTP 框架，但因为 `gin.Context` 的渗透，整个接口无法在非 HTTP 场景（如 cron job、gRPC interceptor）中复用。

### 2.3 调用链

`ClearToken` 被两处调用：

**`bff/web/user/user.go:115-123`（Logout）**：

```go
func (h *UserHandler) Logout(ctx *gin.Context) (web.Response, error) {
    err := h.ClearToken(ctx)
    if err != nil {
        return web.Response{}, errs.JWT_SYSTEM_ERROR(err)
    }
    return web.Response{
        Msg: "Success",
    }, nil
}
```

`UserHandler` 通过内嵌 `ijwt.Handler`（`bff/web/user/user.go:20-24`）直接调用：

```go
type UserHandler struct {
    ijwt.Handler
    userClient userv1.UserServiceClient
    preLoader  PreLoader
}
```

**`bff/web/user/user.go:183-199`（DeleteAccount）**：

```go
func (h *UserHandler) DeleteAccount(ctx *gin.Context, req DeleteAccountReq, cla ijwt.UserClaims) (web.Response, error) {
    // ...
    err := h.ClearToken(ctx)
    if err != nil {
        return web.Response{}, errs.JWT_SYSTEM_ERROR(err)
    }
    // ...
}
```

两处调用都位于 auth middleware 保护的路由下，所以 `ginx.GetClaims` 能正常工作。
但这种隐式依赖没有类型系统保障，全靠约定。

### 2.4 修复建议

将 `ClearToken` 拆分为两个独立操作：

```go
// session 管理：不依赖 gin.Context，只接收 ssid
func (r *RedisJWTHandler) InvalidateSession(ctx context.Context, ssid string) error {
    return r.cmd.Set(ctx, fmt.Sprintf("ccnubox:users:ssid:%s", ssid), "", r.rcExpiration).Err()
}
```

HTTP 层的清响应头逻辑留在 handler 中：

```go
func (h *UserHandler) Logout(ctx *gin.Context) (web.Response, error) {
    uc, _ := ginx.GetClaims[ijwt.UserClaims](ctx)
    ctx.Header("x-jwt-token", "")
    ctx.Header("x-refresh-token", "")

    err := h.sessionStore.InvalidateSession(ctx, uc.Ssid)
    if err != nil {
        return web.Response{}, errs.JWT_SYSTEM_ERROR(err)
    }
    return web.Response{Msg: "Success"}, nil
}
```

---

## 3. 问题二：`CheckSession` 黑名单语义反转 + Redis 故障误判

### 3.1 代码

**`CheckSession` 定义**（`bff/web/ijwt/redis.go:132-136`）：

```go
func (r *RedisJWTHandler) CheckSession(ctx *gin.Context, ssid string) (bool, error) {
    val, err := r.cmd.Exists(ctx, fmt.Sprintf("ccnubox:users:ssid:%s", ssid)).Result()
    return val > 0, err
}
```

语义：**key 存在 → 返回 true → 表示 "session 已被注销"**。

**调用方 1**（`bff/web/middleware/login.go:79-83`）：

```go
ok, err := m.handler.CheckSession(ctx, uc.Ssid)
if err != nil || ok {
    // err如果是redis崩溃导致，考虑进行降级，不再验证是否退出 refresh_token降级的话收益会很少，因为是低频接口
    return ijwt.UserClaims{}, errorx.New("session检验：失败")
}
```

**调用方 2**（`bff/web/user/user.go:151-153`，RefreshToken）：

```go
ok, err := h.CheckSession(ctx, rc.Ssid)
if err != nil || ok {
    return web.Response{}, errs.JWT_SYSTEM_ERROR(err)
}
```

### 3.2 问题分析

**问题 A：Redis 故障与 session 失效混为一谈**

两个调用方都用 `err != nil || ok` 做判断，将 Redis 连接失败（`err != nil`）和 session 已注销（`ok == true`）视为同一类错误。

后果：Redis 崩溃时，所有已登录用户的每个请求都会被拒绝（中间件层），refresh token 也无法续期。整个系统完全依赖 Redis 可用性。

代码注释也承认了这个问题：*"err如果是redis崩溃导致，考虑进行降级"*，但未实现降级逻辑。

**问题 B：返回值语义反直觉**

`CheckSession` 返回 `true` 表示 session **无效**（已被注销），返回 `false` 表示 session **有效**。
函数名 "CheckSession" 暗示 "检查 session 是否有效"，但实际语义是 "检查 session 是否已被拉黑"。

**问题 C：黑名单无限增长**

每次 logout/delete 操作都会在 Redis 中写入一个 key，TTL 为 6 个月（`bff/web/ijwt/redis.go:143`）：

```go
rcExpiration: time.Hour * 24 * 30 * 6, // 设置为六个月之后过期
```

高频登录/登出场景下（如测试、自动化脚本），这些 key 会持续累积，占用 Redis 内存。

### 3.3 修复建议

**短期**：区分 Redis 错误和 session 失效，中间件降级放行

```go
func (r *RedisJWTHandler) IsSessionInvalid(ctx context.Context, ssid string) (bool, error) {
    val, err := r.cmd.Exists(ctx, "ccnubox:users:ssid:"+ssid).Result()
    if err != nil {
        return false, err  // Redis 故障，由调用方决定降级策略
    }
    return val > 0, nil  // key 存在 = session 已注销
}
```

中间件降级：

```go
invalid, err := m.handler.IsSessionInvalid(ctx, uc.Ssid)
if err != nil {
    // Redis 故障：降级放行（JWT 签名有效即可），记录告警
    l.Warn("session check degraded, JWT-only auth", logger.Error(err))
} else if invalid {
    return ijwt.UserClaims{}, errorx.New("session已注销")
}
```

**中期**：切换到白名单模式

- Login 时：`SET ccnubox:session:{ssid} {studentId} EX 3600`
- Logout 时：`DEL ccnubox:session:{ssid}`
- Check 时：`EXISTS ccnubox:session:{ssid}` → 存在即有效

好处：
- Redis 只存活跃 session，内存上界 = 同时在线用户数
- 语义直观：key 存在 = 有效
- Redis 故障时拒绝所有请求（更安全，因为不会放行已注销的 session）

---

## 4. 问题三：密码嵌入 JWT，每个请求都解密并回写

### 4.1 代码

**登录时将加密密码写入 JWT**（`bff/web/ijwt/redis.go:74-90`）：

```go
func (r *RedisJWTHandler) SetLoginToken(ctx *gin.Context, studentId string, password string) error {
    enPassword, err := r.encryptString(password)
    if err != nil {
        return err
    }
    cp := ClaimParams{
        StudentId: studentId,
        Password:  enPassword,       // 加密后的密码写入 claims
        Ssid:      uuid.New().String(),
        UserAgent: ctx.GetHeader("User-Agent"),
    }
    // ...
}
```

**`UserClaims` 和 `RefreshClaims` 都包含 Password 字段**（`bff/web/ijwt/redis.go:151-166`）：

```go
type UserClaims struct {
    jwt.RegisteredClaims
    StudentId string // 学生 ID
    Password  string // 密码（仅用于演示，实际应用中不会存储密码）
    Ssid      string // 会话 ID
    UserAgent string // 用户代理信息
}

type RefreshClaims struct {
    jwt.RegisteredClaims
    StudentId string // 学生 ID
    Password  string // 密码
    Ssid      string // 会话 ID
    UserAgent string // 用户代理信息
}
```

**每个受保护请求都会解密密码并回写**（`bff/web/middleware/login.go:84-95`）：

```go
password, err := m.handler.DecryptPasswordFromClaims(&uc)
if err != nil {
    return ijwt.UserClaims{}, errorx.Errorf("解密失败:%w", err)
}
// TODO 临时逻辑,用于解决秘钥不统一的问题,后续需要删除
_, err = m.userClient.SaveUser(ctx, &userv1.SaveUserReq{
    StudentId: uc.StudentId,
    Password:  password,
})
if err != nil {
    return ijwt.UserClaims{}, err
}
```

**解密实现**（`bff/web/ijwt/redis.go:195-219`）：

```go
func (r *RedisJWTHandler) decryptString(b64 string) (string, error) {
    data, err := base64.StdEncoding.DecodeString(b64)
    if err != nil {
        return "", err
    }
    key := deriveKey(r.encKey)
    block, err := aes.NewCipher(key)
    if err != nil {
        return "", err
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return "", err
    }
    ns := gcm.NonceSize()
    if len(data) < ns {
        return "", errors.New("ciphertext too short")
    }
    nonce, ct := data[:ns], data[ns:]
    pt, err := gcm.Open(nil, nonce, ct, nil)
    if err != nil {
        return "", err
    }
    return string(pt), nil
}
```

### 4.2 问题分析

**问题 A：每个请求的性能开销**

每个需要认证的 HTTP 请求都会：
1. 从 JWT 中取出加密密码（base64 字符串）
2. 执行 AES-GCM 解密（`deriveKey` → `aes.NewCipher` → `cipher.NewGCM` → `gcm.Open`）
3. 调用 gRPC `SaveUser` 将明文密码写回 user 服务

对于高频接口（如获取课表、查询成绩），这是不必要的性能瓶颈。

**问题 B：明文密码在内存中扩散**

用户的明文密码在**每个 HTTP 请求的生命周期内**都存在于内存中：
- JWT claims 中的 `UserClaims.Password`（加密态）
- `decryptString` 返回的明文字符串
- gRPC `SaveUserReq.Password` 参数

Go 的 GC 不会主动清零内存，这些字符串可能在堆上残留。

**问题 C：注释标注为临时逻辑**

代码中有明确的 TODO：*"临时逻辑,用于解决秘钥不统一的问题,后续需要删除"*。

但这段逻辑位于认证中间件（`bff/web/middleware/login.go:84-95`），是所有受保护请求的必经之路，影响面极大。

### 4.3 修复建议

密码应该只存储在 user 服务端，BFF 不应持有或传递密码。

1. **从 JWT claims 中移除 Password 字段**：JWT 只携带 `StudentId`、`Ssid`、`UserAgent`
2. **删除中间件中的解密 + 回写逻辑**：认证中间件只验证 JWT 签名和 session 有效性
3. **登录时的密码保存逻辑只在 `LoginByCCNU` 中执行一次**（`bff/web/user/user.go:87-90` 已有此逻辑）：

```go
// bff/web/user/user.go:86-90 — 登录时保存一次即可
_, err = h.userClient.SaveUser(ctx, &userv1.SaveUserReq{StudentId: req.StudentId, Password: req.Password})
if err != nil {
    return web.Response{}, errs.LOGIN_BY_CCNU_ERROR(err)
}
```

---

## 5. 问题四：JWT 无滑动过期

### 5.1 代码

**短 token 固定 1 小时过期**（`bff/web/ijwt/redis.go:113-130`）：

```go
func (r *RedisJWTHandler) SetJWTToken(ctx *gin.Context, cp ClaimParams) error {
    uc := UserClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour * 1)),
        },
        StudentId: cp.StudentId,
        Password:  cp.Password,
        Ssid:      cp.Ssid,
        UserAgent: cp.UserAgent,
    }
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, uc)
    tokenStr, err := token.SignedString(r.JWTKey())
    if err != nil {
        return err
    }
    ctx.Header("x-jwt-token", tokenStr)
    return nil
}
```

**长 token 固定 6 个月过期**（`bff/web/ijwt/redis.go:93-110`）：

```go
func (r *RedisJWTHandler) setRefreshToken(ctx *gin.Context, cp ClaimParams) error {
    rc := RefreshClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(r.rcExpiration)),
        },
        // ...
    }
    // ...
}
```

其中 `rcExpiration`（`bff/web/ijwt/redis.go:143`）：

```go
rcExpiration: time.Hour * 24 * 30 * 6, // 设置为六个月之后过期
```

### 5.2 问题分析

- 短 token 固定 1 小时过期，没有续期机制
- 用户活跃使用时，1 小时后短 token 过期，必须通过 refresh token 重新获取
- refresh token 接口（`bff/web/user/user.go:138-168`）只签发新的短 token，不刷新长 token 的过期时间
- 长 token 6 个月过期后，用户必须重新登录

这意味着：
- 活跃用户每小时都要经历一次 token 刷新（前端需要处理）
- 6 个月后所有用户都会被强制登出

### 5.3 修复建议

如果希望保持当前的双 token 架构：

1. **RefreshToken 时同时刷新长 token**：在 `bff/web/user/user.go:156-161` 中同时调用 `setRefreshToken` 和 `SetJWTToken`
2. **或者引入滑动过期**：在中间件中检测短 token 剩余有效期，低于阈值时自动续签

如果愿意简化：

3. **单 token + Redis 白名单**：短 token 过期时间设为 7 天，Redis 中存活跃 session 并续期 TTL，logout 时删除 Redis key

---

## 6. 问题五：`UserHandler` 通过内嵌 `ijwt.Handler` 暴露了过多能力

### 6.1 代码

`bff/web/user/user.go:20-24`：

```go
type UserHandler struct {
    ijwt.Handler
    userClient userv1.UserServiceClient
    preLoader  PreLoader
}
```

`bff/ioc/handler.go:86-96`：

```go
func InitUserHandler(
    l logger.Logger,
    hdl ijwt.Handler,
    userClient userv1.UserServiceClient,
    gradeClient gradev1.GradeServiceClient,
    classListClient classlistv1.ClasserClient,
    feedClient feedv1.FeedServiceClient,
) *user.UserHandler {
    preLoader := user.NewPreLoader(gradeClient, classListClient, feedClient, l)
    return user.NewUserHandler(hdl, userClient, preLoader)
}
```

### 6.2 问题分析

`UserHandler` 内嵌了完整的 `ijwt.Handler` 接口，意味着它暴露了 9 个方法：
`ClearToken`、`ExtractToken`、`SetLoginToken`、`SetJWTToken`、`CheckSession`、`JWTKey`、`RCJWTKey`、`EncKey`、`DecryptPasswordFromClaims`。

但 `UserHandler` 实际只使用了其中 4 个：
- `SetLoginToken`（LoginByCCNU）
- `ClearToken`（Logout、DeleteAccount）
- `ExtractToken`（RefreshToken）
- `CheckSession`（RefreshToken）

其余 5 个方法（`JWTKey`、`RCJWTKey`、`EncKey`、`SetJWTToken`、`DecryptPasswordFromClaims`）不应由 handler 层直接调用。

内嵌还导致 `UserHandler` 的方法集和 `ijwt.Handler` 的方法集混在一起，增加了后续重构的难度。

### 6.3 修复建议

将内嵌改为具名字段：

```go
type UserHandler struct {
    jwtHandler ijwt.Handler
    userClient userv1.UserServiceClient
    preLoader  PreLoader
}
```

或者进一步拆分接口，让 `UserHandler` 只依赖它需要的方法：

```go
type TokenManager interface {
    SetLoginToken(ctx *gin.Context, studentId string, password string) error
    ClearToken(ctx *gin.Context) error
    ExtractToken(ctx *gin.Context) string
}

type SessionChecker interface {
    CheckSession(ctx *gin.Context, ssid string) (bool, error)
}
```

---

## 7. 问题六：`DeleteAccount` 的身份验证逻辑不完整

### 7.1 代码

`bff/web/user/user.go:183-199`：

```go
func (h *UserHandler) DeleteAccount(ctx *gin.Context, req DeleteAccountReq, cla ijwt.UserClaims) (web.Response, error) {
    // todo:这里目前只是伪逻辑，具体的身份验证、软删除、恢复码、恢复码等需要后续实现
    // todo: 通过数据库比较输入和用户真正密码,目前仅是判断是否为空
    if cla.Password == "" {
        fmt.Println(req.Password, "---", cla.Password)
        return web.Response{}, errs.USER_SID_Or_PASSPORD_ERROR(errors.New("password do not match"))
    }

    err := h.ClearToken(ctx)
    if err != nil {
        return web.Response{}, errs.JWT_SYSTEM_ERROR(err)
    }

    return web.Response{
        Msg: "Success",
    }, nil
}
```

### 7.2 问题分析

1. **身份验证形同虚设**：只检查 `cla.Password == ""`，而 `cla.Password` 是从 JWT 中解密的加密密码，正常登录流程中不可能为空。所以这个条件永远为 false，任何已登录用户都能注销账户。
2. **没有实际删除用户数据**：注释标注了 todo，但注销账户应该至少执行软删除。
3. **`fmt.Println` 用于调试**：`fmt.Println(req.Password, "---", cla.Password)` 会将密码打印到 stdout，存在日志泄露风险。
4. **没有调用 user 服务的删除接口**：只清了本地 token，后端 user 服务的数据完全未受影响。

### 7.3 修复建议

1. 删除 `fmt.Println` 调试代码
2. 实现真正的身份验证：调用 user 服务验证 `req.Password` 是否与存储的密码匹配
3. 调用 user 服务执行账户软删除
4. 清除该用户的所有 session（包括其他设备上的）

---

## 8. 风险汇总表

| 问题 | 严重度 | 影响范围 | 涉及文件 |
|------|--------|----------|----------|
| `ClearToken` 混合 HTTP 与 session 管理 | 中 | 架构可维护性 | `ijwt/redis.go:47-58`, `ijwt/types.go:8-18` |
| `CheckSession` 语义反转 + Redis 故障误判 | 高 | 所有受保护请求 | `ijwt/redis.go:132-136`, `middleware/login.go:79-83`, `user/user.go:151-153` |
| 密码嵌入 JWT + 每请求解密回写 | 高 | 所有受保护请求的性能和安全 | `middleware/login.go:84-95`, `ijwt/redis.go:74-90, 151-166, 195-219` |
| JWT 无滑动过期 | 低 | 用户体验 | `ijwt/redis.go:113-130, 143` |
| `UserHandler` 内嵌暴露过多能力 | 中 | 代码可维护性 | `user/user.go:20-24`, `ioc/handler.go:86-96` |
| `DeleteAccount` 验证逻辑不完整 + 密码打印 | 高 | 账户安全 | `user/user.go:183-199` |

---

## 9. 修复优先级

| 优先级 | 改动 | 影响范围 |
|--------|------|----------|
| P0 | 删除 `DeleteAccount` 中的 `fmt.Println` 密码打印 | `user/user.go:187` |
| P0 | 删除中间件中每请求解密+回写的临时逻辑 | `middleware/login.go:84-95` |
| P1 | `CheckSession` 区分 Redis 错误和 session 失效，中间件降级放行 | `ijwt/redis.go:132-136`, `middleware/login.go:79-83`, `user/user.go:151-153` |
| P1 | 拆分 `ClearToken`：session 操作不依赖 `gin.Context` | `ijwt/redis.go:47-58`, `ijwt/types.go` |
| P2 | 切换到白名单模式（Redis 存有效 session） | `ijwt/redis.go` 整体重构 |
| P2 | `UserHandler` 取消内嵌，改为具名字段 | `user/user.go:20-24` |
| P3 | 从 JWT claims 中移除 Password 字段 | `ijwt/redis.go:151-166`, 需要 proto 配合 |
| P3 | 实现 `DeleteAccount` 的真正逻辑 | `user/user.go:183-199` |

## 跨主题链接

- [[华师匣子BFF结构]] — BFF 整体架构与代码分层
- [[BFF 取gRPC结构体字段风险报告]] — BFF gRPC 返回值空指针风险
- [[BFF JWT 中存储加密密码的安全性分析]] — 密码嵌入 JWT 的链路分析与修复路径
- [[BFF AES加密优化]] — cipher.AEAD 缓存优化（与本报告问题三相关）
- [[华师匣子]] — 项目总览
