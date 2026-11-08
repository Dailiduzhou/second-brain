---
category: ccnubox
type: optimization
topic: crypto
module: bff
status: done
tags:
  - ccnubox
  - ccnubox/bff
  - ccnubox/crypto
  - ccnubox/perf
---

# BFF 密码加解密 cipher.AEAD 缓存优化

## 1. 背景

`bff/web/ijwt/redis.go` 中的 `encryptString` 和 `decryptString` 方法在每次调用时都重新构建 AES cipher 和 GCM 结构体。由于这两个方法在认证中间件中被每个受保护请求调用（`bff/web/middleware/login.go:84` → `DecryptPasswordFromClaims` → `decryptString`），重复构建带来了不必要的性能开销。

### 1.1 调用链路

```
每个受保护请求
    │
    └── bff/web/middleware/login.go:84
            │
            └── m.handler.DecryptPasswordFromClaims(&uc)
                    │
                    └── bff/web/ijwt/redis.go:222-227
                            │
                            └── r.decryptString(uc.Password)
                                    │
                                    ├── deriveKey(r.encKey)        // 每次重算
                                    ├── aes.NewCipher(key)         // 每次重建
                                    └── cipher.NewGCM(block)       // 每次重建
```

### 1.2 当前代码

`bff/web/ijwt/redis.go:174-219`：

