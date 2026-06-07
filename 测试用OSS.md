---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce
  - ecommerce/oss
---
## 使用兼容的本地Docker容器替代
`MinIO`  是一个极佳的选择，它的 API 与 AWS S3 完全兼容，这意味着你现在写的代码，未来无论是切换到阿里云 OSS 还是腾讯云 COS，几乎都能做到无缝迁移。
## 配置
使用`docker-compose.dev.yml` ，配置存储桶，跨域和Webhook。
```yaml
version: '3.8'

services:
  # 1. MinIO 主服务
  minio:
    image: minio/minio:latest
    container_name: minio_dev
    ports:
      - "9000:9000" # API 端口
      - "9001:9001" # 控制台端口
    environment:
      MINIO_ROOT_USER: "admin"
      MINIO_ROOT_PASSWORD: "password123"
      # 【跨域配置】直接通过环境变量允许所有跨域请求，前端直传不再报错
      MINIO_API_CORS_ALLOW_ORIGIN: "*"
      # 【Webhook 回调配置】定义一个名为 kratos 的 webhook 目标
      MINIO_NOTIFY_WEBHOOK_ENABLE_kratos: "on"
      # 注意：如果是本机直接起 Kratos，这里填宿主机的 IP 或 host.docker.internal
      MINIO_NOTIFY_WEBHOOK_ENDPOINT_kratos: "http://host.docker.internal:8000/api/v1/oss/webhook"
    command: server /data --console-address ":9001"
    # 纯Linux环境需要配置 extra_hosts
    extra_hosts: - "host.docker.internal:host-gateway"
    volumes:
      - ./data/minio:/data
    restart: unless-stopped

  # 2. MinIO 初始化容器 (执行完命令后会自动销毁)
  minio-init:
    image: minio/mc:latest
    container_name: minio_init
    depends_on:
      - minio
    entrypoint: >
      /bin/sh -c "
      echo '等待 MinIO 启动...';
      # 1. 持续尝试连接 MinIO，直到连接成功
      until (/usr/bin/mc config host add myminio http://minio:9000 admin password123); do
        sleep 1;
      done;
      echo 'MinIO 已连接，开始自动初始化...';
      
      # 2. 创建存储桶 (如果存在则忽略)
      /usr/bin/mc mb myminio/ecommerce-assets --ignore-existing;
      
      # 3. 设置存储桶为 public，允许前端直接使用 URL 读取图片
      /usr/bin/mc anonymous set download myminio/ecommerce-assets;
      
      # 4. 将存储桶的 PUT(上传) 事件绑定到刚才配置的 kratos webhook 上
      /usr/bin/mc event add myminio/ecommerce-assets arn:minio:sqs::kratos:webhook --event put;
      
      echo 'MinIO 初始化完成！容器退出。';
      exit 0;
      "
```
## 环境区分
`conf.proto`
```protobuf
syntax = "proto3";
package kratos.api;

// ... 其他配置

message Storage {
    enum ProviderType {
        MINIO = 0;
        ALIYUN_OSS = 1;
        TENCENT_COS = 2;
    }
    ProviderType provider = 1;  // 决定使用哪个底层实现
    string endpoint = 2;
    string access_key = 3;
    string secret_key = 4;
    string bucket = 5;
    string role_arn = 6;        // 阿里云 STS 临时凭证可能需要
}
```
采用不同的`Adapter` 来对接不同服务。
```go
// minio
type minioProvider struct {
    client *minio.Client
    bucket string
}

func NewMinioProvider(c *conf.Storage) biz.OSSProvider {
    // 初始化 MinIO client ...
    return &minioProvider{client: client, bucket: c.Bucket}
}

func (m *minioProvider) GetUploadToken(ctx context.Context, filename string) (string, error) {
    // 调用 minio SDK 生成 URL
}

// 阿里云
type aliyunProvider struct {
    client *oss.Client
    bucket string
}

func NewAliyunProvider(c *conf.Storage) biz.OSSProvider {
    // 初始化 Aliyun OSS client ...
    return &aliyunProvider{client: client, bucket: c.Bucket}
}

func (m *aliyunProvider) GetUploadToken(ctx context.Context, filename string) (string, error) {
    // 调用阿里云 SDK (STS) 生成凭证
}
```
DI中区分不同提供者
```go
import "github.com/google/wire"

// ProviderSet 告诉 Wire 注入规则
var ProviderSet = wire.NewSet(NewData, NewOSSProvider)

// NewOSSProvider 工厂方法
func NewOSSProvider(c *conf.Bootstrap) biz.OSSProvider {
    switch c.Storage.Provider {
    case conf.Storage_MINIO:
        return NewMinioProvider(c.Storage)
    case conf.Storage_ALIYUN_OSS:
        return NewAliyunProvider(c.Storage)
    default:
        // 默认兜底使用 MinIO
        return NewMinioProvider(c.Storage)
    }
}
```

