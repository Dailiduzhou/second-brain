---
title: Sarama ConsumerGroup 使用解析
category: ccnubox
type: deep-dive
topic: kafka
status: seedling
tags:
  - kafka
  - ccnubox
aliases:
  - sarama consumer group
---

> [!abstract] 本文定位
> 以 [[华师匣子课表查询-GetClass调用链]] 中的延迟重试队列为例，解释 sarama 消费者组的核心用法：`ConsumerGroupHandler` 接口的职责、函数适配器模式、消费主循环位置，以及项目启动时两条消费者 goroutine 的初始化时机。

## ConsumerGroupHandler 是什么

sarama 用 `ConsumerGroupHandler` 接口描述"消费者组里的一个消费者该做什么"。它有三个方法：

```go
// github.com/IBM/sarama
type ConsumerGroupHandler interface {
    // 每次 rebalance 完成、消费者加入新一轮会话时调用。
    // 可以在这里初始化资源，比如重置计数器、建立连接。
    Setup(ConsumerGroupSession) error

    // 会话结束（rebalance 或关闭）时调用。
    // 可以在这里做清理，比如刷缓冲区、关闭连接。
    Cleanup(ConsumerGroupSession) error

    // 核心方法。每个分配到的 partition 都会调用一次，在独立 goroutine 中运行。
    // claim.Messages() 返回一个 channel，消息从这里读出来处理。
    // 函数返回后，sarama 才会认为该 partition 的消费结束。
    ConsumeClaim(session ConsumerGroupSession, claim ConsumerGroupClaim) error
}
```

三个方法对应消费者组的生命周期：

```
rebalance 完成
    → Setup()          ← 准备阶段
    → ConsumeClaim()   ← 并发消费（每个 partition 一个 goroutine）
    → Cleanup()        ← 清理阶段
rebalance 或关闭
    → 重新来一轮
```

`ConsumerGroupSession` 提供两个关键能力：
- `MarkMessage(msg, metadata)` — 提交 offset，告诉 broker 这条消息已处理
- `Context()` — 会话级 context，rebalance 时会被 cancel

`ConsumerGroupClaim` 代表分配到的一个 partition，`claim.Messages()` 是一个只读 channel，消息按序推入。

## FuncConsumeHandler：把函数包成接口

项目里不想每次都写一个完整的结构体来实现接口，于是封装了 `FuncConsumeHandler`：

```go
// events/consumer/consumer.go
type FuncConsumeHandler struct {
    f   func(ctx context.Context, key, value []byte)
    log logger.Logger
    m   *metricsx.Metrics
}

func NewFuncConsumeHandler(f func(ctx context.Context, key, value []byte), ...) *FuncConsumeHandler {
    return &FuncConsumeHandler{f: f, ...}
}

// Setup 和 Cleanup 不需要做任何事，返回 nil 即可
func (h *FuncConsumeHandler) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (h *FuncConsumeHandler) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }

func (h *FuncConsumeHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for msg := range claim.Messages() {
        // 提取 OTel trace context（从 Kafka header 里传播）
        ctx := otel.GetTextMapPropagator().Extract(context.Background(), otelsarama.NewConsumerMessageCarrier(msg))

        h.f(ctx, msg.Key, msg.Value)   // 调用传入的业务函数

        session.MarkMessage(msg, "")   // 提交 offset
    }
    return nil
}
```

这是标准的**函数适配器**模式（类似 `http.HandlerFunc`）：接口有三个方法，但实际业务只关心消息内容，`Setup`/`Cleanup` 留空，`ConsumeClaim` 里的 for-range 循环就是消费主循环，业务逻辑被抽象成一个 `func(ctx, key, value)`。

调用方只需传入一个函数：

```go
// events/delay/delay.go
func (d *DelayKafka) Consume(groupID string, f func(ctx context.Context, key, value []byte)) error {
    handler := consumer.NewFuncConsumeHandler(f, d.log, d.m)
    return d.c.Consume([]string{d.realTopic}, groupID, handler)
}
```

而不是：

```go
// 不需要这样做 ↓
type myHandler struct{}
func (h myHandler) Setup(...) error   { return nil }
func (h myHandler) Cleanup(...) error { return nil }
func (h myHandler) ConsumeClaim(...) error { /* ... */ }
```

## 消费主循环在哪里

两种 handler 各有自己的消费主循环，位置不同。

### FuncConsumeHandler（real topic）

主循环就是 `ConsumeClaim` 里的 `for msg := range claim.Messages()`。`claim.Messages()` 这个 channel 在 rebalance 或 session 结束时会被关闭，for-range 自然退出，函数返回，sarama 框架收回这个 goroutine。

### DelaySendHandler（delay topic）

delay topic 的消费逻辑更复杂，需要检查消息年龄，所以项目单独实现了完整的 `ConsumerGroupHandler`：

