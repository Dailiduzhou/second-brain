---
category: ecommerce
type: pattern
topic: payment
frameworks:
  - go-kratos
  - gopay
module: payment
status: seedling
tags:
  - ecommerce/payment
  - architecture/adapter
---

# 支付通道 Adapter 设计

支付通道 Adapter 用来隔离支付宝、微信支付等 SDK 差异。Biz 层只使用统一支付模型，Data 层根据支付渠道路由到具体 Adapter。

## Adapter 接口

```go
package payment

import (
    "context"
    "net/http"

    "your_project/internal/biz"
)

type Adapter interface {
    CreatePayOrder(ctx context.Context, req *biz.PayOrderReq) (*biz.PayOrderResp, error)
    QueryOrder(ctx context.Context, orderNo string) (string, error)
    VerifyNotify(ctx context.Context, r *http.Request) (*biz.PaymentNotify, error)
}
```

## Repo 路由

```go
type paymentRepo struct {
    adapters map[biz.PayChannel]payment.Adapter
    log      *log.Helper
}

func (r *paymentRepo) CreatePayment(ctx context.Context, req *biz.PayOrderReq) (*biz.PayOrderResp, error) {
    adapter, ok := r.adapters[req.Channel]
    if !ok {
        return nil, errors.New("unsupported payment channel")
    }
    return adapter.CreatePayOrder(ctx, req)
}

func (r *paymentRepo) QueryOrderStatus(ctx context.Context, channel biz.PayChannel, orderNo string) (string, error) {
    adapter, ok := r.adapters[channel]
    if !ok {
        return "", errors.New("unsupported payment channel")
    }
    return adapter.QueryOrder(ctx, orderNo)
}
```

## DI 注册

```go
func NewPaymentRepo(c *conf.Data, logger log.Logger) biz.PaymentRepo {
    gopayLogger := payment.NewGopayLogger(logger)

    aliAdapter := payment.NewAlipayAdapter(c.Payment.Alipay, gopayLogger)
    wxAdapter := payment.NewWechatAdapter(c.Payment.Wechat, gopayLogger)

    return &paymentRepo{
        adapters: map[biz.PayChannel]payment.Adapter{
            biz.ChannelAlipay: aliAdapter,
            biz.ChannelWechat: wxAdapter,
        },
        log: log.NewHelper(log.With(logger, "module", "data/payment-repo")),
    }
}
```

## 防腐点

- Biz 层金额单位统一，不暴露微信“分”和支付宝“元”的差异。
- Biz 层不依赖 `gopay.BodyMap`、支付宝通知结构体或微信 V3 响应结构体。
- 第三方交易状态要映射成本地支付状态。
- 新增通道时只增加 Adapter 和注册项，不改 Usecase 主流程。

## 相关链接

- [[支付系统分层设计]]
- [[Alipay gopay 适配器]]
- [[Wechat Pay gopay 适配器]]
- [[gopay xlog Kratos 日志桥接]]