## 回调设计核心差异
先澄清一个**核心差异**，以避免在测试环境和生产环境之间踩坑：
- **阿里云 OSS 回调（同步）**：前端上传完文件后，阿里云服务器会**同步**请求你的后端业务接口，拿到你后端的返回结果后，再把完整的 HTTP 响应给前端。
- **MinIO 回调（异步 Webhook）**：MinIO 不支持这种同步请求。MinIO 的机制是**事件驱动（Bucket Notifications）**。前端上传完毕后立即收到成功响应，随后 MinIO 触发 Webhook，**异步**通知你的后端。

### 第一步：配置定义 (Configuration)
首先在 Kratos 的 `internal/conf/conf.proto` 中定义 MinIO 的配置，并生成对应的 go 代码。

```protobuf
// internal/conf/conf.proto
syntax = "proto3";
package kratos.api;

option go_package = "your_project/internal/conf;conf";

message Data {
  message Minio {
    string endpoint = 1;
    string access_key = 2;
    string secret_key = 3;
    bool use_ssl = 4;
    string bucket = 5;
    string webhook_token = 6; // 用于回调验签的 Token
  }
  Minio minio = 1;
}

```

### 第二步：Data 层与严格 DI 注入 (`internal/data`)
在 `data` 层初始化 MinIO 客户端，并将其加入到 Wire 的 ProviderSet 中。
**1. 初始化 MinIO 客户端与 Provider ( internal/data/data.go )**

```go
package data

import (
	"context"
	"github.com/google/wire"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"your_project/internal/conf"
)

// ProviderSet is data providers.
var ProviderSet = wire.NewSet(NewData, NewMinioClient, NewOssRepo)

type Data struct {
	// ... 其他 DB, Redis 客户端
	Minio *minio.Client
}

// 严格使用 DI 初始化 MinIO
func NewMinioClient(c *conf.Data) (*minio.Client, error) {
	client, err := minio.New(c.Minio.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(c.Minio.AccessKey, c.Minio.SecretKey, ""),
		Secure: c.Minio.UseSsl,
	})
	if err != nil {
		return nil, err
	}
	return client, nil
}

func NewData(minioClient *minio.Client) (*Data, func(), error) {
	cleanup := func() {
		// cleanup logic if needed
	}
	return &Data{Minio: minioClient}, cleanup, nil
}

```
**2. 实现 Repository ( internal/data/oss.go )**
在这里实现生成直传策略（Post Policy）的逻辑。相比于直接生成 URL，Post Policy 更接近阿里云 OSS 的表单上传机制。

```go
package data

import (
	"context"
	"time"
	"github.com/minio/minio-go/v7"
	"your_project/internal/biz"
	"your_project/internal/conf"
)

type ossRepo struct {
	data   *Data
	bucket string
}

func NewOssRepo(data *Data, c *conf.Data) biz.OssRepo {
	return &ossRepo{
		data:   data,
		bucket: c.Minio.Bucket,
	}
}

func (r *ossRepo) GeneratePostPolicy(ctx context.Context, objectKey string) (map[string]string, string, error) {
	policy := minio.NewPostPolicy()
	policy.SetBucket(r.bucket)
	policy.SetKey(objectKey)
	
	// 设置凭证过期时间 (例如 1 小时)
	policy.SetExpires(time.Now().UTC().Add(time.Hour))
	
	// 限制文件大小 (1MB 到 10MB)
	policy.SetContentLengthRange(1024*1024, 10*1024*1024)

	// 生成预签名 Policy
	url, formData, err := r.data.Minio.PresignedPostPolicy(ctx, policy)
	if err != nil {
		return nil, "", err
	}
	
	return formData, url.String(), nil
}

```

### 第三步：Biz 层 (`internal/biz`)
定义接口和业务逻辑。回调的业务逻辑通常在这里处理（如更新数据库中订单/商品的图片 URL）。

```go
package biz

import "context"

type OssRepo interface {
	GeneratePostPolicy(ctx context.Context, objectKey string) (map[string]string, string, error)
}

type OssUsecase struct {
	repo OssRepo
}

func NewOssUsecase(repo OssRepo) *OssUsecase {
	return &OssUsecase{repo: repo}
}

// GetUploadToken 获取直传凭证
func (uc *OssUsecase) GetUploadToken(ctx context.Context, filename string) (map[string]string, string, error) {
	// 这里可以加入业务逻辑，比如重命名文件避免覆盖：uuid + filename
	objectKey := "uploads/" + filename
	return uc.repo.GeneratePostPolicy(ctx, objectKey)
}

// HandleCallback 处理 MinIO Webhook 回调
func (uc *OssUsecase) HandleCallback(ctx context.Context, objectKey string, size int64) error {
	// 业务逻辑：记录到数据库，更新业务状态等
	// log.Infof("文件上传成功: %s, 大小: %d", objectKey, size)
	return nil
}

```

