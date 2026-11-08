---
category: ccnubox
type: deep-dive
topic: otel
module: bff
status: seedling
title: BFF OTel 使用
aliases:
  - OpenTelemetry 使用指南
  - BFF OTel使用
tags:
  - ccnubox
  - ccnubox/bff
  - ccnubox/bff/otel
---
# OTel 接入实现

本文档说明 `ccnubox-be` 中 OpenTelemetry 的初始化方式、BFF 接入点、后端服务传播路径，以及日志与链路的关联实现。

相关补充见：

- [[BFF OTel实践与排障]] — 实践约定、排障路径与常见问题

## 目标

本文主要回答三个问题：

1. OTel 在项目里如何初始化。
2. 一次请求的 `trace_id` 如何在 BFF、后端服务、Kafka 与日志之间传播。
3. 业务代码在哪里接入链路追踪能力。

## 适用范围

- BFF HTTP 请求链路
- 服务间 gRPC 调用链路
- Kafka 消息生产与消费链路
- 基于 `logger.WithContext(ctx)` 的日志关联

## 总体架构

项目按三层封装 OTel：

```text
common/pkg/otelx/otel.go
  -> 底层 SDK 封装，负责 TracerProvider / Exporter / Propagator

common/bizpkg/otel/otel.go
  -> 业务层封装，负责 Resource 和 service name 注入

各服务 ioc/otel.go
  -> 服务入口初始化，注册 shutdown
```

### 核心组件

| 组件 | 位置 | 职责 |
|------|------|------|
| `otelx.SetupOTel` | `common/pkg/otelx/otel.go` | 创建 `TracerProvider`，设置上下文传播器 |
| `otel.InitOTel` | `common/bizpkg/otel/otel.go` | 构造带 `service.name` 的 `Resource` |
| `otel.InitOTelFromInfra` | `common/bizpkg/otel/otel.go` | 从基础设施配置派生服务名与 OTel 地址 |
| `otelgin.Middleware` | `bff/web/middleware/otel.go` | 为每个 HTTP 请求创建入口 span |
| `AttributeMiddleware` | `bff/web/middleware/otel.go` | 为入口 span 追加 `trace_id` 响应头与学号属性 |
| `TraceLogger` | `common/pkg/logger/trace.go` | 将 `trace_id` / `span_id` 注入日志，并回写 span 状态 |

## 初始化流程

### 底层 SDK 封装

`common/pkg/otelx/otel.go` 负责组装 OTel SDK：

```go
func SetupOTel(ctx context.Context, opts ...Option) (func(context.Context) error, error) {
    defaultResource := resource.Default()
    cfg := config{
        sampler:  trace.AlwaysSample(),
        resource: defaultResource,
    }

    for _, opt := range opts {
        opt(&cfg)
    }

    var shutdownFuncs []func(context.Context) error
    shutdown := func(ctx context.Context) error {
        var err error
        for _, fn := range shutdownFuncs {
            err = errors.Join(err, fn(ctx))
        }
        shutdownFuncs = nil
        return err
    }
    
    handleErr := func(inErr error) {
		err = errors.Join(inErr, shutdown(ctx))
	}

    prop := newPropagator()
    otel.SetTextMapPropagator(prop)

    tracerProvider, err := newTracerProvider(ctx, cfg)
    if err != nil {
        handleErr(err)
        return shutdown, err
    }
    shutdownFuncs = append(shutdownFuncs, tracerProvider.Shutdown)
    otel.SetTracerProvider(tracerProvider)

    return shutdown, nil
}
```

> [!tip] 
> 这里选择了Go语言经典的**函数选项式模式**处理配置。具有以下优点：
>  1. 默认值友好：有可运行的默认配置。
>  2. 极强的拓展性：能方便地传入`Option`。

这段代码维护了`shutdownFuncs`切片和`shutdown`函数。做到了两件事：
1. 保证发生错误，资源能够释放。
2. 保留拓展性，能聚合多个`Provider`的关机函数。

`errors.Join(...)`**不会中断函数运行**，而是会积累“错误树”。即使有组件的关机逻辑报错，后续组件也能执行关机逻辑。

`shutdownFuncs = nil`这段代码，清空切片，保证了**幂等性**。

`handleErr`负责聚合错误。

关键配置：

- `Sampler`: `trace.AlwaysSample()`
- `Propagator`: `TraceContext` + `Baggage`
- `Exporter`: OTLP HTTP，默认超时 5 秒

```go
func newPropagator() propagation.TextMapPropagator {
    return propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    )
}

func newTracerProvider(ctx context.Context, cfg config) (*trace.TracerProvider, error) {
    traceExporter, err := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(cfg.endpoint),
        otlptracehttp.WithInsecure(),
        otlptracehttp.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, err
    }

    return trace.NewTracerProvider(
        trace.WithSampler(cfg.sampler),
        trace.WithResource(cfg.resource),
        trace.WithBatcher(traceExporter),
    ), nil
}
```

