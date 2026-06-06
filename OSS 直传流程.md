---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce
  - ecommerce/oss
---
# OSS 直传流程

配合 go-kratos 实现前端直接上传到 OSS，不经过后端服务器。

## 需要的 API 接口

1. **获取凭证接口** `GET /v1/oss/upload-token` — 前端获取上传凭证
2. **OSS 回调接口** `POST /v1/oss/callback` — OSS 通知上传结果

## 完整交互步骤

1. **前端请求凭证：** 用户选择文件后，调用 Kratos 接口 `GET /v1/oss/upload-token`
2. **Kratos 下发凭证：** Kratos 调用 OSS SDK 生成带有过期时间（15 分钟）和大小限制的 PostPolicy 及签名，返回给前端
3. **前端直接上传：** 前端携带文件实体和签名，直接发起 POST 请求到 OSS 的公网/内网 Endpoint
4. **OSS 回调：** OSS 接收文件成功后，主动向 Kratos 服务器发起 POST 请求（回调地址在步骤 2 中指定）
5. **Kratos 确认回调：** Kratos 收到回调请求，校验签名，将业务数据写入数据库，返回 `{"Status":"OK"}`
6. **前端获取结果：** OSS 收到确认后，将 HTTP 200 返回给前端，前端提示上传成功

## 相关链接

- [[OSS 实现]]
- [[OSS 上传凭证]]
- [[OSS 回调处理]]
