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
