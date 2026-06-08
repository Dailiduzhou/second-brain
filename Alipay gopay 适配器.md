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
  - payment/alipay
---

# Alipay gopay 适配器

支付宝通道优先用于沙箱演示。Data 层 Adapter 负责初始化 Client、创建网页支付、主动查单和回调验签。

## 初始化

```go
type AlipayAdapter struct {
    client *alipay.ClientV3
}

func NewAlipayAdapter(c *conf.Alipay, logger xlog.XLogger) *AlipayAdapter {
    client, err := alipay.NewClientV3(c.AppId, c.PrivateKey, !c.Sandbox)
    if err != nil {
        panic(err)
    }

    client.SetLogger(logger)
    // 按实际接入方式配置支付宝公钥或证书。

    return &AlipayAdapter{client: client}
}
```

示例 import：

```go
import (
    "github.com/go-pay/gopay"
    "github.com/go-pay/gopay/alipay/v3"
    "github.com/go-pay/xlog"
)
```

沙箱环境下要确认 `Sandbox` 配置能够让 Client 使用沙箱网关，避免误连生产环境。

## 创建网页支付

```go
func (a *AlipayAdapter) CreatePayOrder(ctx context.Context, req *biz.PayOrderReq) (*biz.PayOrderResp, error) {
    bm := make(gopay.BodyMap)
    bm.Set("subject", req.Title).
        Set("out_trade_no", req.OrderNo).
        Set("total_amount", req.Amount).
        Set("product_code", "FAST_INSTANT_TRADE_PAY")

    payURL, err := a.client.TradePagePay(ctx, bm)
    if err != nil {
        return nil, err
    }
    return &biz.PayOrderResp{PayPayload: payURL}, nil
}
```

`PayPayload` 对支付宝网页支付来说通常是跳转 URL 或表单内容，前端按实际返回形态处理。

## 主动查单

```go
func (a *AlipayAdapter) QueryOrder(ctx context.Context, orderNo string) (string, error) {
    bm := make(gopay.BodyMap)
    bm.Set("out_trade_no", orderNo)

    rsp, err := a.client.TradeQuery(ctx, bm)
    if err != nil {
        return "", err
    }
    return rsp.Response.TradeStatus, nil
}
```

常见状态：

| 状态 | 含义 |
|------|------|
| `WAIT_BUYER_PAY` | 等待买家付款 |
| `TRADE_SUCCESS` | 支付成功 |
| `TRADE_CLOSED` | 交易关闭 |
| `TRADE_FINISHED` | 交易完成 |

## 回调验签

支付宝异步通知通常是 `application/x-www-form-urlencoded`。回调接口应先解析表单，再交给 Adapter 验签和转换成本地 `PaymentNotify`。

```go
func (a *AlipayAdapter) VerifyNotify(ctx context.Context, r *http.Request) (*biz.PaymentNotify, error) {
    if err := r.ParseForm(); err != nil {
        return nil, err
    }

    // 使用 gopay/alipay 提供的验签能力校验 r.PostForm。
    // 验签通过后再读取 out_trade_no、trade_no、trade_status、total_amount。

    return &biz.PaymentNotify{
        Channel:        biz.ChannelAlipay,
        OrderNo:        r.PostForm.Get("out_trade_no"),
        ThirdPartyTxID: r.PostForm.Get("trade_no"),
        TradeStatus:    r.PostForm.Get("trade_status"),
        Amount:         r.PostForm.Get("total_amount"),
    }, nil
}
```

## 相关链接

- [[支付通道 Adapter 设计]]
- [[支付回调处理]]
- [[支付查单与 River 兜底]]
- [[gopay集成]]
