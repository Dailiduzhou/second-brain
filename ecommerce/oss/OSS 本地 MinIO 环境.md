---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce/oss
  - testing/minio
---

# OSS 本地 MinIO 环境

MinIO 可用于本地替代云 OSS，验证对象上传、公开读、CORS 和上传事件通知。

## Docker Compose

在 `docker-compose.dev.yml` 中配置 MinIO 主服务和初始化容器：

```yaml
version: "3.8"

services:
  minio:
    image: minio/minio:latest
    container_name: minio_dev
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: "admin"
      MINIO_ROOT_PASSWORD: "password123"
      MINIO_API_CORS_ALLOW_ORIGIN: "*"
      MINIO_NOTIFY_WEBHOOK_ENABLE_kratos: "on"
      MINIO_NOTIFY_WEBHOOK_ENDPOINT_kratos: "http://host.docker.internal:8000/v1/oss/callback"
    command: server /data --console-address ":9001"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data/minio:/data
    restart: unless-stopped

  minio-init:
    image: minio/mc:latest
    container_name: minio_init
    depends_on:
      - minio
    entrypoint: >
      /bin/sh -c "
      until (/usr/bin/mc config host add myminio http://minio:9000 admin password123); do
        sleep 1;
      done;

      /usr/bin/mc mb myminio/ecommerce-assets --ignore-existing;
      /usr/bin/mc anonymous set download myminio/ecommerce-assets;
      /usr/bin/mc event add myminio/ecommerce-assets arn:minio:sqs::kratos:webhook --event put;

      exit 0;
      "
```

## 配置重点

| 配置 | 作用 |
|------|------|
| `9000` | S3 API 端口 |
| `9001` | MinIO 控制台端口 |
| `MINIO_API_CORS_ALLOW_ORIGIN` | 允许浏览器跨域直传 |
| `MINIO_NOTIFY_WEBHOOK_ENDPOINT_kratos` | 上传事件通知 Kratos |
| `anonymous set download` | 允许公开读取对象 |
| `event add --event put` | 绑定对象创建事件 |

## Kratos 配置

```protobuf
message Storage {
    enum ProviderType {
        MINIO = 0;
        ALIYUN_OSS = 1;
        TENCENT_COS = 2;
    }

    ProviderType provider = 1;
    string endpoint = 2;
    string access_key = 3;
    string secret_key = 4;
    string bucket = 5;
    bool use_ssl = 6;
    string webhook_token = 7;
}
```

## 验收点

- 控制台可打开 `http://localhost:9001`。
- `ecommerce-assets` Bucket 自动创建。
- 前端能跨域 POST 到 `http://localhost:9000`。
- 上传成功后 Kratos 能收到 `/v1/oss/callback` 请求。
- 对象 URL 可以公开读取，或按业务要求走签名读取。

## 相关链接

- [[测试用OSS]]
- [[OSS Provider 抽象]]
- [[OSS 回调语义差异]]
