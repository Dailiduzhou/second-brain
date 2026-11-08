---
category: ccnubox
type: deep-dive
topic: jwt-password-security
module: bff
status: seedling
tags:
  - ccnubox
  - ccnubox/bff
  - security/jwt
  - security/encryption
---

# BFF JWT 中存储加密密码的安全性分析

## 1. 背景：为什么需要密码？

### 1.1 业务场景

本项目是一个校园服务聚合应用（CCNU Box），需要代理学生访问华中师范大学（CCNU）的多个官方系统：

- **教务系统**：查询成绩、课表、考试安排等
- **图书馆系统**：座位预约、研讨间预约
- **其他校园服务**

这些官方系统**不支持 OAuth 或 Token 委托机制**，只接受学号+密码认证。因此系统必须：

1. 存储学生的明文密码（加密存储）
2. 在需要时解密密码，代理学生登录官方系统
3. 获取 Cookie/Token 后缓存使用

### 1.2 密码流转全链路

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              登录流程                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户 ──[明文密码]──> BFF                                                     │
│                      │                                                      │
│                      ├──[gRPC CheckUser]──> be-user ──[明文]──> CCNU教务验证  │
│                      │                                                      │
│                      ├──[gRPC SaveUser]──> be-user                          │
│                      │                              │                       │
│                      │                              ├── AES-CFB加密(be-user key)
│                      │                              └── 存入数据库           │
│                      │                                                      │
│                      ├── AES-GCM加密(bff key) ──> 写入JWT Claims            │
│                      │                                                      │
│                      └── 返回JWT给客户端                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         后续每个请求                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  客户端 ──[JWT]──> BFF Middleware                                            │
│                     │                                                       │
│                     ├── 解析JWT，提取加密密码                                 │
│                     ├── AES-GCM解密(bff key) ──> 明文密码                    │
│                     ├── [gRPC SaveUser] ──> be-user                         │
│                     │                              │                        │
│                     │                              ├── AES-CFB加密(be-user key)
│                     │                              └── 更新数据库            │
│                     │                                                       │
│                     └── 继续处理请求                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    需要访问CCNU系统时（如获取成绩）                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BFF ──[gRPC GetGradeByTerm]──> be-grade ──[gRPC GetCookie]──> be-user      │
│                                                               │             │
│                                                  从数据库读取加密密码          │
│                                                               │             │
│                                                  AES-CFB解密(be-user key)   │
│                                                               │             │
│                                                  ──[明文密码]──> CCNU教务     │
│                                                               │             │
│                                                  <──[Cookie]── CCNU教务     │
│                                                               │             │
│                                                  缓存Cookie到Redis           │
│                                                               │             │
│                                                  <──[Cookie]── 返回给BFF    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 关键代码引用

**BFF 登录时加密密码写入 JWT**（`bff/web/ijwt/redis.go:74-90`）：

```go
func (r *RedisJWTHandler) SetLoginToken(ctx *gin.Context, studentId string, password string) error {
    enPassword, err := r.encryptString(password)  // AES-GCM 加密，使用 BFF 的 encKey
    if err != nil {
        return err
    }
    cp := ClaimParams{
        StudentId: studentId,
        Password:  enPassword,  // 加密后的密码写入 claims
        Ssid:      uuid.New().String(),
        UserAgent: ctx.GetHeader("User-Agent"),
    }
    // ...
}
```

**BFF 的 AES-GCM 加密实现**（`bff/web/ijwt/redis.go:174-192`）：

```go
func (r *RedisJWTHandler) encryptString(plain string) (string, error) {
    key := deriveKey(r.encKey)  // SHA256 派生 32 字节 key
    block, err := aes.NewCipher(key)
    // ...
    gcm, err := cipher.NewGCM(block)  // GCM 模式
    // ...
}
```

**be-user 的 AES-CFB 加密实现**（`be-user/pkg/crypto/crypto.go:26-43`）：

```go
func (c *Crypto) Encrypt(plaintext string) (string, error) {
    block, err := aes.NewCipher(c.key)  // 使用 be-user 自己的 key
    // ...
    stream := cipher.NewCFBEncrypter(block, iv)  // CFB 模式
    stream.XORKeyStream(ciphertext[aes.BlockSize:], []byte(plaintext))
    // ...
}
```

**中间件每请求解密并回写**（`bff/web/middleware/login.go:84-95`）：

