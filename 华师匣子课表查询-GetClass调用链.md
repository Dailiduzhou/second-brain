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

> [!note] 首次爬虫超时更长
> `localLastRefreshTime == nil` 表示从未刷新过，此时 `waitCrawTime` 会被强制提升到至少 15 秒，给爬虫更多时间完成。

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

## 爬虫分支

### singleflight 去重

`doCrawlWithSingleflight` 用 `singleflight.Group` 合并同一时间对同一学生同一学期的并发爬虫请求，key 为 `craw:{stuID}:{year}:{semester}`。

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

## Kafka 延迟重试机制

> [!tip] sarama 用法详解
> 关于 `ConsumerGroupHandler` 接口、函数适配器、消费主循环和启动逻辑的底层原理，见 [[Sarama ConsumerGroup 使用解析]]。

爬虫失败时不直接重试，而是写入 Kafka 延迟队列，等待一段时间后再重新发起爬虫。这样能避免在教务系统临时不可用时立即轮询，同时保证最终一致性。

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
