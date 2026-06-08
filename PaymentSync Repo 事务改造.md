---
category: ecommerce
type: refactor
topic: transaction
frameworks:
  - go-kratos
  - sqlc
  - riverqueue
module: payment
status: seedling
tags:
  - ecommerce/payment
  - database/sqlc
  - reliability/transaction
---

# PaymentSync Repo 事务改造

支付同步场景通常需要同时更新支付单、订单状态，并可能投递后续 River 任务。事务边界应放在 Biz 层，Repo 层只负责执行 sqlc 查询。

## 为什么不能继续用全局 Queries

如果已经开启了 `pgx.Tx`，但仍然用全局 `*db.Queries` 执行 SQL，这些 SQL 会走连接池，不会参与当前事务。

因此在手写事务中常见：

```go
tx, err := r.pool.Begin(ctx)
q := db.New(tx)
```

`db.New(tx)` 或 `q.WithTx(tx)` 的意义是生成绑定当前事务的 sqlc `Queries`。

## 原 Repo 的问题

如果 Repo 方法内部自己做：

```go
tx, err := r.pool.Begin(ctx)
defer tx.Rollback(ctx)
q := db.New(tx)
// update payment
// update order
return tx.Commit(ctx)
```

会带来两个问题：

- 上层无法把这个方法和其他 Repo 操作组合到同一个事务里。
- 后续要和 River `InsertTx` 共享事务时，只能继续把事务逻辑塞进 Repo，职责越来越重。

## Repo 层改造

Repo 层移除 `Begin`、`Commit`、`Rollback`，只从 `Data.DB(ctx)` 获取当前可用的 sqlc `Queries`。

```go
func (r *PaymentSyncRepo) ApplyWechatPayQuery(
    ctx context.Context,
    args biz.CheckWechatPayArgs,
    result *pb.QueryOrderReply,
) error {
    q := r.data.DB(ctx)
    orderID := args.OrderID

    switch result.TradeState {
    case pb.TradeState_SUCCESS:
        payment, err := q.UpdatePaymentSuccess(ctx, db.UpdatePaymentSuccessParams{
            ID: args.PaymentID,
            ThirdPartyTxID: pgtype.Text{
                String: result.TransactionId,
                Valid:  result.TransactionId != "",
            },
        })
        if err != nil {
            return err
        }

        if orderID <= 0 {
            orderID = payment.OrderID
        }
        if orderID > 0 {
            return q.CompleteOrder(ctx, orderID)
        }

    case pb.TradeState_REFUND:
        return q.UpdatePaymentRefunded(ctx, args.PaymentID)

    case pb.TradeState_CLOSED, pb.TradeState_REVOKED, pb.TradeState_PAYERROR:
        if err := q.UpdatePaymentFailed(ctx, args.PaymentID); err != nil {
            return err
        }
        if orderID <= 0 {
            payment, err := q.GetPayment(ctx, args.PaymentID)
            if err != nil {
                return err
            }
            orderID = payment.OrderID
        }
        if orderID > 0 {
            return q.CancelOrder(ctx, orderID)
        }

    default:
        return fmt.Errorf("wechat pay state %s is not terminal", result.TradeState.String())
    }

    return nil
}
```

## Biz 层控制事务

```go
type PaymentSyncUsecase struct {
    repo    PaymentSyncRepo
    jobRepo PaymentJobRepo
    tx      Transaction
}

func (uc *PaymentSyncUsecase) ProcessWechatQuery(
    ctx context.Context,
    args CheckWechatPayArgs,
    result *pb.QueryOrderReply,
) error {
    return uc.tx.InTx(ctx, func(ctx context.Context) error {
        if err := uc.repo.ApplyWechatPayQuery(ctx, args, result); err != nil {
            return err
        }

        if result.TradeState == pb.TradeState_SUCCESS {
            if err := uc.jobRepo.EnqueuePaymentSuccess(ctx, args.PaymentID); err != nil {
                return err
            }
        }

        return nil
    })
}
```

闭包中的 Repo 和 JobRepo 共享同一个 `ctx`，因此共享同一个 `pgx.Tx`。

## 改造收益

- 支付状态更新和订单状态更新保持原子性。
- 后续 River 任务入队可自然加入同一个事务。
- Repo 可以被其他业务组合复用。
- 单元测试可以分别测试 Repo 逻辑和 Biz 事务编排。

## 相关链接

- [[Go-Kratos,-SQLC,-River-MQ-Transactions]]
- [[Kratos SQLC pgx 事务管理]]
- [[River pgx 事务入队]]
- [[电商系统幂等性和细节]]
