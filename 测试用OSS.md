---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce/oss
  - testing/minio
---

# 测试用OSS

本地开发用 MinIO 模拟对象存储。它兼容 S3 API，适合验证前端直传、Bucket 权限、CORS 和 Webhook，但不能完全等价于阿里云 OSS 的同步回调语义。

## 适用范围

- 本地验证上传凭证和表单直传。
- 本地验证 Bucket 权限、公开读、对象 Key 规则。
- 本地验证上传事件通知后端。
- 作为对象存储 Provider 抽象的一个实现。

## 不适用范围

- 不用 MinIO 结果推断阿里云 OSS 的所有回调行为。
- 不把 MinIO 异步 Webhook 当成生产同步回调的严格替代品。
- 不在前端强依赖 Webhook 返回结果决定页面状态。

## 拆分笔记

- [[OSS 本地 MinIO 环境]]：Docker Compose、Bucket 初始化、CORS、Webhook。
- [[OSS Provider 抽象]]：统一对象存储接口、配置和 Wire Provider。
- [[OSS 回调语义差异]]：阿里云 OSS 与 MinIO 的回调差异。

## 推荐测试策略

1. 前端上传前先请求 Kratos 获取 PostPolicy。
2. 前端按 OSS 表单上传规则直传 MinIO。
3. MinIO 上传成功后异步触发 Webhook。
4. Kratos 将 Webhook 当作兜底确认信号。
5. 前端上传成功后主动调用业务接口确认对象归属。

## 相关链接

- [[OSS 实现]]
- [[OSS 直传流程]]
- [[OSS 回调处理]]
