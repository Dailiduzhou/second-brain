---
title: 华师匣子课表查询 — GetClass 调用链分析
category: ccnubox
type: deep-dive
topic: classlist
status: seedling
tags:
  - ccnubox
  - database/singleflight
  - kafka
aliases:
  - be-classlist GetClass
---

> [!abstract] 本文定位
> 本文是 [[华师匣子课表查询]] 的续篇，专注于 `GetClass` 请求的完整调用链：从 gRPC 入口到 biz 层刷新决策，再到爬虫和 Kafka 延迟重试。

## 阅读前先统一语义

`GetClass` 同时承担“读取本地课表”和“按需触发刷新”两项职责。为避免把几个时间概念混在一起，本文使用以下约定：

- **本地数据**：缓存或数据库中已保存的课程及其最后刷新时间。
- **刷新日志**：记录一次爬虫任务处于 `Pending`、`Ready` 或 `Failed` 的状态，用于协调并发请求。
- **刷新间隔**：在这段时间内已有刷新任务时，后续请求优先等待或复用结果，而不是重复访问教务系统。
- **等待预算**：同步 RPC 愿意等待正在运行任务的最长时间；预算用尽并不代表刷新失败，只代表本次请求选择先返回旧数据。
- **延迟重试**：同步爬虫失败后投递的异步恢复机制，不改变当前请求的降级结果。

因此，该接口的优先级是“尽快给出可用课表，其次争取更新到最新”。调用者如果需要严格判断新鲜度，应同时检查返回的最后刷新时间，而不能把一次成功响应等同于一次成功爬取。

## 源码索引

本文中的代码片段来自 `source/ccnubox-be/be-classlist_v2` submodule 的提交 `afcc2ad`：

| 调用阶段 | 源码引用 |
|---|---|
| gRPC `GetClass` | [grpc/classlist.go](source/ccnubox-be/be-classlist_v2/grpc/classlist.go) |
| Service `GetClass` | [service/classlist.go](source/ccnubox-be/be-classlist_v2/service/classlist.go) |
| Biz `GetClasses` | [biz/usecase/classer.go](source/ccnubox-be/be-classlist_v2/biz/usecase/classer.go) |
| singleflight 与 `crawMergedClass` | [biz/usecase/classer_helpers.go](source/ccnubox-be/be-classlist_v2/biz/usecase/classer_helpers.go) |
| Delay/Real topic | [events/topic/topic.go](source/ccnubox-be/be-classlist_v2/events/topic/topic.go) |
| 延迟转发与消费者 | [events/delay/delay.go](source/ccnubox-be/be-classlist_v2/events/delay/delay.go)、[events/consumer/consumer.go](source/ccnubox-be/be-classlist_v2/events/consumer/consumer.go) |

这些链接用于从笔记中的分析直接回到 submodule 源码；源码版本由父仓库记录的 submodule 提交保证一致。

## 调用链总览

```
gRPC Handler (grpc/classlist.go)
    ↓ pb 解包
Service Layer (service/classlist.go)
    ↓ 默认值填充 + CheckSY 校验
Biz Layer — ClassUsecase.GetClasses
    ├── loadLocal          ← 先读本地（Cache + DB）
    ├── decideRefreshAction ← 决定数据来源
    │   ├── ActionReturnLocal   → 直接返回本地数据
    │   ├── ActionWaitPending   → 等待进行中的刷新任务完成
    │   └── ActionStartCrawl    → 发起爬虫
    └── doCrawlWithSingleflight
            ↓ singleflight 去重并发请求
        crawMergedClass
            ├── InsertRefreshLog (Pending)
            ├── getCourseFromCrawler
            │   └── 失败 → sendRetryMsg → Kafka delay topic
            ├── SaveClass (事务)
            ├── filterAddedClassesConflictingWithOfficial
            └── UpdateRefreshLog (Ready / Failed)
```

## gRPC 层

gRPC handler 只负责协议适配，无业务逻辑：

```go
// grpc/classlist.go
func (c *ClasslistServiceServer) GetClass(ctx context.Context, req *classlistv1.GetClassRequest) (*classlistv1.GetClassResponse, error) {
    classInfos, lastTime, err := c.svc.GetClass(ctx, req.GetStuId(), req.GetYear(), req.GetSemester(), req.GetRefresh())
    if err != nil {
        return &classlistv1.GetClassResponse{}, err
    }
    // BO → pb 类型转换（grpc/mapper.go）
}
```