```go
// events/consumer/consumer.go（DelaySendHandler）
func (c *DelaySendHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for message := range claim.Messages() {
        dur := time.Since(message.Timestamp)

        if dur >= c.delayTime {
            if c.delayTime > 0 && dur >= 20*c.delayTime {
                // 消息积压太久，直接丢弃
                session.MarkMessage(message, "")
                continue
            }
            // 到期，转发到 real topic
            c.forwardMessage(ctx, message)
            session.MarkMessage(message, "")
            continue
        }

        // 未到延迟时间：休眠 1 秒，然后 return nil
        // return 会让 sarama 重新调用 ConsumeClaim，消息重新出现在 channel 里
        time.Sleep(time.Second)
        return nil
    }
    return nil
}
```

> [!tip] 为什么 return nil 不会丢消息
> 只有调用 `session.MarkMessage` 才会提交 offset。没有 mark 就 return，sarama 下次重新分配这个 partition 时，会从上次提交的 offset 继续消费，消息不会丢失。这是 delay queue 的"等待"机制的实现基础。

## 外层消费循环：Consumer.Consume

`ConsumeClaim` 只处理单次 session 内的消息。rebalance 发生后（比如增减消费者、网络抖动），当前 session 结束，`ConsumeClaim` 返回，`Cleanup` 被调用，整个消费者组需要重新加入。

这个"重新加入"的循环在 `Consumer.Consume` 里：

```go
// events/consumer/consumer.go
func (c *Consumer) Consume(topics []string, groupID string, handler sarama.ConsumerGroupHandler) error {
    cg, err := sarama.NewConsumerGroupFromClient(groupID, c.client)
    if err != nil {
        return err
    }
    defer cg.Close()

    for {
        // 每次调用 cg.Consume 对应一次完整的 session 生命周期：
        // Setup → ConsumeClaim（并发）→ Cleanup
        if err := cg.Consume(c.cctx, topics, handler); err != nil {
            return err
        }
        // context 被 cancel（服务关闭），退出循环
        if c.cctx.Err() != nil {
            return c.cctx.Err()
        }
        // 否则继续循环，重新加入消费者组（处理 rebalance）
    }
}
```

两层循环的关系：

```
Consumer.Consume（外层 for）
    ↓ 每次 rebalance 后重新加入
cg.Consume（一次 session）
    ↓ 为每个分配到的 partition 启动 goroutine
ConsumeClaim（per-partition 消费循环）
    ↓ for msg := range claim.Messages()
    处理消息，MarkMessage
```

## 项目启动时的两条消费者 goroutine

项目里有两个独立的 Kafka 消费者，在不同时机启动：

### 1. delay topic 消费者 — 在 `NewDelayKafka` 里启动

```go
// events/delay/delay.go
func NewDelayKafka(...) (biz.DelayQueue, func(), error) {
    // ... 初始化各组件

    go func() {
        if err := dk.consumeDelay(); err != nil {
            dk.log.Errorf("Error consuming delay topic: %v", err)
        }
    }()

    return dk, dk.Close, nil
}

func (d *DelayKafka) consumeDelay() error {
    return d.c.Consume([]string{d.delayTopic}, d.proxyGroupID, d.delaySend)
}
```

`NewDelayKafka` 是基础设施的构造函数，由 wire 在应用启动时调用。构造完成即启动消费，消费 `be-classlist-delay` topic，负责把到期的消息转发到 real topic。

### 2. real topic 消费者 — 在 `NewClassUsecase` 里启动

```go
// biz/usecase/classer.go
func NewClassUsecase(..., queue biz.DelayQueue, ...) *ClassUsecase {
    cluc := &ClassUsecase{ /* ... */ }
    cluc.startRetryConsumer()
    return cluc
}

func (cluc *ClassUsecase) startRetryConsumer() {
    if cluc.delayQue == nil {
        return
    }
    go func() {
        if err := cluc.delayQue.Consume(refreshRetryConsumerGroup, cluc.handleRetryMessage); err != nil {
            cluc.log.Errorf("delayQue.Consume retry msg failed: %+v", err)
        }
    }()
}
```

`NewClassUsecase` 是业务层的构造函数，同样由 wire 调用。消费 `be-classlist-real` topic，收到消息后调用 `GetClasses(refresh=true)` 执行真正的重试爬虫。

### 两者的对比

| | delay topic 消费者 | real topic 消费者 |
|---|---|---|
| 启动位置 | `NewDelayKafka`（基础设施层） | `NewClassUsecase`（业务层） |
| handler | `DelaySendHandler`（完整实现） | `FuncConsumeHandler`（函数适配） |
| 职责 | 时间门控，到期转发 | 触发重试爬虫 |
| 消费 topic | `be-classlist-delay` | `be-classlist-real` |

> [!note] 防止误用
> `DelayKafka.Consume` 内部检查了 `groupID != d.proxyGroupID`，防止外部消费者误用 delay topic 的 group ID，确保 delay topic 只由内部的 `DelaySendHandler` 消费。
