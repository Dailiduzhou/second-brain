---
category: database
type: tool
topic: sqlc
status: seedling
tags:
  - database/sqlc
---
## 类型设计
存储**金额**等需要固定精度的数值，需要使用`NUMERIC(<进制>,<精度>)`
```sql
    price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
```
## 使用`pgx`配置
`sqlc.yaml`
```yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "db/query"
    schema: "db/migrations"
    gen:
      go:
        package: "db"
        out: "internal/data/db"
        sql_package: "pgx/v5" # <--- 指定驱动
```
## 类型覆写

`NUMERIC(10,2)`在golang中对应的类型是`pgtype.Numeric`不方便使用。
**Best Pracetice**:
	使用[Decimal库](https://github.com/shopspring/decimal)，并配置类型覆写。

```yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "db/query"
    schema: "db/migrations"
    gen:
      go:
        package: "db"
        out: "internal/data/db"
        sql_package: "pgx/v5"
        overrides:
          - db_type: "pg_catalog.numeric" #  or `nuemric` or `money`
            go_type:
              import: "github.com/shopspring/decimal"
              type: "Decimal"
```
**简写**：
```yaml
overrides:
          - db_type: "pg_catalog.numeric"
            go_type: "github.com/shopspring/decimal.Decimal"
```

## 改造事务和context
```go
// 改造事务管理器：不仅注入 sqlc，也暴露原生的 tx 供 River 使用
type txKey struct{}
type rawTxKey struct{} // 新增一个 key 存放 *sql.Tx

func (t *transaction) InTx(ctx context.Context, fn func(ctx context.Context) error) error {
	tx, _ := t.data.db.BeginTx(ctx, nil)
	defer tx.Rollback()

	// 将 sqlc 和原生 tx 都放进 context
	ctx = context.WithValue(ctx, txKey{}, t.data.q.WithTx(tx))
	ctx = context.WithValue(ctx, rawTxKey{}, tx)

	if err := fn(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

// 获取原生 tx 的辅助方法
func (d *Data) getRawTx(ctx context.Context) *sql.Tx {
	if tx, ok := ctx.Value(rawTxKey{}).(*sql.Tx); ok {
		return tx
	}
	return nil // 实际项目需处理非事务情况
}
```

可以提供原生`Tx` 给`River` 和手写的 sqlc 事务使用。