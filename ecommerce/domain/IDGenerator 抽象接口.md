---
category: ecommerce
type: pattern
topic: id-generator
frameworks:
  - go-kratos
module: foundation
status: done
tags:
  - ecommerce/foundation
  - id/snowflake
  - architecture/interface
  - microservice/go-kratos
aliases:
  - IDGenerator 接口
---

# IDGenerator 抽象接口

`IDGenerator` 是项目内对“唯一 ID / 订单号生成”的统一抽象，由 `biz` 层定义，`data` 层注入具体实现。Biz 层只依赖接口，避免直接耦合雪花算法或任何第三方库。

## 接口定义

```go
package biz

type IDGenerator interface {
    GenerateString() string
    GenerateOrderNo32(prefix string) string
    GenerateOrderNo64(prefix string, userID int64) string
}
```

## 方法语义

| 方法 | 用途 |
|------|------|
| `GenerateString` | 通用唯一 ID（订单主键、内部实体 ID），由调用方决定是否加前缀 |
| `GenerateOrderNo32` | 微信支付 `out_trade_no`，固定 32 位 |
| `GenerateOrderNo64` | 支付宝 `out_trade_no`，固定 64 位，含用户 ID 与随机串 |

> [!tip] 为什么不只用一个方法
> - 强制在接口层把位数约束和参数显式化，编译期拦截错误调用。
> - 切换底层实现（如 ULID、UUID v7）时只改 `data` 层。
> - 单测中可以直接 mock `IDGenerator`，生成确定性的测试订单号。

## 在 Kratos 分层中的位置

```text
service -> biz.IDGenerator (接口)
              ^
              | 注入
data    -> snowflakeGenerator (实现)
```

- `biz` 定义 `IDGenerator`。
- `data` 提供 `snowflakeGenerator` 实现（见 [[雪花 ID 生成器]]）。
- `Wire` / 手工 `Provider` 在 `server` 层把 `*snowflakeGenerator` 绑成 `biz.IDGenerator`。

## 使用模式

```go
type OrderUsecase struct {
    idGen biz.IDGenerator
    repo  OrderRepo
}

func (uc *OrderUsecase) CreateOrder(ctx context.Context, userID int64, items []Item) (*Order, error) {
    orderNo := uc.idGen.GenerateOrderNo32("OD")
    return uc.repo.Insert(ctx, &Order{
        OrderNo: orderNo,
        UserID:  userID,
        Items:   items,
    })
}
```

## 防坑

- 不要在 `biz` 层直接 `import` 雪花包或具体类型，保持抽象纯净。
- 不要让 `GenerateOrderNo32` 返回错误——位数规则已在实现层固化；上游调用方只关心前缀语义。
- 单测中提供 fake `IDGenerator`（计数器即可），避免 `time.Now()` 抖动导致 flaky test。

## 相关链接

- [[雪花 ID 生成器]]
- [[订单号唯一字段规范]]
- [[支付系统分层设计]]
- [[kratos layout]]
