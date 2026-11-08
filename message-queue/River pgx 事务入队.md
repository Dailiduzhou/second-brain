---
category: message-queue
type: integration
topic: riverqueue
frameworks:
  - go-kratos
  - riverqueue
status: seedling
tags:
  - message-queue/riverqueue
  - database/postgresql
  - reliability/transaction
---

# River pgx 事务入队

River Queue 基于 PostgreSQL，可以把任务入队和业务数据更新放进同一个本地事务。使用 `pgx/v5` 时，`InsertTx` 可以直接接收 `pgx.Tx`，不需要像 `database/sql` 那样额外包装。

## 初始化 River Client

```go
import (
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "riverqueue.com/river"
    "riverqueue.com/river/riverdriver/riverpgxv5"
)

func NewRiverClient(pool *pgxpool.Pool) (*river.Client[pgx.Tx], error) {
    return river.NewClient(riverpgxv5.New(pool), &river.Config{
        Queues: map[string]river.QueueConfig{
            river.QueueDefault: {MaxWorkers: 100},
        },
    })
}
```

使用 `riverpgxv5.New(pool)` 后，River Client 的泛型类型是 `*river.Client[pgx.Tx]`。

## 原生事务用法

```go
func EnqueueJobInTx(ctx context.Context, pool *pgxpool.Pool, client *river.Client[pgx.Tx]) error {
    tx, err := pool.Begin(ctx)
    if err != nil {
        return err
    }
    defer func() {
        _ = tx.Rollback(ctx)
    }()

    q := db.New(tx)
    if err := q.CreateUser(ctx, db.CreateUserParams{
        Email: "test@example.com",
    }); err != nil {
        return err
    }

    _, err = client.InsertTx(ctx, tx, WelcomeEmailArgs{
        Email: "test@example.com",
    }, nil)
    if err != nil {
        return err
    }

    return tx.Commit(ctx)
}
```

这段代码适合理解机制。实际 Kratos 项目中，应优先使用 [[Kratos SQLC pgx 事务管理]] 的 `Transaction.InTx`，把事务边界放到 Biz 层。

## JobRepo 写法

```go
type jobRepo struct {
    data        *Data
    riverClient *river.Client[pgx.Tx]
}

type WelcomeEmailArgs struct {
    Email string `json:"email"`
}

func (WelcomeEmailArgs) Kind() string {
    return "welcome_email"
}

func (r *jobRepo) EnqueueWelcomeEmail(ctx context.Context, email string) error {
    tx := r.data.GetPgxTx(ctx)
    if tx == nil {
        return fmt.Errorf("enqueue welcome email must be called within transaction")
    }

    _, err := r.riverClient.InsertTx(ctx, tx, WelcomeEmailArgs{
        Email: email,
    }, nil)
    return err
}
```

## database/sql 与 pgx/v5 差异

| 维度 | `database/sql` | `pgx/v5` |
|------|----------------|----------|
| River driver | `riverdatabasesql` | `riverpgxv5` |
| Client 泛型 | `*river.Client[riverdatabasesql.Tx]` | `*river.Client[pgx.Tx]` |
| 原生事务类型 | `*sql.Tx` | `pgx.Tx` |
| `InsertTx` 参数 | `riverdatabasesql.NewTx(tx)` | `tx` |

## 注意点

- Outbox 任务必须在业务事务内入队。
- Worker 需要按至少一次投递语义设计幂等。
- River migrate 必须纳入部署或启动前流程。
- Kratos 中建议把 River Worker 包装成 `transport.Server`，见 [[river in go-kratos]]。

## 相关链接

- [[Go-Kratos,-SQLC,-River-MQ-Transactions]]
- [[Kratos SQLC pgx 事务管理]]
- [[River key takeaway]]
- [[电商系统幂等性和细节]]