```go
// encryptString 每次调用都重建 cipher 和 GCM
func (r *RedisJWTHandler) encryptString(plain string) (string, error) {
    key := deriveKey(r.encKey)           // SHA256 — 输入不变，结果永远相同
    block, err := aes.NewCipher(key)     // AES 密钥扩展 — 输入不变，结果永远相同
    if err != nil {
        return "", err
    }
    gcm, err := cipher.NewGCM(block)     // 堆分配 — 输入不变，结果永远相同
    if err != nil {
        return "", err
    }
    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return "", err
    }
    ct := gcm.Seal(nil, nonce, []byte(plain), nil)
    out := append(nonce, ct...)
    return base64.StdEncoding.EncodeToString(out), nil
}

func (r *RedisJWTHandler) decryptString(b64 string) (string, error) {
    data, err := base64.StdEncoding.DecodeString(b64)
    if err != nil {
        return "", err
    }
    key := deriveKey(r.encKey)           // 同上
    block, err := aes.NewCipher(key)     // 同上
    if err != nil {
        return "", err
    }
    gcm, err := cipher.NewGCM(block)     // 同上
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

---

## 2. 性能开销分析

### 2.1 各步骤开销

| 操作 | 代码位置 | 开销量级 | 是否可缓存 | 原因 |
|------|----------|----------|-----------|------|
| `deriveKey(r.encKey)` | `redis.go:176, 200` | ~200-400 ns（SHA256） | **是** | `r.encKey` 在 `RedisJWTHandler` 生命周期内不变 |
| `aes.NewCipher(key)` | `redis.go:177, 201` | ~50-100 ns（AES-256 密钥扩展，生成 60 个 32 字节轮密钥） | **是** | key 不变，扩展结果不变 |
| `cipher.NewGCM(block)` | `redis.go:181, 205` | ~100-200 ns + 一次堆分配 | **是** | block 不变，GCM 结构体无状态 |
| `gcm.Seal` / `gcm.Open` | `redis.go:189, 214` | 真正的加解密运算，与数据长度成正比 | **否** | 每次 nonce/密文不同 |

### 2.2 单次请求的额外开销

每次请求在加解密之前，额外执行：

```
deriveKey:     ~300 ns
aes.NewCipher: ~80 ns
NewGCM:        ~150 ns + 1 次堆分配（GC 压力）
─────────────────────────
合计:          ~530 ns + 1 次堆分配
```

### 2.3 高并发场景下的累积开销

假设 QPS = 1000，每次请求调用一次 `decryptString`：

```
CPU 时间:  1000 × 530 ns = 530 μs/s（约 0.05% CPU 核）
堆分配:    1000 次/s → GC 扫描压力
```

绝对值不大，但这是**完全可以避免的浪费**，且改动成本极低。

---

## 3. 改进方案

### 3.1 在 `RedisJWTHandler` 结构体中缓存 `cipher.AEAD`

**修改结构体**（`bff/web/ijwt/redis.go:22-30`）：

```go
type RedisJWTHandler struct {
    cmd           redis.Cmdable
    signingMethod jwt.SigningMethod
    rcExpiration  time.Duration
    jwtKey        []byte
    rcJWTKey      []byte
    encKey        []byte
    aead          cipher.AEAD   // 新增：初始化时构建，后续复用
}
```

**修改构造函数**（`bff/web/ijwt/redis.go:139-148`）：

```go
func NewRedisJWTHandler(cmd redis.Cmdable, jwtKey string, rcJWTKey string, encKey string) Handler {
    key := deriveKey([]byte(encKey))
    block, err := aes.NewCipher(key)
    if err != nil {
        panic(fmt.Sprintf("初始化 AES cipher 失败: %v", err))
    }
    aead, err := cipher.NewGCM(block)
    if err != nil {
        panic(fmt.Sprintf("初始化 GCM 失败: %v", err))
    }

    return &RedisJWTHandler{
        cmd:           cmd,
        signingMethod: jwt.SigningMethodHS256,
        rcExpiration:  time.Hour * 24 * 30 * 6,
        jwtKey:        []byte(jwtKey),
        rcJWTKey:      []byte(rcJWTKey),
        encKey:        []byte(encKey),
        aead:          aead,
    }
}
```

**简化 `encryptString`**（`bff/web/ijwt/redis.go:174-192`）：

```go
func (r *RedisJWTHandler) encryptString(plain string) (string, error) {
    nonce := make([]byte, r.aead.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return "", err
    }
    ct := r.aead.Seal(nil, nonce, []byte(plain), nil)
    out := append(nonce, ct...)
    return base64.StdEncoding.EncodeToString(out), nil
}
```

**简化 `decryptString`**（`bff/web/ijwt/redis.go:194-219`）：

```go
func (r *RedisJWTHandler) decryptString(b64 string) (string, error) {
    data, err := base64.StdEncoding.DecodeString(b64)
    if err != nil {
        return "", err
    }
    ns := r.aead.NonceSize()
    if len(data) < ns {
        return "", errors.New("ciphertext too short")
    }
    nonce, ct := data[:ns], data[ns:]
    pt, err := r.aead.Open(nil, nonce, ct, nil)
    if err != nil {
        return "", err
    }
    return string(pt), nil
}
```

---

## 4. 改进理由

### 4.1 安全性

`cipher.AEAD` 的 `Seal` 和 `Open` 方法是**无状态的**：

- nonce 由调用方提供，不修改内部状态
- 不持有可变字段
- Go 标准库文档明确说明并发安全

缓存 `cipher.AEAD` 不会引入任何安全风险。

### 4.2 性能收益

| 维度 | 改进前 | 改进后 |
|------|--------|--------|
| 每次请求的固定开销 | ~530 ns + 1 次堆分配 | ~0（初始化时一次性完成） |
| 初始化时开销 | 0 | ~530 ns（仅一次） |
| 堆分配 | 每次请求 1 次 | 无额外分配 |
| GC 压力 | 持续产生短生命周期对象 | 无 |

### 4.3 改动量

| 文件 | 改动 |
|------|------|
| `bff/web/ijwt/redis.go` | 结构体加 1 个字段，构造函数加 ~8 行，`encryptString` 删 3 行，`decryptString` 删 3 行 |

### 4.4 风险

极低。初始化失败时 panic，与项目中 `NewGrpcClient`（`common/bizpkg/grpc/client/client.go:42`）的处理方式一致：

```go
if err != nil {
    panic(fmt.Sprintf("连接服务 %s 失败: %v", cfg.Name, err))
}
```

### 4.5 总结

| 维度 | 评估 |
|------|------|
| 安全性 | 完全安全，`cipher.AEAD` 无状态，并发安全 |
| 性能收益 | 每请求省 ~530 ns + 1 次堆分配 |
| 改动量 | 极小，约 10 行 |
| 风险 | 极低，初始化 panic 与项目现有风格一致 |

## 跨主题链接

- [[BFF JWT部分耦合过重]] — JWT/Session 耦合问题（含 `encryptString` / `decryptString` 原始代码定位）
- [[BFF JWT 中存储加密密码的安全性分析]] — 密码嵌入 JWT 的安全性与必要性分析
- [[华师匣子BFF结构]] — BFF 整体架构与代码分层
- [[华师匣子]] — 项目总览