这一层不应做缓存、爬虫或重试决策。其稳定职责是将 protobuf 字段转换为 service 入参，并在成功后把业务对象映射回响应对象。保持 handler 薄，可以避免同一业务规则在 HTTP/gRPC 等多个接入层分叉，也让业务逻辑能够脱离网络框架测试。

## Service 层

填充默认值，校验参数，然后透传给 biz 层：

```go
// service/classlist.go
func (s *ClassListService) GetClass(ctx context.Context, stuID, year, semester string, refresh bool) ([]*model.ClassInfoBO, *time.Time, error) {
    // year/semester 为空时使用当前学年学期（默认值填充）
    // ...

    // 调用 pkg/tool.CheckSY 校验
    // ...

    return s.clu.GetClasses(ctx, stuID, year, semester, refresh)
}
```

默认值填充发生在生成缓存键、刷新日志和 singleflight key 之前。这样省略学年学期的请求与显式传入当前学期的请求会落到同一份数据和同一条并发协作链路，避免为同一学生同一学期创建两次刷新任务。

## Biz 层 — 刷新决策

`GetClasses` 是核心主函数，首先加载本地数据，再通过 `decideRefreshAction` 决定走哪条分支。

### 三种 Action

```go
const (
    ActionReturnLocal RefreshAction = iota  // 直接返回本地
    ActionWaitPending                        // 等待进行中的刷新
    ActionStartCrawl                         // 发起爬虫
)
```

决策流程：

```
refresh=false 且 localErr=nil
    → ActionReturnLocal

有进行中的刷新日志 且 距上次刷新 < refreshInterval
    → ActionWaitPending

其余情况（首次、超过刷新间隔、本地加载失败）
    → ActionStartCrawl
```

可以将决策理解为下表：

| 条件 | 动作 | 对调用方的含义 |
|---|---|---|
| 未要求刷新，且本地读取成功 | `ActionReturnLocal` | 立即返回，完全不访问教务系统 |
| 存在时间窗口内的 `Pending` 刷新 | `ActionWaitPending` | 复用正在进行的工作，短暂等待结果 |
| 首次读取、数据缺失、显式刷新，或刷新窗口已过 | `ActionStartCrawl` | 尝试发起或加入一次爬虫 |

显式 `refresh=true` 表示调用者愿意尝试更新，但仍受并发控制和降级逻辑保护。它不会绕过 singleflight，也不会在教务系统不可用时无限同步重试。

> [!note] 首次爬虫超时更长
> `localLastRefreshTime == nil` 表示从未刷新过，此时 `waitCrawTime` 会被强制提升到至少 15 秒，给爬虫更多时间完成。

首次查询没有旧数据可兜底，适度延长等待时间可以提高直接拿到课表的概率；已有旧数据时则应缩短同步等待，避免把刷新延迟放大为用户界面卡顿。这是“首屏完整性”与“稳定响应时间”之间的明确取舍。

### 主函数代码

```go
// biz/usecase/classer.go
func (cluc *ClassUsecase) GetClasses(ctx context.Context, stuID, year, semester string, refresh bool) ([]*model.ClassInfoBO, *time.Time, error) {
    logh := cluc.log.WithContext(ctx).With(/* 结构化字段 */)
    currentTime := time.Now()

    waitCrawTime := time.Duration(cluc.conf.ClassListConf.WaitCrawTime) * time.Millisecond
    refreshInterval := time.Duration(cluc.conf.ClassListConf.RefreshInterval) * time.Millisecond

    // 1. 先尝试从本地（Cache + DB）加载
    localClasses, localLastRefreshTime, localErr := cluc.loadLocal(ctx, stuID, year, semester)
    if localErr != nil {
        logh.Errorf("load local failed: %+v", localErr)
    }
    if localLastRefreshTime == nil {
        waitCrawTime = max(waitCrawTime, 15*time.Second)
    }

    // 2. 决定数据来源
    action, refreshLog, waitBudget := cluc.decideRefreshAction(
        ctx, stuID, year, semester, refresh, localErr, refreshInterval, waitCrawTime,
    )

    if action == model.ActionReturnLocal {
        return localClasses, localLastRefreshTime, nil
    }

    if action == model.ActionWaitPending && refreshLog != nil {
        readyLog, waited := cluc.waitPending(ctx, refreshLog.ID, waitBudget)

        if readyLog != nil && readyLog.IsReady() {
            // 刷新完成，从本地重新取数据
            newLocal, err := cluc.classRepo.GetClassesFromLocal(ctx, stuID, year, semester)
            if err != nil {
                logh.Errorf("fetch class from local failed: %+v", err)
                return localClasses, localLastRefreshTime, nil
            }
            return newLocal, &readyLog.UpdatedAt, nil
        }

        // 等待超过 1 秒仍未就绪 → 直接返回旧数据
        if waited >= 1*time.Second {
            logh.Warnf("pending wait timeout, waited=%v, fallback to local", waited)
            return localClasses, localLastRefreshTime, nil
        }
        // 等待不足 1 秒 → 继续发起新爬虫
    }

    // 3. 发起爬虫（singleflight 防重复）
    requestKey := fmt.Sprintf("craw:%s:%s:%s", stuID, year, semester)
    res, err := cluc.doCrawlWithSingleflight(ctx, requestKey, stuID, year, semester, localClasses, currentTime)
    if err == nil && res != nil {
        return res, &currentTime, nil
    }
    if err != nil {
        logh.Errorf("crawl failed: %+v", err)
    }

    // 爬虫失败时降级：返回旧的本地数据
    return localClasses, localLastRefreshTime, nil
}
```

