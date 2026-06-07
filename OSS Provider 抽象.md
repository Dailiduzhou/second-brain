---
category: ecommerce
type: object-storage
topic: oss
frameworks:
  - go-kratos
status: seedling
tags:
  - ecommerce/oss
  - microservice/go-kratos
---

# OSS Provider 抽象

对象存储实现应放在统一接口后面，业务层只依赖 `OSSProvider`，避免把 MinIO、阿里云 OSS 或腾讯云 COS 的 SDK 细节扩散到业务代码。

## 统一接口

```go
package biz

import (
    "context"
    "net/http"
)

type UploadPolicy struct {
    URL       string            `json:"url"`
    ObjectKey string            `json:"object_key"`
    FormData  map[string]string `json:"form_data"`
}

type CallbackPayload struct {
    ObjectKey string
    Size      int64
    MimeType  string
    MediaID   string
    GoodsID   string
}

type OSSProvider interface {
    GeneratePostPolicy(ctx context.Context, objectKey string) (*UploadPolicy, error)
    ParseCallback(ctx context.Context, r *http.Request) (*CallbackPayload, error)
    DeleteObject(ctx context.Context, objectKey string) error
}
```

## Provider 工厂

```go
func NewOSSProvider(c *conf.Bootstrap) biz.OSSProvider {
    switch c.Storage.Provider {
    case conf.Storage_MINIO:
        return NewMinioProvider(c.Storage)
    case conf.Storage_ALIYUN_OSS:
        return NewAliyunProvider(c.Storage)
    default:
        return NewMinioProvider(c.Storage)
    }
}
```

Wire 中只暴露工厂，不让业务层感知具体 SDK：

```go
var ProviderSet = wire.NewSet(
    NewData,
    NewOSSProvider,
    NewOssRepo,
)
```

## MinIO 实现关注点

- 使用 `minio-go` 初始化客户端。
- 使用 `PresignedPostPolicy` 生成表单上传数据。
- 使用 Bucket Notification 接收异步 Webhook。
- 用配置中的 `webhook_token` 校验本地回调来源。

## 阿里云 OSS 实现关注点

- 使用阿里云 SDK 生成 PostPolicy 和签名。
- 在 Policy 中写入同步回调配置。
- 回调 Handler 必须实现 RSA 验签。
- 响应体需要符合阿里云 OSS 对回调成功的要求。

## 相关链接

- [[OSS 实现]]
- [[测试用OSS]]
- [[OSS 本地 MinIO 环境]]
- [[OSS 回调语义差异]]
