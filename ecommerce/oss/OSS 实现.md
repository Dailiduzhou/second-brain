---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce/oss
---

# OSS 实现

电商系统的 OSS 方案以**前端直传**为主：后端只负责生成受限上传凭证、接收 OSS 回调、维护业务状态，不让文件流量经过 Kratos 服务。

## 设计目标

- 减少后端带宽压力，避免大文件上传打满应用服务。
- 通过后端生成的 Policy 限制文件大小、路径、过期时间和回调地址。
- 通过回调验签、幂等落库和超时检测保证最终状态可信。
- 在本地用 MinIO 复现主要开发流程，在生产接入阿里云 OSS。

## 核心链路

1. 前端选择文件，向 Kratos 请求上传凭证。
2. Kratos 生成带约束的 PostPolicy，并预创建上传记录。
3. 前端携带 Policy、签名和文件直接 POST 到 OSS。
4. OSS 上传成功后回调 Kratos。
5. Kratos 验签并投递异步落库任务。
6. River Worker 将媒体记录更新为可用状态。

## 子主题

- [[OSS 直传流程]]：前端、Kratos、OSS 之间的完整交互。
- [[OSS 上传凭证]]：PostPolicy、文件大小限制、对象 Key 约束。
- [[OSS 回调处理]]：Raw Route、验签、响应格式、脏数据清理。
- [[OSS + MQ整体流程]]：用 River 处理异步落库、重试和超时检测。
- [[测试用OSS]]：本地 MinIO 测试入口。
- [[OSS 本地 MinIO 环境]]：Docker Compose、Bucket、CORS、Webhook 配置。
- [[OSS Provider 抽象]]：MinIO、阿里云 OSS 等 Provider 的统一接口与 DI。
- [[OSS 回调语义差异]]：阿里云 OSS 同步回调与 MinIO 异步 Webhook 的差异。

## 相关链接

- [[电商系统]]
- [[电商系统技术选型]]
- [[电商系统项目进度]]
