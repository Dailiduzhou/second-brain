---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce
  - ecommerce/oss
---
# OSS 回调处理

## 注册原生路由（绕过 Protobuf）

最优雅的方式是直接在 HTTP Server 上注册原生路由（Raw Route），避免被 Kratos 默认 ResponseEncoder 包装。

### 回调 Handler

在 `internal/service/oss_callback.go` 中：

```go
package service

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-kratos/kratos/v2/log"
)

type OssCallbackHandler struct {
	log *log.Helper
}

func NewOssCallbackHandler(logger log.Logger) *OssCallbackHandler {
	return &OssCallbackHandler{log: log.NewHelper(logger)}
}

func (h *OssCallbackHandler) HandleCallback(w http.ResponseWriter, r *http.Request) {
	pubKeyURL := r.Header.Get("x-oss-pub-key-url")
	authorization := r.Header.Get("authorization")

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.log.Errorf("读取 OSS 回调 Body 失败: %v", err)
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	if !h.verifyOSSSignature(pubKeyURL, authorization, string(body), r) {
		h.log.Errorf("OSS 回调签名验证失败")
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var callbackData struct {
		ObjectKey string `json:"object_key"`
		Size      int64  `json:"size"`
		MimeType  string `json:"mimeType"`
		GoodsID   string `json:"goods_id"`
	}

	if err := json.Unmarshal(body, &callbackData); err != nil {
		h.log.Errorf("解析 OSS 回调数据失败: %v", err)
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	// 业务落地 + 幂等性校验
	h.log.Infof("OSS 文件上传成功, Key: %s, 归属商品: %s", callbackData.ObjectKey, callbackData.GoodsID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"Status":"OK"}`))
}

func (h *OssCallbackHandler) verifyOSSSignature(pubKeyURL, auth, body string, r *http.Request) bool {
	// 生产环境务必实现 RSA 验签
	return true
}
```

### 挂载到 HTTP Server

在 `internal/server/http.go` 中：

```go
route := srv.Route("/")
route.POST("/v1/oss/callback", ossHandler.HandleCallback)
```

### Wire 注入

```go
var ProviderSet = wire.NewSet(
    NewGreeterService,
    NewOssCallbackHandler, // 加入这一行
)
```

## 架构避坑指南

1. **Callback Body 格式：** 生成 Policy 时定义 `callbackBody` 为 JSON（`application/json`），带上自定义参数如 `x:goods_id`
2. **公网可达：** `/v1/oss/callback` 必须暴露公网，且不能被 JWT/鉴权 Middleware 拦截
3. **幂等处理：** 网络重试可能导致 OSS 多次回调，入库逻辑必须幂等

## 上传成功与失败处理

### 成功流程

- **Kratos 侧：** 校验 RSA 签名 → 解析回调数据 → 幂等入库 → 返回 `{"Status":"OK"}`
- **前端侧：** 收到 HTTP 200 → 展示缩略图/预览 → 暂存 Object Key

### 失败场景

| 场景 | 表现 | 处理 |
|------|------|------|
| 文件违规/超限/网络中断 | OSS 返回 4xx/5xx | 前端直接捕获异常提示用户 |
| OSS 成功但 Kratos 回调失败 | Kratos 返回非 200 | OSS 透传错误给前端 |

## 脏数据清理（垃圾回收）

**痛点：** 用户上传后放弃发布商品，OSS 留下孤儿文件产生费用。

**方案：**
1. 前端统一上传到 OSS `tmp/` 目录
2. OSS 控制台配置**生命周期（Lifecycle）规则**：自动删除 `tmp/` 下超过 1 天的文件
3. 用户正式提交商品时，Kratos 将文件从 `tmp/` 拷贝/移动到 `products/` 目录

## 相关链接

- [[OSS 实现]]
- [[OSS 上传凭证]]
- [[OSS 直传流程]]
