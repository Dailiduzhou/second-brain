---
category: ecommerce
type: observability
topic: payment
frameworks:
  - go-kratos
  - gopay
module: payment
status: seedling
tags:
  - ecommerce/payment
  - observability/logging
  - microservice/go-kratos
---

# gopay xlog Kratos 日志桥接

`gopay` 使用自己的 `xlog` 日志接口。为了让支付 SDK 日志进入 Kratos 日志体系，可以实现一个桥接器，把 gopay 日志转发给 `log.Helper`。

## 实现

```go
package payment

import (
    "fmt"

    "github.com/go-kratos/kratos/v2/log"
    "github.com/go-pay/xlog"
)

type kLogger struct {
    helper *log.Helper
}

func NewGopayLogger(logger log.Logger) xlog.XLogger {
    return &kLogger{
        helper: log.NewHelper(log.With(logger, "module", "gopay-sdk")),
    }
}

func (l *kLogger) Debug(args ...any)                 { l.helper.Debug(fmt.Sprint(args...)) }
func (l *kLogger) Debugf(format string, args ...any) { l.helper.Debugf(format, args...) }
func (l *kLogger) Info(args ...any)                  { l.helper.Info(fmt.Sprint(args...)) }
func (l *kLogger) Infof(format string, args ...any)  { l.helper.Infof(format, args...) }
func (l *kLogger) Warn(args ...any)                  { l.helper.Warn(fmt.Sprint(args...)) }
func (l *kLogger) Warnf(format string, args ...any)  { l.helper.Warnf(format, args...) }
func (l *kLogger) Error(args ...any)                 { l.helper.Error(fmt.Sprint(args...)) }
func (l *kLogger) Errorf(format string, args ...any) { l.helper.Errorf(format, args...) }
```

## 使用

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
    }
}
```

## 注意点

- 给 SDK 日志增加固定 `module` 字段，方便排查支付问题。
- 不要在日志中输出完整私钥、证书、授权头或用户敏感信息。
- 支付回调日志要记录 `order_no`、`channel`、第三方交易号和处理结果。
- 如果项目接入 TraceID，确认 Kratos logger 的上下文字段能贯穿到支付日志。

## 相关链接

- [[支付通道 Adapter 设计]]
- [[Alipay gopay 适配器]]
- [[Wechat Pay gopay 适配器]]
- [[可观测性]]
