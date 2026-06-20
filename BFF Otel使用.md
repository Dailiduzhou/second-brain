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
 # OpenTelemetry 使用指南

本文档说明 `ccnubox-be` 中 OpenTelemetry 的初始化方式、BFF 接入点、后端服务传播路径，以及日志与链路的关联策略。目标是回答三个问题：

1. OTel 在项目里是如何初始化的。
2. 一次请求的 `trace_id` 如何在 BFF、后端服务、Kafka 与日志之间传递。
3. 新增链路埋点时应遵循哪些约束。

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
// SetupOTel 初始化 OpenTelemetry
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

    // 设置上下文传播器（用于跨服务传递追踪信息）
    prop := newPropagator()
    otel.SetTextMapPropagator(prop)

    // 初始化 trace provider
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

关键配置如下：

- **Sampler**: `trace.AlwaysSample()` — 所有请求都被采样
- **Propagator**: `TraceContext` + `Baggage` — 支持跨服务传播
- **Exporter**: OTLP HTTP，默认超时 5 秒

```go
// newPropagator 设置传播器
func newPropagator() propagation.TextMapPropagator {
    return propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    )
}

// newTracerProvider 创建 TracerProvider
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

这一层只关心“如何创建全局 OTel 能力”，不关心业务服务名。

### 业务层封装

`common/bizpkg/otel/otel.go` 在 SDK 封装基础上补充业务语义，核心是注入服务名：

```go
// InitOTel 初始化 OTel
func InitOTel(cfg *conf.OtelConf) func(ctx context.Context) error {
    // 构造 Resource
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

    // 初始化 OTel
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

// InitOTelFromInfra 从基础设施配置初始化
func InitOTelFromInfra(infraCfg *conf.InfraConf, serviceKey string) func(ctx context.Context) error {
    cfg := &conf.OtelConf{
        ServiceName: bgrpc.GetNamePrefix(infraCfg.Env, (*infraCfg.Grpc)[serviceKey].Name),
        Endpoint:    infraCfg.Otel.Endpoint,
    }
    return InitOTel(cfg)
}
```

### 服务入口初始化

每个服务通过自身的 `ioc/otel.go` 调用业务层封装，并将返回的 `shutdown` 注册到服务生命周期中。

**BFF 示例** (`bff/ioc/otel.go`)：

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

**后端服务示例** (`be-grade/ioc/otel.go`)：

```go
func InitOTel(infraCfg *conf.InfraConf) func(ctx context.Context) error {
    return otel.InitOTelFromInfra(infraCfg.InfraConf, bgrpc.GRADE)
}
```

---

## BFF 接入方式

### HTTP 中间件

BFF 通过两个中间件接入 OTel，分别负责入口 span 创建与属性补充。

#### 前置中间件：otelgin

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
- 从请求头提取 trace context（支持跨服务传播）
- 记录 HTTP 方法、路径、状态码等标准属性

#### 后置中间件：AttributeMiddleware

`bff/web/middleware/otel.go`：

```go
// AttributeMiddleware 全局中间件，为链路的头 span 添加自定义 tag
func (m *OtelMiddleware) AttributeMiddleware() gin.HandlerFunc {
    return func(ctx *gin.Context) {
        ctx.Next()

        span := trace.SpanFromContext(ctx)
        sc := span.SpanContext()
        if !sc.IsValid() {
            return
        }
        
        // 添加 trace_id 到响应头
        ctx.Header("X-Trace-Id", sc.TraceID().String())

        // 判断 ctx 中有没有用户信息
        _, exists := ctx.Get(ginx.UC_CTX)
        if !exists {
            return
        }

        // 安全读取学号信息
        uc, err := ginx.GetClaims[ijwt.UserClaims](ctx)
        if err != nil {
            ctx.Error(errs.UNAUTHORIED_ERROR(errors.New("链路获取学号失败")))
            return
        }

        // 添加学号到链路
        span.SetAttributes(attribute.String("student_id", uc.StudentId))
    }
}
```

作用：
- 将 `X-Trace-Id` 写入响应头，便于客户端排障
- 从 JWT claims 中读取学号，写入 span attribute
- 支持按学号检索链路

#### 中间件顺序

`bff/ioc/web.go`：

```go
api.Use(
    // 1. 跨域中间件（前置）
    corsMiddleware.MiddlewareFunc(),
    
    // 2. Prometheus 打点（前后均处理）
    prometheusMiddleware.MiddlewareFunc(),
    
    // 3. OTel 链路追踪注入（前置）
    otelMiddleware.Middleware(),
    
    // 4. 日志中间件（后置）
    loggerMiddleware.MiddlewareFunc(),
    
    // 5. OTel 链路追踪补充信息（后置）
    otelMiddleware.AttributeMiddleware(),
)
```

请求处理顺序如下：

1. 请求进入，`otelgin.Middleware` 创建入口 span。
2. 业务逻辑执行，期间通过 `ctx` 向下游传播 trace context。
3. 响应返回前，`AttributeMiddleware` 回填 `X-Trace-Id` 与 `student_id`。
4. 日志输出阶段，`TraceLogger` 自动补齐 `trace_id` / `span_id`。

### 登录接口的特殊处理

登录接口在 JWT 生成前就需要记录学号，因此不能依赖 `AttributeMiddleware`，而是要在 handler 中手动写入 span：

`bff/web/user/user.go`：

```go
func (h *UserHandler) LoginByCCNU(ctx *gin.Context, req LoginByCCNUReq) (web.Response, error) {
    // 记录学号存入 span
    span := trace.SpanFromContext(ctx)
    span.SetAttributes(attribute.String("student_id", req.StudentId))

    // 验证账号密码...
    resp, err := h.userClient.CheckUser(ctx, &userv1.CheckUserReq{
        StudentId: req.StudentId,
        Password:  req.Password,
    })
    // ...
}
```

这样做的原因：
- `AttributeMiddleware` 依赖 JWT claims，但登录时还没有 JWT
- 登录接口是用户反馈问题的主要来源，需要记录学号便于定位

### 日志与链路关联

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

// reportTraceInfo 向 span 上报日志信息
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

// addTraceInfo 自动注入 trace_id 和 span_id
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
// 在 handler 中注入 context
l := logger.WithContext(ctx)

// 日志自动携带 trace_id
l.Info("user login success", logger.String("student_id", studentId))
// 输出：{"msg": "user login success", "student_id": "2024210000", "trace_id": "abc123...", "span_id": "def456..."}

// 错误日志同时上报到 span
l.Error("database error", logger.Error(err))
// span 状态设置为 Error，并记录错误信息
```

效果：
- 每条日志自动注入 `trace_id` 和 `span_id`
- 错误日志自动上报到 span，支持在 Jaeger 中查看
- 实现"学号 → trace_id → 日志"的完整关联

## 后端服务与异步链路

### Kafka 消息追踪

`be-classlist/internal/data/kafka.go` 和 `be-classlist_v2/events/` 手动创建 span 追踪消息生产消费：

#### Producer

```go
func (p *producer) Produce(ctx context.Context, topic string, key, value []byte) error {
    tracer := otel.Tracer("delay-producer")
    ctx, span := tracer.Start(ctx, "delay_produce_message",
        trace.WithSpanKind(trace.SpanKindProducer),
    )
    defer span.End()

    // 将 trace context 注入 Kafka header
    carrier := otelsarama.NewProducerRecordCarrier(topic, key, value)
    otel.GetTextMapPropagator().Inject(ctx, carrier)

    // 发送消息...
}
```

#### Consumer

```go
func (c *delaySendHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for message := range claim.Messages() {
        // 从 Kafka header 提取 trace context
        ctx := otel.GetTextMapPropagator().Extract(context.Background(), 
            otelsarama.NewConsumerMessageCarrier(message))

        tracer := otel.Tracer("delay-queue-consume")
        ctx, span := tracer.Start(ctx, "delay-queue-consume",
            trace.WithSpanKind(trace.SpanKindConsumer),
        )

        tlog := c.log.WithContext(ctx)
        
        // 处理消息...
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

效果：
- 消息生产者和消费者共享同一个 trace
- 在 Jaeger 中可以看到完整的消息流转链路
- 延迟队列的消息也能被追踪

### GORM 日志关联

`common/pkg/logger/adapter/gorm.go` 让 SQL 日志携带 trace 信息：

```go
type GormLogger struct {
    l              logger.Logger
    LogLevel       glog.LogLevel
    SlowThreshold  time.Duration
}

func (g *GormLogger) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
    elapsed := time.Since(begin)
    sql, rows := fc()

    fields := []logger.Field{
        logger.String("sql", sql),
        logger.Int64("rows", rows),
        logger.String("duration", elapsed.String()),
    }

    // 使用 WithContext 让日志携带 trace 信息
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

使用方式：

```go
// 初始化 GORM 时注入 logger
db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
    Logger: adapter.NewGormLogger(logger),
})

// 查询时自动携带 trace_id
db.WithContext(ctx).Where("student_id = ?", studentId).Find(&user)
// SQL 日志：{"msg": "mysql_query", "sql": "SELECT ...", "trace_id": "abc123..."}
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

排障时，客户端拿到 `X-Trace-Id` 后，可以沿这条路径在 Jaeger 和日志系统里反查完整链路。

## 实践约定

### 学号记录策略

项目采用**两层记录策略**：

| 场景 | 记录方式 | 位置 |
|------|----------|------|
| 已认证请求 | `AttributeMiddleware` 自动记录 | `bff/web/middleware/otel.go:54` |
| 登录接口 | 手动记录 | `bff/web/user/user.go:65` |

这样设计是因为：
- `AttributeMiddleware` 依赖 JWT，但登录时还没有 JWT
- 登录接口是用户反馈问题的主要来源，必须记录学号

### 日志必须绑定上下文

**必须使用 `WithContext(ctx)`：**

```go
// ✅ 正确
l := logger.WithContext(ctx)
l.Info("operation success")

// ❌ 错误：日志不会携带 trace_id
logger.Info("operation success")
```

### 错误要写回 span

**使用 `RecordError` 记录错误：**

```go
span := trace.SpanFromContext(ctx)
if err != nil {
    span.RecordError(err)
    span.SetStatus(codes.Error, err.Error())
    return err
}
```

**或者使用 `TraceLogger` 自动上报：**

```go
l := logger.WithContext(ctx)
l.Error("operation failed", logger.Error(err))
// 自动上报到 span
```

### 跨服务传播边界

**HTTP 调用（自动）：**

```go
// 使用 http.Client 时自动传播
resp, err := http.Get("http://backend-service/api")
```

**gRPC 调用（自动）：**

```go
// 使用 grpc.Client 时自动传播
resp, err := client.GetUser(ctx, &GetUserReq{Id: id})
```

**Kafka 消息（手动）：**

```go
// Producer：注入 trace context
carrier := otelsarama.NewProducerRecordCarrier(topic, key, value)
otel.GetTextMapPropagator().Inject(ctx, carrier)

// Consumer：提取 trace context
ctx := otel.GetTextMapPropagator().Extract(context.Background(), 
    otelsarama.NewConsumerMessageCarrier(message))
```

### 客户端排障入口

**响应头 `X-Trace-Id`：**

```http
HTTP/1.1 200 OK
X-Trace-Id: abc123def456...
```

**使用方式：**
1. 客户端报错时，从响应头获取 `trace_id`
2. 在 Jaeger 中搜索 `trace_id`
3. 查看完整链路，定位问题

## 常见问题

### Q: 为什么登录接口需要手动记录学号？

A: `AttributeMiddleware` 从 JWT claims 中读取学号，但登录接口在验证成功后才生成 JWT。如果不在登录时手动记录，登录失败的链路就无法关联到学号。

### Q: 如何按学号检索链路？

A: 在 Jaeger 的搜索界面中：
1. 选择 Service: `bff`
2. 添加 Tag: `student_id=2024210000`
3. 点击 Find Traces

### Q: 日志中没有 trace_id 怎么办？

A: 检查是否使用了 `logger.WithContext(ctx)`。如果 context 中没有 span，日志就不会携带 trace_id。

### Q: 如何关闭 OTel？

A: 在配置文件中设置 `otel.endpoint` 为空字符串，或者在 `otelx.SetupOTel` 中添加开关判断。

---

## 参考资料

- [OpenTelemetry Go SDK](https://opentelemetry.io/docs/instrumentation/go/)
- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
