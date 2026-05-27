---
category: microsvc
frameworks: go-kratos
topic: mq
type: Riverqueue
status: seedling
---
## River生命周期管理

### 1. 统一的生命周期管理 (Unified Lifecycle Management)
Kratos 框架的核心是 `kratos.App`，它负责管理微服务内所有组件的启动和退出。
`kratos.App` 并不知道 River 是什么，它只认识 `kratos/transport.Server` 接口（即拥有 `Start` 和 `Stop` 方法的对象）。
当你把 River 包装成实现了该接口的 `RiverServer` 后，你就可以把它和其他普通的 HTTP Server、gRPC Server 一起注册到 Kratos 的生命周期中：

```go
// 注册到 Kratos App 中
app := kratos.New(
    kratos.Name("my-service"),
    kratos.Server(
        httpServer,   // 处理 HTTP 请求
        grpcServer,   // 处理 gRPC 请求
        riverServer,  // 处理后台异步任务 (River) 👈
    ),
)

```
这样，当你调用 `app.Run()` 时，Kratos 会自动帮你并发启动这三个组件；任何一个组件启动失败，Kratos 都能捕获错误并安全退出。你不必再自己手动写 `goroutine` 去启动 River，也不用自己去处理繁琐的 channel 阻塞和错误抛出。

### 2. 保证优雅停机 (Graceful Shutdown)
这是实现该接口**最重要**的作用。
如果你的程序正在处理一个耗时 5 秒的 River 任务，此时服务器需要发布新版本，系统发送了 `SIGTERM` (kill) 信号。

- **如果没有交给 Kratos 管理：** 进程会被直接杀掉，正在执行的后台任务会瞬间中断，可能导致数据状态不一致（例如钱扣了但订单状态没改）。
- **实现了 Stop 接口：** Kratos 监听到退出信号后，会**并行**调用所有已注册 Server 的 `Stop(ctx)` 方法。此时触发 `s.client.Stop(ctx)`，River 会停止接收新任务，并等待当前正在执行的任务完成（或者直到 ctx 超时），从而实现**优雅停机**，保障数据安全。

### 3. 泛化 "Server" 的架构概念 (Architectural Abstraction)
在微服务的架构设计中，**"Server" 不仅仅指代监听端口的 HTTP/gRPC Web 服务**。
任何“持续运行、等待输入、处理逻辑”的组件，在广义上都可以被抽象为 Server（服务）。

- 监听端口，处理网络请求 -> **Web Server**
- 监听 Kafka，处理消息流 -> **MQ Consumer Server**
- 监听数据库队列，处理后台任务 -> **Job Worker Server (你的 RiverServer)**
通过实现 `transport.Server`，你在架构层面将异步任务处理器提升到了与其他网络服务同等的一等公民（First-class citizen）地位，这让代码结构更加高度解耦和工程化。

## 具体实现
[示例项目](https://github.com/Dailiduzhou/simple-seckill)

**!!!需要通过库或cmd来进行river migrate!!!**
### Args&Workers
在`biz`层，
```go
type MessagingArgs struct {
	ProductID int64 `json:"product_id"`
	Amount    int32 `json:"amount"` // DIY fields
}

// 唯一标识
func (MessagingArgs) Kind() string { return "order.messaging" }

type MessagingWorker struct {
	river.WorkerDefaults[MessagingArgs]
	log *log.Helper // or XXXUsecase
}

func NewMessagingWorker(logger log.Logger) *MessagingWorker {
	// initalization
	return &MessagingWorker{log: log.NewHelper(logger)}
}

// 自定义的worker逻辑，一般用于异步数据库操作
func (w *MessagingWorker) Work(ctx context.Context, job *river.Job[MessagingArgs]) error {
	args := job.Args

	w.log.WithContext(ctx).Infof("No. %d product stock has deducted by %d", args.ProductID, args.Amount)
	return nil
}
```
### Initalization&DI

在`data`层，
```go
package data

import (
	// ...
)

var ProviderSet = wire.NewSet(NewData, NewProductRepo, NewPgxPool, wire.Bind(new(biz.ProductRepo), new(*ProductRepo)))

type Data struct {
	pool        *pgxpool.Pool
	riverclient *river.Client[pgx.Tx]
	// ...
}

// 使用 pgx
func NewPgxPool(c *conf.Data) (*pgxpool.Pool, error) {
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, c.Database.Source)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	return pool, nil
}

func NewData(c *conf.Data, pool *pgxpool.Pool, riverClient *river.Client[pgx.Tx]) (*Data, func(), error) {
	ctx := context.Background()

	rdb := redis.NewClient(&redis.Options{
		Addr:     c.Redis.Addr,
		Password: "",
		DB:       0,
	})

	if err := rdb.Ping(ctx).Err(); err != nil {
		rdb.Close()
		return nil, nil, fmt.Errorf("ping redis: %w", err)
	}

	redisPool := goredis.NewPool(rdb)
	rs := redsync.New(redisPool)

	cleanup := func() {
		riverClient.Stop(ctx)
		rdb.Close()
		pool.Close()

		log.Info("closing the data resources")
	}
	return &Data{
		pool:        pool,
		riverclient: riverClient,
		rdb:         rdb,
		rs:          rs,
		q:           db.New(pool),
		sg:          &singleflight.Group{},
	}, cleanup, nil
}

```
在`server`层：
```go
package server

import (
	"context"
	"fmt"
	"time"

	"seckill/app/product/internal/biz"

	"github.com/google/wire"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

var ProviderSet = wire.NewSet(NewGRPCServer, NewHTTPServer, NewEtcdClient, NewDiscovery, NewRegistrar, NewRiverClient, NewRiverServer, NewRiverWorkers)

func NewRiverWorkers(messagingWorker *biz.MessagingWorker) *river.Workers {
	workers := river.NewWorkers()
	river.AddWorker(workers, messagingWorker)
	return workers
}

func NewRiverClient(pool *pgxpool.Pool, workers *river.Workers) (*river.Client[pgx.Tx], error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	driver := riverpgxv5.New(pool)
	migrator, err := rivermigrate.New(driver, nil) // 获取migrator
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("create river migrator: %w", err)
	}
	if _, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate river schema: %w", err)
	}

	riverClient, err := river.NewClient(driver, &river.Config{
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
		},
		Workers: workers,
	})
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("create river client: %w", err)
	}
	return riverClient, nil
}

type RiverServer struct {
	client *river.Client[pgx.Tx]
}

func NewRiverServer(riverClient *river.Client[pgx.Tx]) *RiverServer {
	return &RiverServer{client: riverClient}
}

func (s *RiverServer) Start(ctx context.Context) error {
	return s.client.Start(ctx)
}

func (s *RiverServer) Stop(ctx context.Context) error {
	return s.client.Stop(ctx)
}

```
### 注册Server

`cmd/XXX/main.go`
```go
func newApp(logger log.Logger, gs *grpc.Server, hs *http.Server, rr registry.Registrar, rs *server.RiverServer) *kratos.App {
	return kratos.New(
		kratos.ID(id),
		kratos.Name(Name),
		kratos.Version(Version),
		kratos.Metadata(map[string]string{}),
		kratos.Logger(logger),
		kratos.Server(
			gs,
			hs,
			rs,
		),
		kratos.Registrar(rr),
	)
}
```