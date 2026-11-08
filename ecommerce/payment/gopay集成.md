---
category: ecommerce
type: payment
topic: payment
frameworks:
  - go-kratos
  - gopay
module: payment
status: seedling
tags:
  - ecommerce/payment
  - microservice/go-kratos
---

# gopay 集成

`gopay` 用作支付 SDK 适配层，当前优先支持支付宝沙箱演示，后续可扩展微信支付。

## 选型理由

支付宝沙箱适合大学生创业竞赛演示：不需要真实交易资金流，也能展示完整支付链路。微信支付通常需要商户注册和证书配置，适合作为后续扩展通道。

## 集成边界

- `gopay` Client 在 Data 层初始化。
- Biz 层只依赖统一的 `PaymentRepo`。
- Service 层只负责请求转换和回调入口。
- 支付成功后的异步处理交给 River Worker。

## 支付宝沙箱

在开放平台申请沙箱账号后，配置 AppID、私钥、公钥和回调地址。初始化 `gopay` 支付宝 Client 时使用沙箱模式，避免误连生产网关。

## 依赖安装

依赖应在实际 Go 项目仓库中安装，不能在 Obsidian vault 里执行：

```bash
go get github.com/go-pay/gopay@latest
go get github.com/go-pay/xlog@latest
```

当前文档中的支付宝示例使用 `github.com/go-pay/gopay/alipay/v3`，微信示例使用 `github.com/go-pay/gopay/wechat/v3`。

## 子主题

- [[Go-Kratos-支付系统集成指南]]
- [[支付系统分层设计]]
- [[支付通道 Adapter 设计]]
- [[Alipay gopay 适配器]]
- [[Wechat Pay gopay 适配器]]
- [[支付回调处理]]
- [[支付查单与 River 兜底]]
- [[gopay xlog Kratos 日志桥接]]

## 相关链接

- [[电商系统技术选型]]
- [[电商系统项目进度]]