这里最值得注意的是错误收敛：爬虫或刷新失败被记录到日志，但不必然转化为 RPC 错误。只要存在旧数据，接口倾向于返回旧结果，以保护读可用性。调用方若要显示“数据可能过期”的提示，应依赖最后刷新时间或单独的状态字段，而不是把空错误当作绝对新鲜的证明。

## 爬虫分支

### singleflight 去重

`doCrawlWithSingleflight` 用 `singleflight.Group` 合并同一时间对同一学生同一学期的并发爬虫请求，key 为 `craw:{stuID}:{year}:{semester}`。

它解决的是**进程内**的请求风暴：十个同时到达的相同请求只执行一次 `crawMergedClass`，其余请求等待并共享结果。key 必须包含学生和学期；若只按学生去重，会把不同学期的数据错误合并。该机制不替代跨实例协调：当服务以多个副本运行时，每个实例各有自己的 `singleflight.Group`，仍需依赖刷新日志、缓存或分布式锁策略来控制全局并发。

```go
// biz/usecase/classer_helpers.go
func (cluc *ClassUsecase) doCrawlWithSingleflight(...) ([]*model.ClassInfoBO, error) {
    v, err, _ := cluc.sfGroup.Do(key, func() (interface{}, error) {
        return cluc.crawMergedClass(ctx, stuID, year, semester, logTime, local, true)
    })
    // 类型转换后返回
}
```

### crawMergedClass：爬虫 + 持久化 + 合并

爬取过程分五步：

```

刷新日志把长时间外部操作显式建模为状态机：写入 `Pending` 后，其他请求知道有工作正在进行；所有成功持久化和合并完成后才标为 `Ready`；任一步骤出错则标为 `Failed` 并进入延迟重试。状态更新应尽量靠近真实结果发生的位置，避免日志显示成功而数据尚未落库，或数据落库后一直显示处理中。
1. InsertRefreshLog(Pending)   ← 记录刷新任务开始
2. getCourseFromCrawler        ← 执行实际爬虫
   └── 失败 → UpdateLog(Failed) + sendRetryMsg (Kafka)
3. 标记官方课程 + 携带旧备注
4. SaveClass (事务)
   └── 失败 → UpdateLog(Failed) + sendRetryMsg (Kafka)
5. 过滤冲突的自定义课程 + 合并
   → UpdateLog(Ready) + SaveJxb
```

