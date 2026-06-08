---
category: database
type: practice
topic: soft-delete
frameworks:
  - sqlc
status: seedling
tags:
  - database/postgresql
  - database/sqlc
  - reliability/idempotency
---

# PostgreSQL 软删除实践

软删除通常通过 `deleted_at` 或 `is_deleted` 标记记录不可见。它适合需要短期恢复、审计或排查问题的核心业务数据，但会改变唯一索引、查询作用域、级联删除和数据清理策略。

## 字段选择

推荐使用 `deleted_at`：

```sql
ALTER TABLE users
ADD COLUMN deleted_at timestamptz;
```

`deleted_at IS NULL` 表示有效数据；非空表示已删除，并保留删除时间。

## 唯一索引

软删除后，普通唯一索引仍会覆盖已删除记录，导致同一个邮箱、手机号或业务编码无法重新使用。

推荐使用部分唯一索引：

```sql
CREATE UNIQUE INDEX users_email_active_idx
ON users(email)
WHERE deleted_at IS NULL;
```

这样只有未删除记录参与唯一约束。

## 并发软删除

软删除本质是 `UPDATE`。要避免多个并发请求都认为自己删除成功，应在 `WHERE` 中带上状态条件，并用 `RETURNING` 判断是否真正抢到删除权。

```sql
-- name: SoftDeleteUser :one
UPDATE users
SET deleted_at = now()
WHERE id = $1
  AND deleted_at IS NULL
RETURNING id;
```

sqlc 返回 no rows 时，表示记录不存在或已经被删除。涉及退款、库存返还等副作用时，后续动作必须停止。

## 查询作用域

sqlc 不会像 ORM 一样自动追加 `deleted_at IS NULL`。每条查询都要显式处理。

```sql
-- name: GetActiveUser :one
SELECT id, email, name
FROM users
WHERE id = $1
  AND deleted_at IS NULL;
```

对高频查询可以建立 view，降低漏写条件的概率：

```sql
CREATE VIEW active_users AS
SELECT *
FROM users
WHERE deleted_at IS NULL;
```

## 级联删除

数据库的 `ON DELETE CASCADE` 只对物理删除生效。父记录软删除时，子记录不会自动软删除。

强生命周期绑定的数据，应在 Biz 层开启事务手动编排：

```go
func (uc *ArticleUsecase) DeleteArticle(ctx context.Context, id int64) error {
    return uc.tx.InTx(ctx, func(ctx context.Context) error {
        if err := uc.repo.SoftDeleteArticle(ctx, id); err != nil {
            return err
        }
        if err := uc.repo.SoftDeleteCommentsByArticleID(ctx, id); err != nil {
            return err
        }
        return nil
    })
}
```

## 清理和归档

软删除数据不能无限留在主表里。建议为不同实体设定保留策略：

| 数据类型 | 建议 |
|----------|------|
| 核心订单、支付流水 | 长期保留或归档到历史表 |
| 商品草稿、临时媒体 | 短期保留后物理清理 |
| 中间关联表 | 优先考虑物理删除 |
| 操作日志 | 使用独立日志或审计表，不一定软删除 |

## 适用判断

适合软删除：

- 用户、商品、订单等需要恢复或审计的数据。
- 删除后仍需要排查历史业务问题的数据。
- 法务或运营要求保留的数据。

不适合软删除：

- 可重建的缓存和中间表。
- 高吞吐日志表。
- 临时文件、临时任务、会话数据。

## 相关链接

- [[SQLC CRUD 事务边界]]
- [[Kratos SQLC pgx 事务管理]]
- [[电商系统幂等性和细节]]
- [[数据库]]
