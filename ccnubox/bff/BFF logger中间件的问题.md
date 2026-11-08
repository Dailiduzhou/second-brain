---
category: ccnubox
type: deep-dive
topic: middleware
frameworks:
  - gin
module: bff
status: seedling
tags:
  - ccnubox/bff
  - ccnubox/bff/middleware
  - middleware
  - error-handling
  - logging
aliases:
  - Logger中间件问题
  - BFF Logger问题
---

# BFF Logger 中间件的问题

> 本文是 [[BFF 中间件错误处理]] 中 `LoggerMiddleware.handleResponse` 的代码审查，分析其中存在的两个运行时缺陷与一个安全隐患。

## `errors.Unwrap` 导致空指针与真实错误丢失

> [!warning] 错误解包陷阱
> `errors.Unwrap()` 仅在错误被 `fmt.Errorf("... %w", err)` 包装过时才返回内层错误。若业务代码直接抛出 `errors.New("数据库连接超时")`，`errors.Unwrap` 返回 `nil`，导致真实错误信息被 `if unwarpERR == nil` 分支吞掉，日志只记录"意外错误类型"。

原代码：

```go
err := ctx.Errors.Last().Err
unwarpERR := errors.Unwrap(err)
if unwarpERR == nil { ... return 500 }
```

**修复**：使用 `errors.As` 自动解包并匹配类型，无论包装层数：

```go
var bizErr *b_errorx.CustomError
if errors.As(err, &bizErr) {
    // 处理业务错误
}
```

## `!ctx.IsAborted()` 无法阻止双重响应

> [!warning] 双重响应风险
> `ctx.IsAborted()` 仅检测是否调用过 `ctx.Abort()`。若 Handler 自行调用 `ctx.JSON()` 但未调用 `Abort()`，Logger 中间件会再次写入响应，触发 `http: multiple response.WriteHeader calls`。

原代码：

```go
if !ctx.IsAborted() { 
    ctx.JSON(httpCode, res)
}
```

**修复**：使用 `!ctx.Writer.Written()` 检查是否已写入响应流：

```go
if !ctx.Writer.Written() {
    ctx.JSON(httpCode, res)
}
```

## Header 全量打印泄露敏感信息

> [!danger] 安全风险
> 会将 `Authorization`、`Cookie` 等敏感凭证写入日志，存在越权与凭证泄露风险。应过滤敏感字段或仅打印特定 Header（如 `X-Request-Id`）。

原代码：

```go
logger.String("headers", fmt.Sprintf("%v", ctx.Request.Header))
```

## 优化后的参考代码

```go
func (lm *LoggerMiddleware) handleResponse(ctx *gin.Context) (web.Response, int) {
	var res web.Response
	httpCode := ctx.Writer.Status()

	if len(ctx.Errors) > 0 {
		err := ctx.Errors.Last().Err
		var bizErr *b_errorx.CustomError

		if errors.As(err, &bizErr) {
			lm.log.WithContext(ctx).Error("处理请求出错(业务异常)",
				logger.Error(bizErr),
				logger.String("ip", ctx.ClientIP()),
				logger.String("path", ctx.Request.URL.Path),
				logger.Int("httpCode", bizErr.HttpCode),
				logger.Int("code", bizErr.Code),
			)
			return web.Response{Code: bizErr.Code, Msg: bizErr.Message, Data: nil}, bizErr.HttpCode
		}

		lm.log.WithContext(ctx).Error("处理请求出错(未知异常)",
			logger.Error(err),
			logger.String("ip", ctx.ClientIP()),
			logger.String("path", ctx.Request.URL.Path),
		)
		return web.Response{Code: errs.ERROR_TYPE_ERROR_CODE, Msg: err.Error(), Data: nil}, http.StatusInternalServerError
	}

	lm.log.WithContext(ctx).Info("请求正常",
		logger.String("ip", ctx.ClientIP()),
		logger.String("path", ctx.Request.URL.Path),
	)

	res = ginx.GetResp[web.Response](ctx)

	if httpCode == http.StatusNotFound {
		res.Msg = "不存在的路由或请求方法!"
	}

	return res, httpCode
}

func (lm *LoggerMiddleware) MiddlewareFunc() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		ctx.Next()

		res, httpCode := lm.handleResponse(ctx)

		if !ctx.Writer.Written() {
			ctx.JSON(httpCode, res)
		}
	}
}
```

## 问题总结

1. **错误解包问题**：`errors.Unwrap` 无法处理未包装的错误，导致真实错误信息丢失
2. **双重响应问题**：`ctx.IsAborted()` 无法正确检测响应是否已写入
3. **安全敏感信息泄露**：全量打印 Headers 会泄露敏感凭证

## 解决方案总结

1. **使用 `errors.As`**：自动解包并匹配错误类型，无论包装层数
2. **使用 `ctx.Writer.Written()`**：准确检测响应是否已写入
3. **过滤敏感 Header**：仅记录必要的 Header 信息，如 `X-Request-Id`

## 相关资源

- [[BFF 中间件错误处理]] - BFF 中间件错误处理完整指南