```go
password, err := m.handler.DecryptPasswordFromClaims(&uc)
if err != nil {
    return ijwt.UserClaims{}, errorx.Errorf("解密失败:%w", err)
}
// TODO 临时逻辑,用于解决秘钥不统一的问题,后续需要删除
_, err = m.userClient.SaveUser(ctx, &userv1.SaveUserReq{
    StudentId: uc.StudentId,
    Password:  password,  // 明文密码传给 be-user
})
```

**be-user 收到明文密码后重新加密存储**（`be-user/service/user.go:57-86`）：

```go
func (s *userService) Save(ctx context.Context, studentId string, password string) error {
    // 密码加密
    encryptedPwd, err := s.cryptoClient.Encrypt(password)  // 用 be-user 的 key 加密
    if err != nil {
        return ENCRYPT_ERROR(...)
    }
    // ... 存入数据库
}
```

---

## 2. 为什么密码要放在 JWT Claims 里？

### 2.1 直接原因：密钥不统一

代码注释明确说明（`bff/web/middleware/login.go:88`）：

```go
// TODO 临时逻辑,用于解决秘钥不统一的问题,后续需要删除
```

**问题本质**：BFF 和 be-user 使用**不同的加密密钥和加密模式**：

| 组件 | 加密模式 | 密钥来源 |
|------|----------|----------|
| BFF | AES-GCM | `cfg.JWT.EncKey` |
| be-user | AES-CFB | be-user 自己的配置 |

由于密钥不统一：
- BFF 无法直接读取 be-user 数据库中加密的密码
- be-user 无法解密 BFF 传来的加密密码

**临时解决方案**：BFF 在每次请求时，从 JWT 中解密出明文密码，传给 be-user 重新加密存储。

### 2.2 为什么不在登录时一次性解决？

理论上，登录时 BFF 已经调用了 `SaveUser` 将密码存入 be-user 数据库（`bff/web/user/user.go:87-90`）：

```go
// 更新用户账号密码
_, err = h.userClient.SaveUser(ctx, &userv1.SaveUserReq{StudentId: req.StudentId, Password: req.Password})
```

但问题在于：
1. **密码可能变更**：学生在 CCNU 官方系统修改密码后，本地数据库的密码就失效了
2. **多设备登录**：学生在不同设备登录，JWT 中的密码可以作为"最新密码"的来源
3. **历史遗留**：早期设计可能没有考虑密钥统一问题，后来发现不兼容，用 JWT 传递明文作为 workaround

### 2.3 为什么不用 Session 存储？

另一种方案是将密码存储在 Redis Session 中，而不是 JWT：

```go
// 假设的方案
redis.Set(ctx, "session:"+ssid+":password", encryptedPassword, expiration)
```

但当前设计选择 JWT 的可能原因：
1. **无状态**：JWT 自包含，不需要依赖 Redis 读取密码
2. **跨服务传递**：JWT 可以在多个服务间传递，不需要共享 Redis
3. **简化架构**：避免在 Redis 中存储敏感数据

---

## 3. 安全性分析

### 3.1 JWT 中存储加密密码的风险

| 风险 | 严重度 | 说明 |
|------|--------|------|
| JWT 泄露导致密码泄露 | **高** | JWT 通常存储在浏览器 localStorage 或 Cookie 中，XSS 攻击可窃取 |
| 密码在内存中扩散 | **中** | 每次请求都解密，明文密码在 Go 堆上残留，GC 不会主动清零 |
| 日志泄露 | **中** | 如果日志记录了 JWT 或 claims，密码会被记录 |
| 长期有效 | **高** | Refresh Token 6 个月有效，期间密码一直可被提取 |

### 3.2 与替代方案对比

| 方案 | 安全性 | 复杂度 | 说明 |
|------|--------|--------|------|
| **当前方案**：JWT 存加密密码 | 中 | 低 | 密码随 JWT 流转，每次请求解密 |
| Session 存储 | 高 | 中 | 密码存 Redis，JWT 只存 Session ID |
| 统一密钥 | 高 | 低 | BFF 和 be-user 用相同密钥，直接读数据库 |
| 密码不离开 be-user | 最高 | 高 | BFF 不接触密码，be-user 提供完整代理服务 |

### 3.3 当前方案的安全边界

尽管存在风险，当前方案在以下前提下是可接受的：

