---
category: microservice
type: integration
topic: transaction
frameworks:
  - go-kratos
  - sqlc
  - riverqueue
status: seedling
tags:
  - microservice/go-kratos
  - database/sqlc
  - database/postgresql
  - message-queue/riverqueue
  - reliability/transaction
---

# Go-Kratos SQLC River MQ Transactions

这组笔记整理 Go-Kratos、sqlc、PostgreSQL 和 River Queue 组合使用时的事务边界。核心目标是：业务数据写入和 River 任务入队共享同一个 PostgreSQL 本地事务，避免“数据提交了但任务没入队”或“任务入队了但数据回滚”的一致性问题。

## 核心结论

- Kratos 的 Biz 层决定事务边界，Data/Repo 层只负责读写数据。
- sqlc 查询必须通过绑定事务的 `*Queries` 执行，才能真正参与事务。
- River 使用 `pgx/v5` 时可以直接把 `pgx.Tx` 传给 `InsertTx`。
- `Transaction.InTx` 应同时把 `sqlc.Queries` 和原生 `pgx.Tx` 放入 `context.Context`。
- 基础单条 CRUD 不需要强行包事务；跨表、状态机、Outbox、复杂校验才需要显式 `InTx`。
- 软删除需要额外处理唯一索引、查询作用域、级联语义和归档清理。

## 文档拆分

- [[Kratos SQLC pgx 事务管理]]：`Transaction.InTx`、`Data.DB(ctx)`、`GetPgxTx(ctx)` 的标准实现。
- [[River pgx 事务入队]]：River `pgx/v5` 驱动初始化和 `InsertTx` 用法。
- [[PaymentSync Repo 事务改造]]：支付同步场景中，如何把 Repo 内部事务改成 Biz 层事务。
- [[SQLC CRUD 事务边界]]：哪些 CRUD 不需要显式事务，哪些场景必须开启事务。
- [[PostgreSQL 软删除实践]]：软删除下的唯一索引、并发删除、查询作用域和级联处理。

## 推荐分层

```text
biz/
  Usecase 控制事务边界
  调用多个 Repo 或 JobRepo

data/
  Transaction 实现 InTx
  Repo 通过 Data.DB(ctx) 获取 sqlc Queries
  JobRepo 通过 Data.GetPgxTx(ctx) 获取原生 pgx.Tx

postgresql/
  业务表
  river job 表
  同一个本地事务提交
```

## 相关链接

- [[go-kratos架构]]
- [[SQLC使用]]
- [[river in go-kratos]]
- [[River key takeaway]]
- [[电商系统幂等性和细节]]