```go
// biz/usecase/classer_helpers.go
func (cluc *ClassUsecase) crawMergedClass(...) ([]*model.ClassInfoBO, error) {
    // 保留旧 MetaData（备注信息）
    metaMap := make(map[string]model.ClassMetaDataBO, len(localClassInfo))
    for _, lc := range localClassInfo {
        metaMap[lc.ID] = lc.MetaData
    }

    logID, err := cluc.refreshLogRepo.InsertRefreshLog(ctx, stuID, year, semester, model.Pending, logTime)
    if err != nil {
        return nil, err
    }

    crawClassInfos, crawScs, _, err := cluc.getCourseFromCrawler(ctx, stuID, year, semester)
    if err != nil {
        _ = cluc.refreshLogRepo.UpdateRefreshLogStatus(ctx, logID, model.Failed)
        _ = cluc.sendRetryMsg(ctx, stuID, year, semester)  // 触发 Kafka 延迟重试
        return nil, err
    }

    // 标记官方课程，保留旧备注
    for _, ci := range crawClassInfos {
        if ci == nil { continue }
        ci.MetaData.IsOfficial = true
        if meta, ok := metaMap[ci.ID]; ok {
            ci.MetaData.Note = meta.Note
        }
    }

    err = cluc.classRepo.SaveClass(ctx, stuID, year, semester, crawClassInfos, crawScs)
    if err != nil {
        _ = cluc.refreshLogRepo.UpdateRefreshLogStatus(ctx, logID, model.Failed)
        _ = cluc.sendRetryMsg(ctx, stuID, year, semester)
        return nil, err
    }

    // 过滤与官方课程冲突的自定义课程（时间重叠）
    addedInfos, _ := cluc.classRepo.GetAddedClasses(ctx, stuID, year, semester)
    addedInfos, conflictIDs := cluc.filterAddedClassesConflictingWithOfficial(ctx, crawClassInfos, addedInfos)
    if len(conflictIDs) > 0 {
        if err := cluc.classRepo.DeleteAddedClasses(ctx, stuID, year, semester, conflictIDs); err != nil {
            _ = cluc.refreshLogRepo.UpdateRefreshLogStatus(ctx, logID, model.Failed)
            _ = cluc.sendRetryMsg(ctx, stuID, year, semester)
            return nil, err
        }
    }

    _ = cluc.refreshLogRepo.UpdateRefreshLogStatus(ctx, logID, model.Ready)
    _ = cluc.jxbRepo.SaveJxb(ctx, stuID, jxbIDs)

    return append(crawClassInfos, addedInfos...), nil
}
```

合并的顺序体现了两类数据的所有权：爬虫返回的是官方课程，刷新时可以替换；用户手动添加的课程和用户备注属于本服务，应尽可能保留。刷新前先用旧课程 ID 建立备注映射，再把备注回填到同 ID 的新官方课程，可避免一次正常刷新清空用户标注。对时间冲突的自定义课程进行过滤和删除，则是为了防止课程表在同一时段重复展示；这类删除属于有业务含义的写操作，应记录可追踪信息，便于用户申诉或排查误判。

> [!warning] 并发边界
> singleflight 只合并爬虫函数本身，不能自动保证所有后续数据库写入、缓存失效和刷新日志更新在跨进程场景中的串行性。扩容、重试或人工触发刷新时，应通过唯一约束、幂等写入和刷新日志查询来抵抗重复执行。

## Kafka 延迟重试机制

> [!tip] sarama 用法详解
> 关于 `ConsumerGroupHandler` 接口、函数适配器、消费主循环和启动逻辑的底层原理，见 [[Sarama ConsumerGroup 使用解析]]。

爬虫失败时不直接重试，而是写入 Kafka 延迟队列，等待一段时间后再重新发起爬虫。这样能避免在教务系统临时不可用时立即轮询，同时保证最终一致性。

延迟队列将“失败后何时再试”从同步请求中拆出：原请求可以立刻以旧数据降级结束，消费者则在后台按延迟时间重新触发完整流程。它提供的是面向恢复的**至少一次尝试**，而非精确一次处理；因此 `SaveClass`、刷新日志更新和消息处理都应可重复执行，或具备幂等保护。

### Topic 定义

```go
// events/topic/topic.go
const (
    DelayTopic = "be-classlist-delay"  // 暂存，等待延迟时间
    RealTopic  = "be-classlist-real"   // 真正触发重试的 topic
)
```

### 整体数据流

```
爬虫失败
    ↓
sendRetryMsg → DelayKafka.Send → Kafka delay topic
                                        ↓
                        DelaySendHandler 消费 delay topic
                        （消息年龄 >= delayTime 时转发）
                                        ↓
                                Kafka real topic
                                        ↓
                        handleRetryMessage 消费 real topic
                                        ↓
                        ClassUsecase.GetClasses(refresh=true)
```

### DelayKafka 初始化

`NewDelayKafka` 在构造时就启动了 delay topic 的消费 goroutine：

```go
// events/delay/delay.go
func NewDelayKafka(client sarama.Client, cf DelayKafkaConfig, ...) (biz.DelayQueue, func(), error) {
    // ... 初始化 producer、consumer、delaySendHandler

    go func() {
        if err := dk.consumeDelay(); err != nil {
            dk.log.Errorf("Error consuming delay topic: %v", err)
        }
    }()

    return dk, dk.Close, nil
}
```

### Delay Topic 消费逻辑（时间门控）

`DelaySendHandler` 收到消息后，检查消息年龄（`time.Since(message.Timestamp)`）：

