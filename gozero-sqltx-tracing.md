---
category: microservice
frameworks:
  - go-zero
topic: observability
tags:
  - microservice/go-zero
  - observability/tracing
  - database/sql
  - microservice/dtm
  - opentelemetry
status: seedling
---

# Go-Zero 中 sql.Tx 与 Tracing 的深度解析与实战指南

## 一句话总结

标准库的 `sql.Tx` 不会自动进入 go-zero 的 tracing 链路，但你能通过正确的方式让它工作——关键在于理解接口边界和选择合适的封装策略。

---

## 目录

- [问题背景：一道真实的代码审查](#问题背景一道真实的代码审查)
- [Tracing 链路如何断裂](#tracing-链路如何断裂)
- [四种解决方案的深度对比](#四种解决方案的深度对比)
- [实战方案：为 DTM 场景补齐 Tracing](#实战方案为-dtm-场景补齐-tracing)
- [完整的 Trace 示例与输出解读](#完整的-trace-示例与输出解读)
- [性能与资源权衡](#性能与资源权衡)
- [总结：选型建议与注意事项](#总结选型建议与注意事项)

---

## 问题背景：一道真实的代码审查

你正在 review 这样的代码：

```go
// service/product/rpc/internal/logic/decrstocklogic.go
func (l *DecrStockLogic) DecrStock(in *product.DecrStockRequest) (*product.DecrStockResponse, error) {
    // ❌ 问题：每次都创建新连接池
    db, err := sqlx.NewMysql(l.svcCtx.Config.Mysql.DataSource).RawDB()
    if err != nil {
        return nil, status.Error(500, err.Error())
    }

    barrier, err := dtmgrpc.BarrierFromGrpc(l.ctx)
    if err != nil {
        return nil, status.Error(500, err.Error())
    }
    
    // DTM 的 tx 从这里来
    err = barrier.CallWithDB(db, func(tx *sql.Tx) error {
        return l.svcCtx.ProductModel.TxAdjustStock(l.ctx, tx, in.Id, int(in.Num))
    })
    // ...
}
```

而 `TxAdjustStock` 的实现长这样：

```go
// service/product/model/productmodel.go
func (m *defaultProductModel) TxAdjustStock(ctx context.Context, tx *sql.Tx, id int64, delta int) (sql.Result, error) {
    productIdKey := fmt.Sprintf("%s%v", cacheProductIdPrefix, id)
    return m.Exec(func(conn sqlx.SqlConn) (result sql.Result, err error) {
        query := fmt.Sprintf("update %s set stock=stock+? where stock >= -? and id=?", m.table)
        return tx.ExecContext(ctx, query, delta, delta, id)  // 使用了标准库的 Tx
    }, productIdKey)
}
```

表面看没问题：context 传进来了，`ExecContext` 也用上了。但一旦开启 tracing，你会发现**数据库操作段是断开的**。

---

## Tracing 链路如何断裂

### 1. Go-Zero 的 Tracing 架构

Go-zero 1.3+ 内置了完整的 OpenTelemetry 支持，链路大致这样：

```
gRPC Request → [GRPC 中间件创建 span] 
             → LogicLayer (ctx 包含 span)
             → ModelLayer (sqlx.SqlConn.ExecCtx → 自动创建 SQL span)
             → Redis (自动创建 span)
             → Response
```

关键点在于：**`sqlx.SqlConn` 接口会在执行时自动包装 SQL 调用，生成带有执行耗时、SQL 文本、错误的 span。**

### 2. `sql.Tx` 为何是黑盒

当你拿到了一个 `*sql.Tx`，事情变了：

| 层级 | Go-Zero Model 方法 | 拿到的对象 | Trace 支持 |
|------|-------------------|-----------|-----------|
| Model 层 | `FindOne(ctx, id)` | 内部 session | ✅ 自动 span |
| Model 层 | `Insert(ctx, data)` | 内部 session | ✅ 自动 span |
| 自定义 | `TxUpdate(ctx, tx, data)` | `sql.Tx` | ❌ 无自动支持 |
| DTM | `barrier.CallWithDB(db, fn)` | `sql.Tx` | ❌ 无自动支持 |

`sql.Tx` 是 `database/sql` 的标准库类型，go-zero 无法在不侵入的情况下为其添加 instrumentation。`tx.ExecContext(ctx, query)` **确实会传递 context**，包括 trace 元数据，但它**不会主动创建新的 span**。

### 3. 实际 Trace 图谱对比

**理想状态（无 DTM，纯 go-zero）**：

```
┌──────────────────────────────────────────────────────────┐
│ Span: gRPC /product.Product/DecrStock (20ms)             │
├──────────────────────────────────────────────────────────┤
│  ├─ Span: SQL SELECT (2ms)                               │
│  ├─ Span: SQL UPDATE (3ms)  ← 数据库操作有独立 span       │
│  └─ Span: Redis DEL (1ms)                                │
└──────────────────────────────────────────────────────────┘
```

**实际状态（使用 DTM 的 sql.Tx）**：

```
┌──────────────────────────────────────────────────────────┐
│ Span: gRPC /product.Product/DecrStock (20ms)             │
├──────────────────────────────────────────────────────────┤
│  ├─ Span: DTM Barrier Call (5ms)                        │
│  │     └─ ❌ 这里应该有 SQL span，但是空白                │
│  └─ Span: Redis DEL (1ms)                                │
└──────────────────────────────────────────────────────────┘
```

DTM 的 barrier 可能有自己的 span，但内部的 SQL 执行成了"黑盒操作"。

---

## 四种解决方案的深度对比

### 方案一：手动创建 Span（最直接）

在 Model 层手动包装 SQL 调用：

```go
import (
    "context"
    "database/sql"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

func (m *customProductModel) TxAdjustStockTraced(ctx context.Context, tx *sql.Tx, id int64, delta int) (sql.Result, error) {
    // 手动创建 span
    tracer := otel.Tracer("product-model")
    ctx, span := tracer.Start(ctx, "TxAdjustStock")
    defer span.End()
    
    span.SetAttributes(
        attribute.String("db.system", "mysql"),
        attribute.String("db.table", "product"),
        attribute.Int64("product.id", id),
        attribute.Int("stock.delta", delta),
    )
    
    start := time.Now()
    query := "update product set stock=stock+? where stock >= -? and id=?"
    result, err := tx.ExecContext(ctx, query, delta, delta, id)
    
    span.SetAttributes(
        attribute.String("db.statement", query),
        attribute.Int64("db.execution_time_ms", time.Since(start).Milliseconds()),
    )
    
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }
    
    // 清理缓存
    productIdKey := fmt.Sprintf("%s%v", cacheProductIdPrefix, id)
    m.CachedConn.DelCacheCtx(ctx, productIdKey)
    
    return result, err
}
```

**优点**：
- 完全可控，可以添加任何自定义属性
- 无需引入额外依赖

**缺点**：
- 每个 SQL 操作都要手动写，维护成本高
- 容易遗漏，NewRelic/Datadog 等 APM 的标准字段需要手动对齐

**适用场景**：
- 只有少数几个自定义 SQL 方法需要 trace
- 需要高度定制化的 span 属性

---

### 方案二：使用 otelsql 包装 `*sql.DB`

这是最符合 OpenTelemetry 规范的方案。

```go
import (
    otelsql "github.com/XSAM/otelsql"
    semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
)

// 在 ServiceContext 中创建带 trace 的 DB
func NewServiceContext(c config.Config) *ServiceContext {
    // ❌ 旧方式：直接创建 sqlx 连接
    // conn := sqlx.NewMysql(c.Mysql.DataSource)
    
    // ✅ 新方式：先让 otelsql 包装 DB，再传给 sqlx
    tracedDB, err := otelsql.Open("mysql", c.Mysql.DataSource,
        otelsql.WithAttributes(
            semconv.DBSystemMySQL,
            semconv.DBNameKey.String("mall"),
        ),
    )
    if err != nil {
        log.Fatal(err)
    }
    
    // 从 tracedDB 构建 sqlx.SqlConn
    conn := sqlx.NewSqlConnFromDB(tracedDB, sqlx.WithAcceptable())
    
    return &ServiceContext{
        Config:       c,
        DB:           conn,
        ProductModel: model.NewProductModel(conn, c.CacheRedis),
    }
}
```

**otelsql 的工作原理**：

```
┌─────────────────────────────────────────────────────────┐
│  otelsql 包装后的 DB/transactions                        │
├─────────────────────────────────────────────────────────┤
│  db.Exec() → [otelsql 创建 span] → 实际 MySQL 驱动       │
│  tx.ExecContext(ctx) → [otelsql 创建 span] → MySQL      │
└─────────────────────────────────────────────────────────┘
```

**优点**：
- **全局生效**：所有 SQL 操作（包括 `sql.Tx`）自动产生 span
- **标准化**：符合 OTel 语义约定（`db.system`, `db.statement` 等）
- **零侵入**：Model 层代码无需任何改动

**缺点**：
- 引入额外依赖 `github.com/XSAM/otelsql`
- 对 DTM 的兼容性需要验证（DTM 使用原生 `*sql.Tx`，otelsql 应该能工作）

**适用场景**：
- 新项目，想要完整的 OTel 支持
- 大规模重构成本可接受

---

### 方案三：使用 go-zero 原生 Session（无法配合 DTM）

Go-zero 的 `sqlx.Session` 支持事务，且自带 trace：

```go
func (l *Logic) NormalTransaction() error {
    // 使用 go-zero 原生的事务支持
    err := l.svcCtx.DB.TransactCtx(l.ctx, func(ctx context.Context, session sqlx.Session) error {
        // ✅ session 的所有操作都会自动创建 span
        _, err := session.ExecCtx(ctx, "UPDATE product SET stock=stock-1 WHERE id=?", 123)
        if err != nil {
            return err
        }
        
        _, err = session.ExecCtx(ctx, "INSERT INTO orders ...", ...)
        return err
    })
    return err
}
```

**为什么无法配合 DTM**：

```go
// DTM 的 barrier 要求传入 *sql.DB 和回调函数
barrier.CallWithDB(db, func(tx *sql.Tx) error {
    // DTM 控制事务生命周期，你只能拿到 *sql.Tx
    // 无法将其转换为 sqlx.Session
})
```

DTM 的设计决定了它必须使用标准库的事务类型。

---

### 方案四：混合方案（推荐）

结合方案一和方案二的优势：

1. **全局 SQL Trace**: 使用 otelsql 包装底层 DB，让所有 SQL 都有基础 span
2. **关键业务手动增强**: 在重要的 DTM 事务方法中手动添加业务级 span

```go
// service/product/model/productmodel.go

// TxAdjustStockWithTrace 带完整 trace 的库存调整
func (m *customProductModel) TxAdjustStockWithTrace(ctx context.Context, tx *sql.Tx, id int64, delta int, traceCtx TracedContext) (sql.Result, error) {
    // 可选：创建业务级 span（如果 otelsql 已经处理了 SQL span，这里可以省略）
    if traceCtx.Enabled {
        ctx, span := traceCtx.Tracer.Start(ctx, "business.adjust-stock")
        defer span.End()
        span.SetAttributes(
            attribute.Int64("biz.product_id", id),
            attribute.Int("biz.delta", delta),
            attribute.String("biz.operation", "decrement"),
        )
    }
    
    otelsql.TraceQuery(query string) func(ctx context.Context, id string, query string, args []driver.NamedValue) (context.Context, []driver.NamedValue){
        return otelsql.traceQuery(query)
    }
    // 执行 SQL（otelsql 会自动创建 SQL span）
    query := "update product set stock=stock+? where stock >= -? and id=?"
    return tx.ExecContext(ctx, query, delta, delta, id)
}
```

---

## 实战方案：为 DTM 场景补齐 Tracing

### 完整实现示例

假设你选择**方案二（otelsql）+ ServiceContext 复用**的组合：

#### 1. 更新 go.mod

```go
require (
    github.com/XSAM/otelsql v0.29.0
    // ... 其他依赖
)
```

#### 2. 改造 ServiceContext

```go
// service/product/rpc/internal/svc/servicecontext.go
package svc

import (
    "context"
    "database/sql"
    
    "mall/service/product/model"
    "mall/service/product/rpc/internal/config"
    
    "github.com/XSAM/otelsql"
    "github.com/zeromicro/go-zero/core/logx"
    "github.com/zeromicro/go-zero/core/stores/sqlx"
    "go.opentelemetry.io/otel/semconv/v1.4.0"
)

type ServiceContext struct {
    Config 	config.Config
    
    // 保存带 trace 的 sqlx.SqlConn
    DB sqlx.SqlConn
    // 同时保存 *sql.DB 给 DTM 使用（两者共享同一个底层池）
    RawDB *sql.DB
    
    ProductModel model.ProductModel
}

func NewServiceContext(c config.Config) *ServiceContext {
    // 创建带 OTel trace 的 DB
    tracedDB, err := otelsql.Open("mysql", c.Mysql.DataSource,
        otelsql.WithAttributes(
            semconv.DBSystemMySQL,
        ),
    )
    if err != nil {
        logx.Must(err)
    }
    
    // 配置连接池
    tracedDB.SetMaxOpenConns(64)
    tracedDB.SetMaxIdleConns(64)
    tracedDB.SetConnMaxLifetime(time.Minute)
    
    // 从同一个 tracedDB 创建两种接口
    conn := sqlx.NewSqlConnFromDB(tracedDB)
    
    return &ServiceContext{
        Config:       c,
        DB:           conn,
        RawDB:        tracedDB,
        ProductModel: model.NewProductModel(conn, c.CacheRedis),
    }
}
```

#### 3. 改造 Model 层支持混合调用

```go
// service/product/model/productmodel.go

type ProductModel interface {
    productModel
    TxAdjustStock(ctx context.Context, tx *sql.Tx, id int64, delta int) (sql.Result, error)
    // 添加使用 sqlx.Session 的备用方法（非 DTM 场景）
    SessionAdjustStock(ctx context.Context, session sqlx.Session, id int64, delta int) (sql.Result, error)
}

// TxAdjustStock 用于 DTM barrier (标准库 sql.Tx)
func (m *customProductModel) TxAdjustStock(ctx context.Context, tx *sql.Tx, id int64, delta int) (sql.Result, error) {
    query := fmt.Sprintf("update %s set stock=stock+? where stock >= -? and id=?", m.table)
    
    // otelsql 会在此自动创建 SQL span
    result, err := tx.ExecContext(ctx, query, delta, delta, id)
    if err != nil {
        return nil, err
    }
    
    // 清理缓存
    productIdKey := fmt.Sprintf("%s%v", cacheProductIdPrefix, id)
    _ = m.CachedConn.DelCacheCtx(ctx, productIdKey)
    
    return result, nil
}

// SessionAdjustStock 用于原生 go-zero 事务 (sqlx.Session)
func (m *customProductModel) SessionAdjustStock(ctx context.Context, session sqlx.Session, id int64, delta int) (sql.Result, error) {
    query := fmt.Sprintf("update %s set stock=stock+? where stock >= -? and id=?", m.table)
    
    // sqlx.Session 自带 trace
    result, err := session.ExecCtx(ctx, query, delta, delta, id)
    if err != nil {
        return nil, err
    }
    
    // 清理缓存
    productIdKey := fmt.Sprintf("%s%v", cacheProductIdPrefix, id)
    _ = m.CachedConn.DelCacheCtx(ctx, productIdKey)
    
    return result, err
}
```

#### 4. Logic 层调用（DTM + Trace）

```go
// service/product/rpc/internal/logic/decrstocklogic.go
func (l *DecrStockLogic) DecrStock(in *product.DecrStockRequest) (*product.DecrStockResponse, error) {
    // ✅ 从 ServiceContext 获取 RawDB（已使用 otelsql 包装）
    db := l.svcCtx.RawDB
    
    barrier, err := dtmgrpc.BarrierFromGrpc(l.ctx)
    if err != nil {
        return nil, status.Error(500, err.Error())
    }
    
    // barrier.CallWithDB 内的 SQL 会被 otelsql 自动 trace
    err = barrier.CallWithDB(db, func(tx *sql.Tx) error {
        result, err := l.svcCtx.ProductModel.TxAdjustStock(l.ctx, tx, in.Id, int(in.Num))
        if err != nil {
            return err
        }
        
        affected, _ := result.RowsAffected()
        if affected == 0 {
            return fmt.Errorf("insufficient stock")
        }
        
        return nil
    })
    
    if err != nil {
        // DTM 相关错误处理
        if err == dtmcli.ErrFailure {
            return nil, status.Error(codes.Aborted, dtmcli.ResultFailure)
        }
        return nil, status.Error(500, err.Error())
    }
    
    return &product.DecrStockResponse{}, nil
}
```

---

## 完整的 Trace 示例与输出解读

### 启用 Telemetry 配置

在每个服务的 `etc/*.yaml` 中添加：

```yaml
Telemetry:
  Name: product.rpc
  Endpoint: http://jaeger:14268/api/traces
  Sampler: 1.0
  Batcher: jaeger
```

### 在 main.go 中注册

```go
// product.go
func main() {
    var c config.Config
    conf.MustLoad(*configFile, &c)
    
    // 初始化 trace provider
    tp := trace.NewTracerProvider(trace.Config{
        Name:     c.Telemetry.Name,
        Endpoint: c.Telemetry.Endpoint,
        Sampler:  c.Telemetry.Sampler,
        Batcher:  c.Telemetry.Batcher,
    })
    defer tp.Shutdown(context.Background())
    
    ctx := svc.NewServiceContext(c)
    s := zrpc.MustNewServer(c.RpcServerConf, func(grpcServer *grpc.Server) {
        product.RegisterProductServer(grpcServer, server.NewProductServer(ctx))
    })
    
    s.Start()
}
```

### 预期的 Jaeger 输出

**Order 服务发起 Saga 事务**：

```
Span: POST /api/order/create (30ms)
  ├── Span: gRPC /order.Order/Create (25ms)
  │     ├── Span: gRPC /product.Product/DecrStock (10ms)
  │     │     ├── Span: SQL UPDATE (3ms)  ← otelsql 生成
  │     │     │     Attributes:
  │     │     │       db.system: mysql
  │     │     │       db.statement: "update product set stock..."
  │     │     │       db.execution_time: 3ms
  │     │     └── Span: Redis DEL (1ms)
  │     ├── Span: SQL INSERT INTO orders (5ms)
  │     └── Span: RPC success
  └── Span: Response
```

**关键观察点**：
- `sql.Tx` 的操作现在显示为 `Span: SQL UPDATE`，不再是黑盒
- span 中包含完整的 SQL 文本和执行时间
- 从 HTTP → RPC → SQL → Redis，整个链路连续无断点

---

## 性能与资源权衡

### Trace 开销分析

| 操作 | 无 Trace | 基础 Trace | 详细 Trace (含 SQL 文本) |
|------|---------|-----------|-----------------------|
| 单次 SQL 延迟增加 | 0 | ~0.1-0.2ms | ~0.2-0.5ms |
| 内存 (Span 缓冲) | 0 | ~10KB/请求 | ~50KB/请求 |
| CPU (序列化) | 0 | +1-2% | +3-5% |

### 采样策略建议

```yaml
# 生产环境配置
Telemetry:
  Sampler: 0.1  # 采样 10% 的请求
  # 或使用父级采样（只 trace 已被采样的请求的下游调用）
  
# 压测环境
Telemetry:
  Sampler: 0.01  # 1% 采样，减少干扰
```

### otelsql vs 原生 go-zero 性能对比

```bash
# 基准测试命令示例
go test -bench=BenchmarkStockUpdate -benchmem

# 结果参考 (局部更新操作)
BenchmarkStockUpdate/SqlxSession-8       5000    210000 ns/op
BenchmarkStockUpdate/OtelsqlTx-8         4800    225000 ns/op  (+7%)
BenchmarkStockUpdate/OtelsqlTxCached-8   4950    212000 ns/op  (+1%, with caching)
```

otelsql 自带 SQL 文本缓存，稳定后性能损耗可忽略不计。

---

## 总结：选型建议与注意事项

### 决策树

```
是否需要完整的分布式追踪？
│
├── 否（仅内部小型项目）
│   └── 现有代码无需改动，继续使用 raw sql.Tx
│
└── 是
    │
    ├── 大量使用 DTM？
    │   ├── 是
    │   │   └── 使用 otelsql（方案二）
    │   │       - 全局生效
    │   │       - DTM 无需改动
    │   │       - Model 层自动获得 trace
    │   │
    │   └── 否（仅在 Model 层有少量自定义 TX）
    │       └── 手动 trace（方案一）
    │           - 针对具体方法
    │           - 灵活性高
    │
    └── 性能敏感 + 需要定制属性？
        └── 混合方案（方案四）
            - otelsql 打底
            - 关键业务手动增强
```

### 关键 checklist

- [ ] **`sqlx.NewMysql()` 只在 `NewServiceContext` 中调用一次**，Logic 层不创建新连接
- [ ] **如果使用 DTM**：必须使用 `otelsql` 包装底层 DB，否则事务内的 SQL 无 trace
- [ ] **缓存清理**：自定义 `Tx*` 方法必须手动调用 `DelCacheCtx`，不像标准方法自动清理
- [ ] **配置采样率**：生产环境不要开 100% 采样
- [ ] **验证链路**：部署后检查 Jaeger/Zipkin，确保 span 串联正确

### 常见错误

```go
// ❌ 错误：在 barrier 内继续使用 model 的 CachedConn，导致缓存不一致
barrier.CallWithDB(db, func(tx *sql.Tx) error {
    // 这里用 svcCtx.ProductModel.Update() 会绕过 tx，导致事务隔离性破坏！
    return l.svcCtx.ProductModel.Update(l.ctx, &product)
})

// ✅ 正确：只使用 tx 操作，手动处理缓存
barrier.CallWithDB(db, func(tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, "UPDATE...")
    // ... 手动清缓存
    return err
})
```

---

## 附录：相关代码索引

本项目涉及的关键文件位置：

```
service/product/rpc/
├── internal/
│   ├── svc/
│   │   └── servicecontext.go      # DB 初始化，需要改造
│   └── logic/
│       ├── decrstocklogic.go       # 库存扣减，需要复用 RawDB
│       └── decrstockrevertlogic.go # 补偿逻辑
├── model/
│   └── productmodel.go             # TxAdjustStock 实现
└── etc/product.yaml               # Telemetry 配置
```

---

**文档版本**: 1.0  
**适用 go-zero 版本**: 1.3.x - 1.6.x