1. **HTTPS 强制**：所有通信必须加密，防止中间人窃取 JWT
2. **JWT 存储安全**：客户端应使用 httpOnly Cookie 而非 localStorage
3. **日志脱敏**：确保 JWT 和密码不被记录到日志
4. **短期 Refresh Token**：6 个月的有效期相对较长，建议缩短

---

## 4. 必要性分析

### 4.1 当前方案的必要性

**结论：当前方案不是必要的，是历史遗留的临时方案。**

代码中的 TODO 注释已经明确表明这是临时逻辑：

```go
// TODO 临时逻辑,用于解决秘钥不统一的问题,后续需要删除
```

### 4.2 根本问题：密钥不统一

真正需要解决的是 BFF 和 be-user 的密钥不统一问题。

**当前状态**：
- BFF 用 AES-GCM + `encKey` 加密
- be-user 用 AES-CFB + 自己的 `key` 加密

**解决方案**：

#### 方案 A：统一密钥和加密模式（推荐）

让 BFF 和 be-user 使用相同的密钥和加密模式：

1. 在配置中心或环境变量中共享密钥
2. 统一使用 AES-GCM（更安全）
3. BFF 直接读取 be-user 数据库中的加密密码，或 be-user 提供解密接口

#### 方案 B：密码不离开 be-user

让 be-user 完全管理密码，BFF 不接触明文密码：

1. 登录时 BFF 将明文密码传给 be-user，be-user 加密存储
2. BFF 不再在 JWT 中存储密码
3. 需要密码时（如获取 Cookie），BFF 调用 be-user 的 gRPC 接口
4. be-user 内部解密并使用密码，不返回明文给 BFF

当前 be-user 的 `GetCookie` 接口已经是这种模式（`be-user/service/user.go:126-161`）：

```go
func (s *userService) GetCookie(ctx context.Context, studentId string, tpe ...string) (string, error) {
    // ...
    user, err := s.dao.FindByStudentId(ctx, studentId)
    // ...
    decryptPassword, err := s.cryptoClient.Decrypt(user.Password)  // be-user 内部解密
    // ...
    resp, err := tool.Retry(func() (*ccnuv1.GetXKCookieResponse, error) {
        req := &ccnuv1.GetXKCookieRequest{StudentId: user.StudentId, Password: decryptPassword}
        return s.ccnu.GetXKCookie(ctx, req)
    })
    // ...
}
```

**问题在于**：中间件的"每请求回写"逻辑是多余的，因为登录时已经保存了密码。

---

## 5. 修复建议

### 5.1 短期：删除中间件中的临时逻辑

既然登录时已经保存了密码（`bff/web/user/user.go:87-90`），中间件中的每请求回写是多余的：

**删除** `bff/web/middleware/login.go:84-95`：

```go
// 删除这段代码
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

### 5.2 中期：从 JWT Claims 中移除密码

1. 修改 `UserClaims` 和 `RefreshClaims`，移除 `Password` 字段
2. 修改 `SetLoginToken`，不再加密密码写入 JWT
3. 客户端不再在 JWT 中携带密码

### 5.3 长期：统一密钥管理

1. 引入统一的密钥管理服务（如 Vault）
2. BFF 和 be-user 从密钥管理服务获取相同的密钥
3. 或者让 be-user 完全管理密码，BFF 不接触密码

---

## 6. 总结

| 问题 | 答案 |
|------|------|
| **为什么把加密密码放进 Claims？** | 临时方案，用于解决 BFF 和 be-user 密钥不统一的问题 |
| **项目需要 Claims 里的密码吗？** | 不需要。登录时已保存密码，中间件的回写是多余的 |
| **安全性如何？** | 中等风险。JWT 泄露会导致密码泄露，但 HTTPS + httpOnly Cookie 可缓解 |
| **必要性如何？** | 不必要。是历史遗留的临时方案，应该删除 |

**推荐修复顺序**：

1. **P0**：删除中间件中的每请求回写逻辑（`bff/web/middleware/login.go:84-95`）
2. **P1**：从 JWT Claims 中移除 Password 字段
3. **P2**：统一 BFF 和 be-user 的密钥管理

## 跨主题链接

- [[BFF JWT部分耦合过重]] — JWT/Session 耦合问题总览（包含密码嵌入 JWT 问题）
- [[华师匣子BFF结构]] — BFF 整体架构与代码分层
- [[华师匣子]] — 项目总览
