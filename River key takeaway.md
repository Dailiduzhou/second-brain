---
category: message-queue
type: summary
topic: riverqueue
status: done
tags:
  - message-queue/riverqueue
  - summary
---
**River** 是 Go 语言中一个非常强大且高性能的后台任务队列（Job Queue）。它的最大特点是**基于 PostgreSQL** 构建，并深度利用了 Postgres 的特性（如 `LISTEN/NOTIFY` 和行级锁），这使得它能够提供极高的吞吐量和可靠性，尤其是它原生支持**事务性入队（Transactional Enqueuing）**，完美解决了业务数据写入和任务下发的一致性问题（即原生实现了 Outbox 模式）。
下面我们来拆解 River 的核心概念，以及如何将它们配合起来使用。

### 一、 River 的核心概念
在 River 中，有四个最核心的概念支撑整个体系的运转：

- **JobArgs (任务参数):** 这是一个结构体（Struct），用于定义你要执行的任务的具体数据。它必须能够被序列化为 JSON。在 River 中，通过实现 `Kind()` 方法来唯一标识这个任务的类型。
- **Worker (工作器):** 负责处理特定 `JobArgs` 的逻辑组件。你需要为每种任务编写一个对应的 Worker，实现 `Work` 方法。
- **Workers Registry (工作器注册表):** 一个用于管理所有 Worker 的集合。客户端在启动时需要知道有哪些 Worker 可以用来处理从数据库中拉取到的任务。
- **Client (客户端):** 整个队列的“大脑”。它既负责将新任务插入数据库（入队），也负责从数据库拉取任务并分配给对应的 Worker 执行（消费）。

### 二、 如何配合使用（基础工作流）
使用 River 通常遵循以下流程：**定义参数 -> 编写逻辑 -> 注册配置 -> 入队与消费**。
以下是一个发送邮件任务的完整使用示例：

#### 1. 定义任务参数 (JobArgs)
首先，定义你需要传递给任务的数据。

```go
package main

import "github.com/riverqueue/river"

// SendEmailArgs 定义了发送邮件需要的数据
type SendEmailArgs struct {
    EmailAddress string `json:"email_address"`
    Content      string `json:"content"`
}

// Kind 方法返回任务的唯一标识符
func (SendEmailArgs) Kind() string {
    return "send_email"
}

```

#### 2. 定义处理逻辑 (Worker)
接着，创建一个 Worker 来处理上面的参数。通过嵌入 `river.WorkerDefaults` 可以省去实现一些可选方法（如超时设置、重试逻辑）的麻烦。

```go
import (
    "context"
    "fmt"
)

type SendEmailWorker struct {
    // 嵌入默认实现
    river.WorkerDefaults[SendEmailArgs]
}

// Work 是实际执行任务的地方
func (w *SendEmailWorker) Work(ctx context.Context, job *river.Job[SendEmailArgs]) error {
    fmt.Printf("正在向 %s 发送邮件, 内容: %s\n", job.Args.EmailAddress, job.Args.Content)
    
    // 如果返回 error，River 会自动根据退避算法进行重试
    return nil 
}

```

#### 3. 注册 Worker 并初始化 Client
在主函数中，配置数据库连接池（River 强依赖 `pgx`），将 Worker 注册进去，并启动 Client。

```go
import (
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func main() {
    ctx := context.Background()

    // 1. 初始化 PostgreSQL 连接池
    dbPool, _ := pgxpool.New(ctx, "postgres://user:pass@localhost:5432/mydb")
    defer dbPool.Close()

    // 2. 注册 Worker
    workers := river.NewWorkers()
    river.AddWorker(workers, &SendEmailWorker{})

    // 3. 创建并配置 River Client
    client, _ := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
        Queues: map[string]river.QueueConfig{
            // 配置名为 "default" 的队列，最大并发数为 100
            river.QueueDefault: {MaxWorkers: 100},
        },
        Workers: workers,
    })

    // 4. 启动客户端，开始监听并处理任务
    client.Start(ctx)
    defer client.Stop(ctx) // 优雅停机
}

```

#### 4. 插入任务 (Enqueue)
你可以在任何地方使用 Client 插入任务。River 最强大的地方在于你可以将其与业务 SQL 事务绑定：

```go
// 普通插入（不在事务中）
_, err := client.Insert(ctx, SendEmailArgs{
    EmailAddress: "user@example.com",
    Content:      "欢迎注册！",
}, nil)

// --- 强力推荐：事务性插入 ---
// 开启一个 pgx 事务
tx, _ := dbPool.Begin(ctx)
defer tx.Rollback(ctx)

// 1. 执行你的业务逻辑（例如在 users 表中插入新用户）
_, _ = tx.Exec(ctx, "INSERT INTO users (email) VALUES ($1)", "user@example.com")

// 2. 在同一个事务中插入 River 任务
_, _ = client.InsertTx(ctx, tx, SendEmailArgs{
    EmailAddress: "user@example.com",
    Content:      "欢迎注册！",
}, nil)

// 3. 提交事务
// 如果提交失败，业务数据和队列任务会同时回滚，保证了绝对的数据一致性！
_ = tx.Commit(ctx)

```

### 三、 进阶特性建议
在实际生产环境中使用 River 时，建议关注以下几个高级特性：

- **定时任务 / 延迟任务:** 可以在 `Insert` 时通过参数指定任务的执行时间（例如 `river.InsertOpts{ScheduledAt: time.Now().Add(time.Hour)}`）。
- **唯一性任务 (Unique Jobs):** 可以防止重复排队相同特征的任务，常用于去重（比如 24 小时内只给某个用户发送一次特定通知）。
- **UI 监控:** River 官方提供了一个非常美观的 Web UI（River UI），可以通过读取 Postgres 数据库直观地查看任务的排队、成功、失败和重试状态。
- **优雅停机 (Graceful Shutdown):** 务必在你的服务退出信号（SIGINT/SIGTERM）中调用 `client.Stop(ctx)`，River 会等待正在执行的任务完成后再关闭，防止任务意外中断。
