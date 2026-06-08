---
category: ecommerce
type: reliability
topic: payment
frameworks:
  - go-kratos
  - riverqueue
  - gopay
module: payment
status: seedling
tags:
  - ecommerce/payment
  - message-queue/riverqueue
  - reliability/idempotency
---

# 支付查单与 River 兜底

支付回调可能因为网络、内网穿透、第三方重试策略等原因丢失。创建支付时应投递一个延迟查单任务，用主动查询支付渠道订单状态作为兜底。

## 创建支付时投递延迟任务

```go
func (uc *PaymentUsecase) CreatePayment(ctx context.Context, req *PayOrderReq) (*PayOrderResp, error) {
    var resp *PayOrderResp

    err := uc.tx.InTx(ctx, func(ctx context.Context) error {
        if err := uc.order.EnsurePayable(ctx, req.OrderNo); err != nil {
            return err
        }

        created, err := uc.repo.CreatePayment(ctx, req)
        if err != nil {
            return err
        }
        resp = created

        return uc.jobRepo.EnqueuePaymentCheck(ctx, req.Channel, req.OrderNo, 15*time.Minute)
    })
    if err != nil {
        return nil, err
    }

    return resp, nil
}
```

创建本地支付记录和投递查单任务应共用同一个 PostgreSQL 事务，避免只成功一半。

## River Job Args

```go
type PaymentCheckArgs struct {
    Channel string `json:"channel"`
    OrderNo string `json:"order_no"`
}

func (PaymentCheckArgs) Kind() string {
    return "payment.check"
}
```

## JobRepo 入队

```go
func (r *paymentJobRepo) EnqueuePaymentCheck(
    ctx context.Context,
    channel biz.PayChannel,
    orderNo string,
    delay time.Duration,
) error {
    tx := r.data.GetPgxTx(ctx)
    if tx == nil {
        return errors.New("payment check job must be enqueued in transaction")
    }

    _, err := r.riverClient.InsertTx(ctx, tx, PaymentCheckArgs{
        Channel: string(channel),
        OrderNo: orderNo,
    }, &river.InsertOpts{
        ScheduledAt: time.Now().Add(delay),
    })
    return err
}
```

## Worker

```go
type PaymentCheckWorker struct {
    river.WorkerDefaults[PaymentCheckArgs]
    uc *biz.PaymentUsecase
}

func (w *PaymentCheckWorker) Work(ctx context.Context, job *river.Job[PaymentCheckArgs]) error {
    return w.uc.CheckPaymentStatus(
        ctx,
        biz.PayChannel(job.Args.Channel),
        job.Args.OrderNo,
    )
}
```

## Usecase 查单

```go
func (uc *PaymentUsecase) CheckPaymentStatus(ctx context.Context, channel PayChannel, orderNo string) error {
    return uc.tx.InTx(ctx, func(ctx context.Context) error {
        paid, err := uc.repo.IsPaymentPaid(ctx, orderNo)
        if err != nil {
            return err
        }
        if paid {
            return nil
        }

        status, err := uc.repo.QueryOrderStatus(ctx, channel, orderNo)
        if err != nil {
            return err
        }

        return uc.applyQueriedStatus(ctx, channel, orderNo, status)
    })
}
```

`applyQueriedStatus` 和回调处理应走同一套状态机，避免两套逻辑产生分歧。

## 状态处理建议

| 第三方状态 | 本地处理 |
|------------|----------|
| 支付成功 | 幂等更新支付单和订单为已支付 |
| 未支付 | 保持 pending，必要时再次延迟查单 |
| 已关闭/失败 | 关闭支付单，释放订单占用资源 |
| 查询失败 | 返回 error，让 River 重试 |

## 相关链接

- [[支付回调处理]]
- [[River pgx 事务入队]]
- [[Kratos SQLC pgx 事务管理]]
- [[电商系统幂等性和细节]]
