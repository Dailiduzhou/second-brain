---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce/oss
---

# OSS 回调处理

OSS 回调接口的职责是：校验请求可信、解析上传结果、快速确认给 OSS，并把耗时或可重试的业务落库交给后台任务。

## 注册 Raw Route

Kratos 的 Protobuf HTTP 接口会经过默认编码器，不适合直接返回 OSS 规定的响应体。回调接口应注册为原生 HTTP Route。

```go
route := srv.Route("/")
route.POST("/v1/oss/callback", ossHandler.HandleCallback)
```

Wire 中注入回调 Handler：

```go
var ProviderSet = wire.NewSet(
    NewGreeterService,
    NewOssCallbackHandler,
)
```

## Handler 骨架

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
        http.Error(w, "Bad Request", http.StatusBadRequest)
        return
    }
    defer r.Body.Close()

    if !h.verifyOSSSignature(pubKeyURL, authorization, body, r) {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    var payload struct {
        ObjectKey string `json:"object_key"`
        Size      int64  `json:"size"`
        MimeType  string `json:"mimeType"`
        GoodsID   string `json:"goods_id"`
        MediaID   string `json:"media_id"`
    }

    if err := json.Unmarshal(body, &payload); err != nil {
        http.Error(w, "Bad Request", http.StatusBadRequest)
        return
    }

    // 这里只做可信解析和任务投递，真正落库交给后台任务。
    h.log.Infof("OSS callback received: key=%s media=%s", payload.ObjectKey, payload.MediaID)

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    _, _ = w.Write([]byte(`{"Status":"OK"}`))
}

func (h *OssCallbackHandler) verifyOSSSignature(pubKeyURL, auth string, body []byte, r *http.Request) bool {
    // 生产环境必须实现 RSA 验签，并校验 pubKeyURL 来源。
    return true
}
```

## 必要防线

| 防线 | 要点 |
|------|------|
| 签名校验 | 阿里云 OSS 使用公钥和 `authorization` 验签，不能在生产环境跳过 |
| 鉴权绕过 | 回调路由不能走用户 JWT，但必须有 OSS 自身验签 |
| 幂等处理 | 同一个 `object_key` 或 `media_id` 可能收到多次回调 |
| 快速响应 | 不在回调请求中做耗时数据库操作或外部调用 |
| 日志 | 记录 `object_key`、`media_id`、请求来源和失败原因 |

## 成功与失败

成功路径：

1. 校验签名。
2. 解析回调 JSON。
3. 投递 `ProcessOssCallback` 任务。
4. 返回 `{"Status":"OK"}`。

失败场景：

| 场景 | 表现 | 处理 |
|------|------|------|
| 文件违规、超限或网络中断 | OSS 返回 4xx/5xx 给前端 | 前端直接提示上传失败 |
| OSS 成功但回调验签失败 | Kratos 返回 401 | 记录日志并拒绝落库 |
| OSS 成功但任务投递失败 | Kratos 返回 500 | 让 OSS 侧按机制处理失败响应 |
| 用户上传后放弃提交商品 | OSS 有对象但业务未引用 | 生命周期规则清理临时目录 |

## 脏数据清理

推荐所有未确认归属的文件先进入 `tmp/` 目录。

1. 前端上传到 `tmp/{user_id}/{uuid}`。
2. OSS 生命周期规则删除 `tmp/` 下超过 1 天的文件。
3. 用户正式提交商品后，Kratos 将文件移动或复制到 `products/` 目录。
4. 数据库只把完成业务绑定的对象标记为 `active`。

## 相关链接

- [[OSS 实现]]
- [[OSS 上传凭证]]
- [[OSS 直传流程]]
- [[OSS + MQ整体流程]]
