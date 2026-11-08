---
category: database
type: practice
topic: sqlc
frameworks:
  - sqlc
status: seedling
tags:
  - database/sqlc
  - database/postgresql
  - reliability/transaction
---

# SQLC CRUD 事务边界

引入 `Transaction.InTx` 后，不需要把所有 CRUD 全量重写成显式事务。更合理的做法是：Repo 统一通过 `Data.DB(ctx)` 获取 sqlc `Queries`，Biz 层按场景决定是否开启事务。

## Repo 层统一取 DB

```go
func (r *UserRepo) CreateUser(ctx context.Context, u *biz.User) error {
    q := r.data.DB(ctx)
    return q.CreateUser(ctx, db.CreateUserParams{
        Email: u.Email,
        Name:  u.Name,
    })
}
```

这样这个 Repo 方法既能在普通场景直接执行，也能在 `InTx` 闭包中自动参与事务。

## 不需要显式 InTx 的场景

- 单条 `INSERT`。
- 单条 `UPDATE`。
- 单条 `DELETE`。
- 没有跨表一致性要求的查询或修改。

单条 SQL 在 PostgreSQL 中本身就有隐式事务。额外包一层应用事务会增加连接占用和代码复杂度。

## 需要显式 InTx 的场景

| 场景 | 示例 |
|------|------|
| 跨表操作 | 支付成功后更新支付单和订单 |
| 跨记录操作 | 账户 A 扣款、账户 B 加款 |
| Outbox | 更新业务数据后投递 River 任务 |
| 状态机 | 只有指定原状态才能流转到目标状态 |
| 悲观锁 | `SELECT ... FOR UPDATE` 后做业务计算再更新 |

## 创建时不要先查再插

先 `SELECT` 再 `INSERT` 在并发下容易发生竞态。唯一性应交给数据库约束。

```sql
-- name: CreateUser :exec
INSERT INTO users (email, name)
VALUES ($1, $2);
```

如果业务允许已存在时忽略或更新，用 `ON CONFLICT`：

```sql
-- name: UpsertUser :one
INSERT INTO users (email, name)
VALUES ($1, $2)
ON CONFLICT (email)
DO UPDATE SET name = EXCLUDED.name
RETURNING id, email, name;
```

## 删除时优先用 RETURNING

只关心删除动作时直接 `DELETE`。如果删除后还需要数据，用 `RETURNING` 一步完成。

```sql
-- name: DeleteUser :one
DELETE FROM users
WHERE id = $1
RETURNING id, email, name;
```

如果没有返回行，说明记录不存在或已经被删除，业务层按幂等语义处理即可。

## 渐进式重构

不需要全量重写 CRUD。推荐顺序：

1. 在 Data 层增加 `DB(ctx)` 和事务管理器。
2. Repo 层逐步把 `r.q`、`db.New(r.pool)` 替换为 `r.data.DB(ctx)`。
3. Biz 层只在强一致场景使用 `uc.tx.InTx(...)`。
4. River 入队统一放到事务闭包中。

## 相关链接

- [[Go-Kratos,-SQLC,-River-MQ-Transactions]]
- [[Kratos SQLC pgx 事务管理]]
- [[PaymentSync Repo 事务改造]]
- [[PostgreSQL 软删除实践]]
- [[SQLC使用]]
