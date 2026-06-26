---
category: ccnubox
type: deep-dive
topic: middleware
frameworks:
  - go-kratos
module: common
status: seedling
tags:
  - ccnubox
  - ccnubox/common/middleware
  - microservice/go-kratos
  - microservice/go-kratos/middleware
---
## 中间件实质

Kratos 的中间件本质上是一个高阶函数，类型签名为 `func(handler middleware.Handler) middleware.Handler`。
可以在中间件中处理`请求前`和`请求后`的逻辑。

## 代码示例
```go
package mymiddleware

import (
	"context"
	"log"
	"time"

	"github.com/go-kratos/kratos/v2/middleware"
	"github.com/go-kratos/kratos/v2/transport"
)

// CustomLogger 是我们自定义的中间件
func CustomLogger() middleware.Middleware {
	return func(handler middleware.Handler) middleware.Handler {
		return func(ctx context.Context, req interface{}) (reply interface{}, err error) {
			startTime := time.Now()

			// 1. 请求前置逻辑 (Pre-processing)
			// 获取上下文中的传输信息（可以获取到 gRPC 的方法名等信息）
			var operation string
			if tr, ok := transport.FromServerContext(ctx); ok {
				operation = tr.Operation()
			}

			log.Printf("[CustomLogger] 请求开始 - Operation: %s", operation)

			// 2. 调用下一个中间件或最终的业务 Handler
			reply, err = handler(ctx, req)

			// 3. 请求后置逻辑 (Post-processing)
			duration := time.Since(startTime)
			if err != nil {
				log.Printf("[CustomLogger] 请求失败 - Operation: %s, 耗时: %v, 错误: %v", operation, duration, err)
			} else {
				log.Printf("[CustomLogger] 请求成功 - Operation: %s, 耗时: %v", operation, duration)
			}

			return reply, err
		}
	}
}
```

## `go-kratos`中注册中间件的方式

### gRPC server
通过`ServerOption`传入。
```go
// NewGRPCServer 创建 gRPC 服务器
func NewGRPCServer(c *conf.Server, greeter *service.GreeterService) *grpc.Server {
	var opts = []grpc.ServerOption{
		grpc.Middleware(
			recovery.Recovery(),         // 官方的 panic 恢复中间件
			mymiddleware.CustomLogger(), // 注入你自定义的中间件
		),
	}
	
	if c.Grpc.Network != "" {
		opts = append(opts, grpc.Network(c.Grpc.Network))
	}
	if c.Grpc.Addr != "" {
		opts = append(opts, grpc.Address(c.Grpc.Addr))
	}
	if c.Grpc.Timeout != nil {
		opts = append(opts, grpc.Timeout(c.Grpc.Timeout.AsDuration()))
	}
	
	srv := grpc.NewServer(opts...)
	
	// 注册你的 gRPC 服务
	// helloworld.RegisterGreeterServer(srv, greeter)
	
	return srv
}
```

### gRPC client注册

只作用于`grpc.DialInsecure`和`grpc.Dial`等方法中。
```go
func NewGRPCClient() {
	conn, err := grpc.DialInsecure(
		context.Background(),
		grpc.WithEndpoint("127.0.0.1:9000"),
		grpc.WithMiddleware(
			mymiddleware.CustomLogger(), // 在客户端注入中间件
		),
	)
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	
	// client := helloworld.NewGreeterClient(conn)
	// client.SayHello(...)
}
```


## 华师匣子项目中注册方式

```go
func InitGRPCxKratosServer(
	grpcServer GrpcServer,
	ecli *clientv3.Client,
	l logger.Logger,
	cfg *conf.GrpcConf,
	env *conf.Env,
	middlewares ...middleware.Middleware,
) grpcx.Server {
	newCfg := *cfg
	// 添加前缀
	newCfg.Name = b_grpc.GetNamePrefix(env, newCfg.Name)
	hs := health.NewServer()
	s := kgrpc.NewServer(
		kgrpc.Address(cfg.Addr),
		kgrpc.CustomHealth(),
		kgrpc.Middleware(
			append([]middleware.Middleware{
				recovery.Recovery(),
				tracing.Server(),
				LoggingMiddleware(l),
				HealthMiddleware(hs),
			}, middlewares...)...,
		),
		kgrpc.Timeout(time.Duration(cfg.ServerTimeout)*time.Minute),
	)
	healthpb.RegisterHealthServer(s, hs)
	hs.SetServingStatus(newCfg.Name, healthpb.HealthCheckResponse_SERVING)

	grpcServer.Register(s)
	return &grpcx.KratosServer{
		Server:     s,
		Name:       newCfg.Name,
		Weight:     newCfg.Weight,
		EtcdTTL:    time.Second * time.Duration(newCfg.EtcdTTL),
		EtcdClient: ecli,
		L:          l,
	}
}
```

其中`middlewares`参数，提供了拓展中间件种类的**自由度**。