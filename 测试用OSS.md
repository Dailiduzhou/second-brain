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