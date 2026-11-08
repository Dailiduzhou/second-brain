---
category: ecommerce
type: integration
topic: payment
frameworks:
  - gopay
module: payment
status: seedling
tags:
  - ecommerce/payment
  - payment/wechat-pay
---

# Wechat Pay gopay 适配器

微信支付作为后续扩展通道，建议使用 V3 API。Adapter 负责把系统统一金额和订单模型转换成微信支付需要的请求结构。

## 初始化

```go
type WechatAdapter struct {
    client *wechat.ClientV3
}

func NewWechatAdapter(c *conf.WechatPay, logger xlog.XLogger) *WechatAdapter {
    client, err := wechat.NewClientV3(c.MchId, c.SerialNo, c.ApiV3Key, c.PrivateKey)
    if err != nil {
        panic(err)
    }

    client.SetLogger(logger)
    return &WechatAdapter{client: client}
}
```

生产接入需要准备商户号、API v3 Key、商户私钥、证书序列号和回调地址。

## 创建 Native 支付

```go
func (w *WechatAdapter) CreatePayOrder(ctx context.Context, req *biz.PayOrderReq) (*biz.PayOrderResp, error) {
    totalFen, err := yuanToFen(req.Amount)
    if err != nil {
        return nil, err
    }

    bm := make(gopay.BodyMap)
    bm.Set("out_trade_no", req.OrderNo).
        Set("description", req.Title).
        Set("amount", map[string]any{
            "total":    totalFen,
            "currency": "CNY",
        })

    rsp, err := w.client.V3TransactionNative(ctx, bm)
    if err != nil {
        return nil, err
    }
    return &biz.PayOrderResp{PayPayload: rsp.Response.CodeUrl}, nil
}
```

微信金额单位是分，转换逻辑必须留在 Adapter 中。

## 金额转换

```go
func yuanToFen(amount string) (int, error) {
    d, err := decimal.NewFromString(amount)
    if err != nil {
        return 0, err
    }
    return int(d.Mul(decimal.NewFromInt(100)).IntPart()), nil
}
```

不要用 `float64 * 100` 处理支付金额。

## 主动查单

```go
func (w *WechatAdapter) QueryOrder(ctx context.Context, orderNo string) (string, error) {
    rsp, err := w.client.V3TransactionQueryOrder(ctx, wechat.OutTradeNo, orderNo)
    if err != nil {
        return "", err
    }
    return rsp.Response.TradeState, nil
}
```

常见状态：

| 状态 | 含义 |
|------|------|
| `SUCCESS` | 支付成功 |
| `NOTPAY` | 未支付 |
| `CLOSED` | 已关闭 |
| `PAYERROR` | 支付失败 |
| `REFUND` | 转入退款 |

## 相关链接

- [[支付通道 Adapter 设计]]
- [[支付查单与 River 兜底]]
- [[PaymentSync Repo 事务改造]]
- [[gopay集成]]
