---
category: microservice
type: pattern
topic: transaction
frameworks:
  - go-kratos
  - sqlc
status: seedling
tags:
  - microservice/go-kratos
  - database/sqlc
  - database/postgresql
  - reliability/transaction
---

# Kratos SQLC pgx 事务管理

在 Go-Kratos 中，事务边界应由 Biz 层控制，Data 层实现具体事务。为了同时支持 sqlc 和 River，需要在同一个 `context.Context` 中放入两个对象：

- 绑定当前事务的 `*db.Queries`，供业务表读写使用。
- 原生 `pgx.Tx`，供 River `InsertTx` 使用。

## Biz 层接口

```go
package biz

import "context"

type Transaction interface {
    InTx(context.Context, func(ctx context.Context) error) error
}
```

Biz 层只依赖这个接口，不关心底层使用 `database/sql`、`pgx` 还是其他驱动。

## Data 结构

```go
package data

import (
    "context"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "riverqueue.com/river"

    "your_project/internal/data/db"
)

type contextTxKey struct{}
type contextRawPgxTxKey struct{}

type Data struct {
    pool        *pgxpool.Pool
    q           *db.Queries
    riverClient *river.Client[pgx.Tx]
}
```

`context` key 放在 `data` 包内部并保持私有，避免和其他包冲突。

## 获取 sqlc Queries

```go
func (d *Data) DB(ctx context.Context) *db.Queries {
    if q, ok := ctx.Value(contextTxKey{}).(*db.Queries); ok {
        return q
    }
    return d.q
}
```

Repo 层统一使用 `r.data.DB(ctx)`。如果当前在事务闭包中，拿到的是事务版 `Queries`；如果没有事务，自动降级为连接池版 `Queries`。

## 获取原生 pgx.Tx

```go
func (d *Data) GetPgxTx(ctx context.Context) pgx.Tx {
    if tx, ok := ctx.Value(contextRawPgxTxKey{}).(pgx.Tx); ok {
        return tx
    }
    return nil
}
```

River Outbox 场景必须拿到原生 `pgx.Tx`。如果 `tx == nil`，JobRepo 应直接返回错误，避免非事务入队破坏一致性。

## Transaction 实现

```go
type transaction struct {
    data *Data
}

func NewTransaction(data *Data) biz.Transaction {
    return &transaction{data: data}
}

func (t *transaction) InTx(ctx context.Context, fn func(ctx context.Context) error) error {
    tx, err := t.data.pool.Begin(ctx)
    if err != nil {
        return err
    }
    defer func() {
        _ = tx.Rollback(ctx)
    }()

    qTx := t.data.q.WithTx(tx)
    ctx = context.WithValue(ctx, contextTxKey{}, qTx)
    ctx = context.WithValue(ctx, contextRawPgxTxKey{}, tx)

    if err := fn(ctx); err != nil {
        return err
    }

    return tx.Commit(ctx)
}
```

`pgx/v5` 的 `Rollback` 在事务已经 `Commit` 后会返回事务已关闭错误，这里可以忽略。

## 使用方式

```go
func (uc *OrderUsecase) PaySuccess(ctx context.Context, orderID int64) error {
    return uc.tx.InTx(ctx, func(ctx context.Context) error {
        if err := uc.orderRepo.MarkPaid(ctx, orderID); err != nil {
            return err
        }
        if err := uc.jobRepo.EnqueueOrderPaid(ctx, orderID); err != nil {
            return err
        }
        return nil
    })
}
```

## 注意点

- 不要在 Repo 内部自己 `Begin`、`Commit`、`Rollback`，否则上层无法组合更大的事务。
- Repo 方法必须接受 `ctx`，并通过 `Data.DB(ctx)` 取 `Queries`。
- JobRepo 入 River 任务时必须通过 `Data.GetPgxTx(ctx)` 取当前事务。
- 基础单条 SQL 不一定要包 `InTx`，见 [[SQLC CRUD 事务边界]]。

## 相关链接

- [[Go-Kratos,-SQLC,-River-MQ-Transactions]]
- [[River pgx 事务入队]]
- [[PaymentSync Repo 事务改造]]
- [[SQLC使用]]
