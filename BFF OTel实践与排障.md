---
category: ccnubox
type: deep-dive
topic: otel
module: bff
status: seedling
title: BFF OTel 实践与排障
aliases:
  - BFF OTel排障
  - BFF OTel实践
tags:
  - ccnubox
  - ccnubox/bff
  - ccnubox/bff/otel
---
# OTel 实践与排障

本文档补充 [[BFF Otel使用]]，聚焦 OTel 在项目中的实践约定、传播边界、排障入口与常见问题。

## 实践约定

### 学号记录策略

项目采用两层记录策略：

| 场景 | 记录方式 | 位置 |
|------|----------|------|
| 已认证请求 | `AttributeMiddleware` 自动记录 | `bff/web/middleware/otel.go:54` |
| 登录接口 | 手动记录 | `bff/web/user/user.go:65` |

这样设计是因为：

- `AttributeMiddleware` 依赖 JWT，但登录时还没有 JWT
- 登录接口是用户反馈问题的主要来源，必须记录学号

### 日志必须绑定上下文

必须使用 `WithContext(ctx)`：

```go
// 正确
l := logger.WithContext(ctx)
l.Info("operation success")

// 错误：日志不会携带 trace_id
logger.Info("operation success")
```

### 错误要写回 span

推荐在错误路径中显式记录：

```go
span := trace.SpanFromContext(ctx)
if err != nil {
    span.RecordError(err)
    span.SetStatus(codes.Error, err.Error())
    return err
}
```

也可以通过 `TraceLogger` 自动上报：

```go
l := logger.WithContext(ctx)
l.Error("operation failed", logger.Error(err))
```

## 传播边界

### HTTP 调用

```go
resp, err := http.Get("http://backend-service/api")
```

使用带 OTel 接入的 HTTP 客户端时，请求上下文会自动传播。

### gRPC 调用

```go
resp, err := client.GetUser(ctx, &GetUserReq{Id: id})
```

gRPC 调用在同一上下文链路下自动传播 trace 信息。

### Kafka 消息

Kafka 是手动传播边界，需要显式注入和提取：

```go
carrier := otelsarama.NewProducerRecordCarrier(topic, key, value)
otel.GetTextMapPropagator().Inject(ctx, carrier)

ctx := otel.GetTextMapPropagator().Extract(
    context.Background(),
    otelsarama.NewConsumerMessageCarrier(message),
)
```

## 客户端排障入口

### `X-Trace-Id`

响应头会返回：

```http
HTTP/1.1 200 OK
X-Trace-Id: abc123def456...
```

排障路径：

1. 从客户端响应头获取 `trace_id`
2. 在 Jaeger 中搜索 `trace_id`
3. 结合日志中的 `trace_id` / `span_id` 还原完整调用链

### 按学号检索

在 Jaeger 搜索界面中：

1. 选择 `Service: bff`
2. 添加 `Tag: student_id=<学号>`
3. 查询相关 traces

## 常见问题

### 为什么登录接口需要手动记录学号？

因为登录成功后才会生成 JWT，而 `AttributeMiddleware` 依赖 JWT claims。若不手动记录，登录失败链路无法关联到学号。

### 日志中没有 `trace_id` 怎么办？

优先检查是否使用了 `logger.WithContext(ctx)`。如果当前 `context` 中没有有效 span，日志不会自动携带 `trace_id`。

### 如何关闭 OTel？

可以在配置文件中将 `otel.endpoint` 设为空，或者在 `otelx.SetupOTel` 中增加显式开关判断。

### 为什么客户端排障优先看 `X-Trace-Id`？

因为它是请求完成后最容易从前端、网关或抓包结果中直接拿到的链路标识，也是 Jaeger 与结构化日志的共同关联键。

## 参考资料

- [OpenTelemetry Go SDK](https://opentelemetry.io/docs/instrumentation/go/)
- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
