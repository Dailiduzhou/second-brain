---
category: ecommerce
type: payment
status: seedling
tags:
  - ecommerce
  - ecommerce/payment
---
## 选型理由

支付宝没有官方 `golang SDK` ，微信支付需要商家注册，流程繁琐。
支付宝能使用沙箱用于测试和演示。
## 支付宝沙箱做测试环境
可以在开放平台申请沙箱。
并在`gopay` 新建Client 时把 `IsProd` 设置为false来确保测试安全。
