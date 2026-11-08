---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce/oss
  - testing/minio
---

# OSS 回调语义差异

阿里云 OSS 和 MinIO 都能在对象上传后通知后端，但它们的回调语义不同。本地测试时要避免把 MinIO 行为误当成生产行为。

## 核心差异

| 维度 | 阿里云 OSS | MinIO |
|------|------------|-------|
| 回调类型 | 同步回调 | 异步 Bucket Notification |
| 前端何时收到成功 | OSS 调用后端并拿到成功响应后 | 对象写入成功后即可返回 |
| 后端响应是否影响前端上传结果 | 会影响 | 通常不影响 |
| 验签方式 | OSS 公钥与 `authorization` 验签 | 通常使用自定义 Token 或内网隔离 |
| 适合用途 | 生产上传确认 | 本地开发、事件通知、兜底校验 |

## 前端策略

不要让前端只依赖 OSS 回调结果判断业务完成。更稳的做法是：

1. 前端上传成功后拿到 `object_key`。
2. 前端调用业务接口提交 `media_id` 或 `object_key`。
3. 后端检查媒体记录状态。
4. 如果后台任务尚未完成，前端展示“处理中”并轮询或刷新查询。

## 后端策略

- 回调统一进入 `ProcessOssCallback` 任务。
- Worker 以 `media_id` 或 `object_key` 做幂等更新。
- `CheckUploadTimeout` 负责兜底失败检测。
- 本地 MinIO Webhook 可以作为业务确认的补充信号，但不应成为唯一信号。

## 相关链接

- [[OSS 直传流程]]
- [[OSS 回调处理]]
- [[OSS + MQ整体流程]]
- [[测试用OSS]]