### 业务层封装

`common/bizpkg/otel/otel.go` 在 SDK 封装基础上补充业务语义，主要负责注入服务名：

```go
func InitOTel(cfg *conf.OtelConf) func(ctx context.Context) error {
    res, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(cfg.ServiceName),
        ),
    )
    if err != nil {
        panic(fmt.Sprintf("otel 创建 resource 失败：%v", err))
    }

    shutdown, err := otelx.SetupOTel(
        context.Background(),
        otelx.WithResource(res),
        otelx.WithEndpoint(cfg.Endpoint),
    )
    if err != nil {
        panic(fmt.Sprintf("otel 初始化失败: %v", err))
    }

    return shutdown
}

func InitOTelFromInfra(infraCfg *conf.InfraConf, serviceKey string) func(ctx context.Context) error {
    cfg := &conf.OtelConf{
        ServiceName: bgrpc.GetNamePrefix(infraCfg.Env, (*infraCfg.Grpc)[serviceKey].Name),
        Endpoint:    infraCfg.Otel.Endpoint,
    }
    return InitOTel(cfg)
}
```

### 服务入口初始化

每个服务通过自身的 `ioc/otel.go` 调用业务层封装，并将返回的 `shutdown` 注册到生命周期中。

BFF 示例：

```go
func InitOTel(serverCfg *conf.ServerConf, infraCfg *conf.InfraConf) func(ctx context.Context) error {
    serviceName := serverCfg.ServiceName
    if serviceName == "" {
        serviceName = "bff"
    }

    cfg := &baseconf.OtelConf{
        ServiceName: bgrpc.GetNamePrefix(infraCfg.Env, serviceName),
        Endpoint:    infraCfg.Otel.Endpoint,
    }
    return otel.InitOTel(cfg)
}
```

后端服务示例：

```go
func InitOTel(infraCfg *conf.InfraConf) func(ctx context.Context) error {
    return otel.InitOTelFromInfra(infraCfg.InfraConf, bgrpc.GRADE)
}
```

## BFF 接入方式

### HTTP 中间件

BFF 通过两个中间件接入 OTel，分别负责入口 span 创建与属性补充。

#### 前置中间件：`otelgin`

`bff/web/middleware/otel.go`：

```go
type OtelMiddleware struct{}

func NewOtelMiddlerware() *OtelMiddleware {
    return &OtelMiddleware{}
}

func (m *OtelMiddleware) Middleware() gin.HandlerFunc {
    return otelgin.Middleware("bff")
}
```

作用：

- 每个 HTTP 请求自动创建 span
- 从请求头提取 trace context
- 记录 HTTP 标准属性

#### 后置中间件：`AttributeMiddleware`

`bff/web/middleware/otel.go`：

```go
func (m *OtelMiddleware) AttributeMiddleware() gin.HandlerFunc {
    return func(ctx *gin.Context) {
        ctx.Next()

        span := trace.SpanFromContext(ctx)
        sc := span.SpanContext()
        if !sc.IsValid() {
            return
        }

        ctx.Header("X-Trace-Id", sc.TraceID().String())

        _, exists := ctx.Get(ginx.UC_CTX)
        if !exists {
            return
        }

        uc, err := ginx.GetClaims[ijwt.UserClaims](ctx)
        if err != nil {
            ctx.Error(errs.UNAUTHORIED_ERROR(errors.New("链路获取学号失败")))
            return
        }

        span.SetAttributes(attribute.String("student_id", uc.StudentId))
    }
}
```

作用：

- 将 `X-Trace-Id` 写入响应头
- 从 JWT claims 中读取学号并写入 span
- 支持按学号检索链路

#### 中间件顺序

`bff/ioc/web.go`：

```go
api.Use(
    corsMiddleware.MiddlewareFunc(),
    prometheusMiddleware.MiddlewareFunc(),
    otelMiddleware.Middleware(),
    loggerMiddleware.MiddlewareFunc(),
    otelMiddleware.AttributeMiddleware(),
)
```

请求处理顺序：

1. `otelgin.Middleware` 创建入口 span。
2. 业务逻辑执行，并通过 `ctx` 向下游传播 trace context。
3. `AttributeMiddleware` 回填 `X-Trace-Id` 与 `student_id`。
4. 日志输出时由 `TraceLogger` 自动补齐 `trace_id` / `span_id`。

### 登录接口特殊处理

登录接口在 JWT 生成前就需要记录学号，因此要在 handler 中手动写入 span：

```go
func (h *UserHandler) LoginByCCNU(ctx *gin.Context, req LoginByCCNUReq) (web.Response, error) {
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(attribute.String("student_id", req.StudentId))

    resp, err := h.userClient.CheckUser(ctx, &userv1.CheckUserReq{
        StudentId: req.StudentId,
        Password:  req.Password,
    })
    // ...
}
```