```go
func (c *DelaySendHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for message := range claim.Messages() {
        dur := time.Since(message.Timestamp)

        if dur >= c.delayTime {
            // 异常情况：消息年龄 >= 20×delayTime，可能是积压过久，直接丢弃
            if c.delayTime > 0 && dur >= 20*c.delayTime {
                session.MarkMessage(message, "")
                continue
            }
            // 正常延迟到期：转发到 real topic
            if err := c.forwardMessage(ctx, message); err != nil {
                // 失败也提交 offset，避免无限重投
                // 真正的告警应走独立失败队列，不在消费循环里死磕
                session.MarkMessage(message, "")
                return nil
            }
            session.MarkMessage(message, "")
            continue
        }

        // 未到延迟时间：休眠 1 秒降低消费频率，然后返回让框架重新分配
        time.Sleep(time.Second)
        return nil
    }
    return nil
}
```

> [!warning] 设计取舍
> 消费失败时直接 MarkMessage 跳过，而非阻塞重试。这是有意为之：失败应该由独立告警通道处理，消费循环不应死磕，否则会阻塞整个 partition 的消费。

这也意味着该队列不是“零丢失”的死信系统：过期过久的消息和转发失败的消息会被确认并跳过。生产环境应至少为这两条分支配置结构化日志、指标和告警，并在必要时把原始消息复制到可人工回放的失败主题；否则故障可能只表现为某个学生的课表长期未刷新。

### Real Topic 消费（实际重试）

`ClassUsecase` 在初始化时启动 real topic 的消费：

```go
// biz/usecase/classer.go
func NewClassUsecase(...) *ClassUsecase {
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

`handleRetryMessage` 解包消息，直接调用 `GetClasses(refresh=true)`，走完整的爬虫路径：

```go
func (cluc *ClassUsecase) handleRetryMessage(ctx context.Context, _ []byte, value []byte) {
    var retryInfo refreshRetryMessage
    if err := json.Unmarshal(value, &retryInfo); err != nil {
        logh.Errorf("unmarshal refresh retry msg failed: value=%s, err=%+v", string(value), err)
        return
    }
    _, _, err := cluc.GetClasses(ctx, retryInfo.StuID, retryInfo.Year, retryInfo.Semester, true)
    if err != nil {
        logh.Errorf("handle refresh retry msg failed: %+v", err)
    }
}
```

### DelayKafka.Consume 底层实现

`Consume` 把业务函数 `f` 包装成 `sarama.ConsumerGroupHandler`，然后创建消费者组循环消费 real topic：

```go
// events/delay/delay.go
func (d *DelayKafka) Consume(groupID string, f func(ctx context.Context, key, value []byte)) error {
    if groupID == d.proxyGroupID {
        return consumer.ErrInvalidGroupID  // 防止业务消费者误用 delay 的 group ID
    }
    handler := consumer.NewFuncConsumeHandler(f, d.log, d.m)
    return d.c.Consume([]string{d.realTopic}, groupID, handler)
}

// events/consumer/consumer.go
func (c *Consumer) Consume(topics []string, groupID string, handler sarama.ConsumerGroupHandler) error {
    cg, err := sarama.NewConsumerGroupFromClient(groupID, c.client)
    if err != nil {
        return err
    }
    defer cg.Close()

    for {
        if err := cg.Consume(c.cctx, topics, handler); err != nil {
            return err
        }
        if c.cctx.Err() != nil {
            return c.cctx.Err()
        }
    }
}
```

`for` 循环保证消费者在 rebalance 后自动重新加入，直到 context 取消为止。

## 排障与验证清单

| 现象 | 优先检查 | 预期判断 |
|---|---|---|
| 总是返回旧课表 | `refresh` 入参、最后刷新时间、`ActionReturnLocal` 条件 | 未显式刷新且本地可用时，这是正常读路径 |
| 请求等待后仍是旧数据 | `Pending` 刷新日志、等待预算、爬虫日志 | 超出等待预算会主动降级，不等于接口异常 |
| 同一学生出现大量并发爬虫 | `craw:{stuID}:{year}:{semester}` key、服务实例数、刷新日志 | 单实例应被 singleflight 合并；跨实例需检查其他协调措施 |
| Kafka 有消息但未重试 | delay/real topic、消费者组、消息时间戳和 `delayTime` | delay topic 到期后才会转发至 real topic |
| 课表刷新后备注或自定义课异常 | `MetaData` 回填、冲突过滤、事务与缓存失效日志 | 官方课可更新，用户数据应被有意保留或有据删除 |

建议至少覆盖四类集成测试：冷启动首次查询、缓存命中查询、多个并发刷新请求，以及爬虫失败后由 Kafka 触发的恢复路径。测试断言除了课程内容，还应覆盖刷新日志状态、是否重复爬虫、缓存失效以及失败时旧数据能否返回。