### 第四步：Service 层 (前端请求接口 & 回调接口)
处理 HTTP 请求。这里要特别注意回调**验签**。我们在 HTTP Header 中增加一个 Authorization token，让 MinIO 发起回调时带上这个 Token 以确认身份。

```go
package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	pb "your_project/api/oss/v1" // 你的 protobuf 生成代码
	"your_project/internal/biz"
	"your_project/internal/conf"
	
	"github.com/go-kratos/kratos/v2/transport/http"
)

type OssService struct {
	pb.UnimplementedOssServer
	uc       *biz.OssUsecase
	cfgToken string
}

func NewOssService(uc *biz.OssUsecase, c *conf.Data) *OssService {
	return &OssService{
		uc:       uc,
		cfgToken: c.Minio.WebhookToken, // 从配置中读取验签 Token
	}
}

// GetUploadToken 给前端调用的接口：获取直传凭证
func (s *OssService) GetUploadToken(ctx context.Context, req *pb.GetTokenRequest) (*pb.GetTokenReply, error) {
	formData, postURL, err := s.uc.GetUploadToken(ctx, req.Filename)
	if err != nil {
		return nil, err
	}
	return &pb.GetTokenReply{
		Url:      postURL,
		FormData: formData, // 前端将其放入 multipart/form-data
	}, nil
}

// MinioEvent 定义 MinIO Webhook JSON 结构
type MinioEvent struct {
	Records []struct {
		EventName string `json:"eventName"`
		S3        struct {
			Object struct {
				Key  string `json:"key"`
				Size int64  `json:"size"`
			} `json:"object"`
		} `json:"s3"`
	} `json:"Records"`
}

// HandleMinioCallback 这是一个纯 HTTP Handler，用于接收 MinIO 的 Webhook
func (s *OssService) HandleMinioCallback(w http.ResponseWriter, r *http.Request) {
	// 1. 验签：检查 Header 中的 Token，防止被恶意调用
	authHeader := r.Header.Get("Authorization")
	if authHeader != "Bearer "+s.cfgToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// 2. 解析 MinIO 发来的 Payload
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	var event MinioEvent
	if err := json.Unmarshal(body, &event); err != nil {
		http.Error(w, "Parse Error", http.StatusBadRequest)
		return
	}

	// 3. 处理上传事件
	for _, record := range event.Records {
		// 监听 s3:ObjectCreated:* 事件
		if len(record.EventName) >= 15 && record.EventName[:15] == "s3:ObjectCreated" {
			key := record.S3.Object.Key
			size := record.S3.Object.Size
			
			// 调用 Biz 层业务处理
			_ = s.uc.HandleCallback(r.Context(), key, size)
		}
	}

	// 返回 200 给 MinIO
	w.WriteHeader(http.StatusOK)
}

```
**Kratos HTTP 路由注册 (internal/server/http.go)：**
```go
func NewHTTPServer(c *conf.Server, oss *service.OssService /*...注入其他...*/) *http.Server {
	var opts = []http.ServerOption{ /* ... */ }
	srv := http.NewServer(opts...)
	// 注册 Protobuf 路由
	pb.RegisterOssHTTPServer(srv, oss)
	// 注册原生的 Webhook 路由用于回调验证
	srv.HandleFunc("/v1/oss/callback", oss.HandleMinioCallback)
	
	return srv
}

```

### 第五步：MinIO 测试环境配置 (配置 Webhook)

### 总结与排坑指南
1. **关于前端对接**：前端拿到 `url` 和 `formData` 后，需要使用 `FormData` 对象构造请求，将获取到的 map 展开放进 form 中，并把**文件本体作为最后一个字段 (`file`)** 进行 `POST` 请求（而不是普通的 PUT）。
2. **兼容性设计**：如果你的生产环境用的是阿里云，由于阿里云支持同步回调（回调成功才返回给前端 200），而 MinIO 是前端秒回 200，后端异步处理。**建议你在前端设计上，统一不要过度依赖 OSS 回调的返回值来决定页面逻辑。** 可以让前端上传完后，再主动调一次你的后端业务接口报告 `(objectKey, size)`，把 MinIO / 阿里云 的 webhook 回调纯粹当作“兜底校验机制”，这在电商架构里更具有鲁棒性。