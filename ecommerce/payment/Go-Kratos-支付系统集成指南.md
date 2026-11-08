---
category: ecommerce
type: integration
topic: payment
frameworks:
  - go-kratos
  - gopay
  - riverqueue
module: payment
status: seedling
tags:
  - ecommerce/payment
  - microservice/go-kratos
  - message-queue/riverqueue
---

# Go-Kratos 支付系统集成指南

这组笔记整理在 Go-Kratos 电商系统中接入 `gopay` 的支付模块设计。目标是支持支付宝沙箱演示，并为后续接入微信支付保留 Adapter 扩展点。

## 设计目标

- 支付 SDK 只出现在 Data 层，避免污染 Biz 和 Service 层。
- Biz 层使用统一支付模型，不感知支付宝“元”和微信“分”等差异。
- 支付创建、回调确认、主动查单和订单状态流转都要幂等。
- 支付成功后的业务副作用通过 River Queue 解耦，并利用 PostgreSQL 本地事务保证一致性。
- 支付宝沙箱用于比赛演示，生产商户配置可后续替换。

## 文档拆分

- [[gopay集成]]：选型理由、沙箱演示策略和总体入口。
- [[支付系统分层设计]]：Kratos `api -> service -> biz -> data -> job` 的职责边界。
- [[支付通道 Adapter 设计]]：统一支付接口与支付宝、微信支付 Adapter。
- [[Alipay gopay 适配器]]：支付宝沙箱、网页支付、查单、验签边界。
- [[Wechat Pay gopay 适配器]]：微信支付 V3 Adapter、金额单位转换、Native 支付。
- [[支付回调处理]]：支付宝表单回调、Raw Route、验签和成功响应。
- [[支付查单与 River 兜底]]：延迟查单 Job、回调丢失兜底和幂等处理。
- [[gopay xlog Kratos 日志桥接]]：把 gopay SDK 日志接入 Kratos 日志体系。
- [[项目唯一字段和业务流程]]：保证唯一性，并使用字段串通整个订单生命周期。

## 推荐流程

```text
前端 -> Service: 创建支付
Service -> Biz: CreatePayment
Biz -> Data: 创建支付单，调用 PaymentRepo
Data -> gopay Adapter: 生成支付链接或二维码
Biz -> River: 投递延迟查单任务

支付渠道 -> Raw Route: 支付回调
Service -> Biz: 处理回调
Biz -> Data: 验签，更新支付单和订单状态
Biz -> River: 投递支付成功后的后续任务

River Worker -> Biz: 延迟查单兜底
Biz -> Data Adapter: 主动查询第三方订单状态
Biz -> DB: 幂等更新本地状态
```

## 关键原则

- 回调和查单可能同时到达，支付成功状态更新必须带原状态条件。
- 回调路由不要走 Protobuf JSON 编码，应使用原生 HTTP Route。
- `success` / `fail` 这类回调响应要严格匹配支付渠道要求。
- 创建支付单和投递查单任务应放入同一个事务，见 [[Kratos SQLC pgx 事务管理]]。
- 支付成功后的发货、发积分、站内信等副作用放到 River Worker，Worker 必须幂等。

## 相关链接

- [[电商系统]]
- [[电商系统技术选型]]
- [[电商系统项目进度]]
- [[电商系统幂等性和细节]]
- [[Go-Kratos,-SQLC,-River-MQ-Transactions]]
