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

## 先理解消费语义

Kafka 消费者组把 topic 的 partition 分配给同组中的多个实例：同一 partition 在同一时刻只会由组内一个消费者处理，因此能维持该 partition 内的顺序；不同 partition 则并行处理，不能假设全局顺序。消费者组通过已提交的 offset 记录进度，服务重启或 rebalance 后会从已提交位置继续。

这套模型通常提供**至少一次**处理语义：业务处理完成后再标记消息，消息可能因进程崩溃、提交延迟或 rebalance 被再次投递。因此业务函数应设计为幂等，例如使用唯一业务键、数据库唯一约束或可安全覆盖的写入，而不能假设每条重试消息只会执行一次。

> [!note] `MarkMessage` 的含义
> `session.MarkMessage` 将消息标记为“可提交”；真正提交到 broker 的时机取决于 sarama 的自动提交配置和 session 生命周期。它不是业务事务的提交，也不能撤销已经执行的外部副作用。

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
- `MarkMessage(msg, metadata)` — 标记 offset，表示这条消息已处理并可由 sarama 提交
- `Context()` — 会话级 context，rebalance 时会被 cancel

`ConsumerGroupClaim` 代表分配到的一个 partition，`claim.Messages()` 是一个只读 channel，消息按序推入。

生命周期方法不应长期阻塞：`Setup` 适合建立与本次 session 有关的轻量资源，`ConsumeClaim` 负责读取消息直到 session 结束，`Cleanup` 适合释放或刷新资源。当 rebalance 发生时，业务处理应尽快响应 `session.Context().Done()`；否则消费者无法及时让出 partition，可能扩大重平衡的影响范围。

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

        session.MarkMessage(msg, "")   // 标记 offset，等待 sarama 提交
    }
    return nil
}
```

这是标准的**函数适配器**模式（类似 `http.HandlerFunc`）：接口有三个方法，但实际业务只关心消息内容，`Setup`/`Cleanup` 留空，`ConsumeClaim` 里的 for-range 循环就是消费主循环，业务逻辑被抽象成一个 `func(ctx, key, value)`。它把框架的 session、claim 和 offset 协议集中在基础设施层，使业务层只需接收 trace context、key 与 value。

这种抽象的边界也很清楚：传入的函数没有返回 `error`，所以它不能直接要求框架“不要确认这条消息”。`handleRetryMessage` 一类函数必须在内部记录反序列化或业务失败，并决定是否把失败交给下一次延迟投递、告警或人工回放；不能把错误悄悄吞掉。

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

同一 claim 内必须按读取顺序完成处理并标记 offset。若为提升吞吐把单个 partition 的消息随意扇出到异步 goroutine，后面的消息可能先被标记提交，进程崩溃时就会跳过前面的未完成消息。确需并发时，应保留有序确认机制，或让消息键确保同一业务实体落在同一 partition 并串行处理。

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
        // 未标记 offset；消息会在后续分配/重新消费时再次可见
        time.Sleep(time.Second)
        return nil
    }
    return nil
}
```

> [!tip] 为什么 return nil 不会丢消息
> 只有被 `session.MarkMessage` 标记的 offset 才会进入提交流程。没有 mark 就 return，后续分配或重新消费会从上次已提交的位置继续，因此该消息仍可再次被读到。这是 delay queue 的“等待”机制基础；但具体重投时机受 consumer session 与 sarama 配置影响，不能把一次 `return` 当作精确的定时器。

这种“按消息时间戳轮询”的延迟实现简单，但会让同一 partition 上排在前面的未到期消息阻塞后面的消息，也会在未到期期间重复拉起消费会话。延迟精度、吞吐与成本取决于 `delayTime`、消息分区方式和轮询间隔；若延迟队列规模显著增长，应评估专门的调度存储、按到期时间分桶，或具备延迟投递能力的消息系统。

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

关闭服务时，`c.cctx` 应由应用生命周期统一 cancel，促使正在运行的 `cg.Consume` 退出，并由 `defer cg.Close()` 释放客户端资源。仅停止启动 goroutine 而不 cancel context，消费者仍可能继续持有 partition；仅 cancel 而不等待 goroutine 退出，则可能在进程强制结束前丢失尚未完成的日志或指标。优雅停机通常需要“停止接流量 → cancel 消费 context → 等待 goroutine → 关闭 client”的顺序。

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

两个消费者使用不同的 group ID 和不同的职责，不能互换：delay consumer 负责保留尚未到期的消息并转发，real consumer 负责执行实际业务。若两个实例误用同一个 group ID 或订阅错误 topic，可能表现为消息被其他实例分走、重复转发，或重试任务永远没有真正执行。

### 两者的对比

| | delay topic 消费者 | real topic 消费者 |
|---|---|---|
| 启动位置 | `NewDelayKafka`（基础设施层） | `NewClassUsecase`（业务层） |
| handler | `DelaySendHandler`（完整实现） | `FuncConsumeHandler`（函数适配） |
| 职责 | 时间门控，到期转发 | 触发重试爬虫 |
| 消费 topic | `be-classlist-delay` | `be-classlist-real` |

> [!note] 防止误用
> `DelayKafka.Consume` 内部检查了 `groupID != d.proxyGroupID`，防止外部消费者误用 delay topic 的 group ID，确保 delay topic 只由内部的 `DelaySendHandler` 消费。

## 监控、告警与测试

建议至少记录以下观测项，以便把“Kafka 有消息”与“重试已经生效”区分开来：

| 观测项 | 用途 |
|---|---|
| consumer group lag（分别按 delay / real topic） | 发现消费者停滞、分区积压或处理能力不足 |
| 消息转发成功与失败数 | 识别 delay topic 到 real topic 的断点 |
| 过期丢弃数（`>= 20 × delayTime`） | 发现长时间故障或延迟配置不合理 |
| `handleRetryMessage` 的解析与爬虫失败数 | 区分坏消息、业务失败和外部系统故障 |
| rebalance 次数与 session 时长 | 发现频繁扩缩容、网络抖动或停机不规范 |

测试应覆盖至少五种情况：单 partition 顺序消费、业务成功后 offset 被标记、业务函数 panic/失败时的观测与恢复、rebalance 后外层 `Consume` 重新加入，以及未到期 delay 消息不会被转发。对重试业务还要验证重复消息不会产生重复课程或破坏刷新日志状态。

本文的业务上下文和消息从爬虫失败到重新刷新课表的完整路径，见 [[华师匣子课表查询-GetClass调用链#Kafka 延迟重试机制]]。