## 日志与链路关联

`common/pkg/logger/trace.go` 提供日志与链路的自动关联：

```go
type TraceLogger struct {
    logger Logger
    ctx    context.Context
    level  Level
}

func (f *TraceLogger) WithContext(ctx context.Context) Logger {
    return &TraceLogger{
        logger: f.logger.WithContext(ctx),
        ctx:    ctx,
        level:  f.level,
    }
}

func (f *TraceLogger) Info(msg string, args ...Field) {
    f.reportTraceInfo(INFO, msg)
    f.logger.Info(msg, f.addTraceInfo(args)...)
}

func (f *TraceLogger) reportTraceInfo(level Level, msg string) {
    span := trace.SpanFromContext(f.ctx)

    if span.SpanContext().IsValid() && level >= f.level {
        span.RecordError(errors.New(msg))
        if level >= ERROR {
            span.SetStatus(codes.Error, msg)
        } else {
            span.SetStatus(codes.Ok, msg)
        }
    }
}

func (f *TraceLogger) addTraceInfo(fields []Field) []Field {
    span := trace.SpanFromContext(f.ctx)
    if span.SpanContext().IsValid() {
        fields = append(fields,
            String("trace_id", span.SpanContext().TraceID().String()),
            String("span_id", span.SpanContext().SpanID().String()),
        )
    }
    return fields
}
```

使用方式：

```go
l := logger.WithContext(ctx)
l.Info("user login success", logger.String("student_id", studentId))
l.Error("database error", logger.Error(err))
```

## 后端服务与异步链路

### Kafka 消息追踪

`be-classlist/internal/data/kafka.go` 和 `be-classlist_v2/events/` 手动创建 span 追踪消息生产消费。

Producer：

```go
func (p *producer) Produce(ctx context.Context, topic string, key, value []byte) error {
    tracer := otel.Tracer("delay-producer")
    ctx, span := tracer.Start(ctx, "delay_produce_message",
        trace.WithSpanKind(trace.SpanKindProducer),
    )
    defer span.End()

    carrier := otelsarama.NewProducerRecordCarrier(topic, key, value)
    otel.GetTextMapPropagator().Inject(ctx, carrier)

    // 发送消息...
}
```

Consumer：

```go
func (c *delaySendHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for message := range claim.Messages() {
        ctx := otel.GetTextMapPropagator().Extract(
            context.Background(),
            otelsarama.NewConsumerMessageCarrier(message),
        )

        tracer := otel.Tracer("delay-queue-consume")
        ctx, span := tracer.Start(ctx, "delay-queue-consume",
            trace.WithSpanKind(trace.SpanKindConsumer),
        )

        tlog := c.log.WithContext(ctx)
        if err := c.forwardMessage(ctx, message); err != nil {
            tlog.Errorf("Error forwarding message: %s", string(message.Value))
            span.End()
            return nil
        }

        session.MarkMessage(message, "")
        span.End()
    }
    return nil
}
```

### GORM 日志关联

`common/pkg/logger/adapter/gorm.go` 让 SQL 日志携带 trace 信息：

```go
type GormLogger struct {
    l             logger.Logger
    LogLevel      glog.LogLevel
    SlowThreshold time.Duration
}

func (g *GormLogger) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
    elapsed := time.Since(begin)
    sql, rows := fc()

    fields := []logger.Field{
        logger.String("sql", sql),
        logger.Int64("rows", rows),
        logger.String("duration", elapsed.String()),
    }

    l := g.l.WithContext(ctx)

    switch {
    case err != nil && g.LogLevel >= glog.Error && !errors.Is(err, gorm.ErrRecordNotFound):
        l.Error("mysql_error", append(fields, logger.Error(err))...)
    case elapsed > g.SlowThreshold && g.SlowThreshold != 0 && g.LogLevel >= glog.Warn:
        slowLogMsg := fmt.Sprintf("slow_sql >= %v", g.SlowThreshold)
        l.Warn(slowLogMsg, fields...)
    case g.LogLevel == glog.Info:
        l.Info("mysql_query", fields...)
    }
}
```

## 链路传播模型

一次典型请求的传播路径如下：

```text
Client
  -> BFF HTTP Entrance Span
  -> gRPC Client / Server Span
  -> Backend Business Span
  -> Kafka Producer Span
  -> Kafka Consumer Span
  -> Structured Logs with trace_id/span_id
```

## 实现结论

- OTel 初始化被分层封装在 `otelx`、`bizpkg/otel` 和各服务 `ioc` 中。
- BFF 通过中间件、登录接口补充逻辑和 `TraceLogger` 完成主链路接入。
- Kafka 与 GORM 分别覆盖异步消息链路和数据库日志链路。
- `X-Trace-Id` 是客户端侧与 Jaeger/日志系统之间的主要关联点。
