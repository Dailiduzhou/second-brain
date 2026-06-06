---
category: microservice
topic: dtm
type: mechanism
status: seedling
tags:
  - microservice/dtm
  - reliability/retry
---
## HTTP状态码和dtm重试的关联

DTM 通过 `HTTPResp2DtmError`（`client/dtmcli/utils.go`）将 HTTP 响应映射为三种结果：

| HTTP 状态码 | 响应体 | DTM 结果 | 重试行为 |
|---|---|---|---|
| `200 OK` | 不含 `FAILURE` / `ONGOING` | **SUCCESS** | 不重试，分支标记成功 |
| `409 Conflict` | 任意 | **FAILURE** | Saga action → 分支标记 Failed 触发补偿；Saga compensate / TCC → 退避重试 |
| `425 Too Early` | 任意 | **ONGOING** | 保持间隔，继续重试（等业务方完成前置） |
| 其他 (如 `500`) | — | **通用错误** | 退避重试（间隔翻倍） |

**响应体字符串匹配**（向后兼容旧版本）：
- 即使 HTTP 200，若 body 中包含 `"FAILURE"` → 视为 FAILURE
- 即使 HTTP 200，若 body 中包含 `"ONGOING"` → 视为 ONGOING

### 服务端响应映射（`Result2HttpJSON`）

业务方返回以下 Go error 时，DTM SDK 自动映射：

| Go Error | HTTP 状态码 |
|---|---|
| `nil` | `200 OK` (body 为业务返回值) |
| `ErrFailure` | `409 Conflict` |
| `ErrOngoing` | `425 Too Early` |
| 其他 error | `500 Internal Server Error` |

### 典型场景

```
业务方正常完成 → 返回 nil → HTTP 200 → DTM 标记分支 SUCCESS → 不重试
业务方需要等待 → 返回 ErrOngoing → HTTP 425 → DTM 保持间隔重试
业务方明确失败 → 返回 ErrFailure → HTTP 409 → DTM 标记 Failed / 触发补偿
业务方内部异常 → 返回 error → HTTP 500 → DTM 退避重试
```

---

## gRPC状态码与dtm重试的关系

DTM 通过 `GrpcError2DtmError`（`client/dtmgrpc/type.go`）将 gRPC 状态码映射为三种结果：

| gRPC Status Code | message | DTM 结果 | 重试行为 |
|---|---|---|---|
| `OK` (0) | — | **SUCCESS** | 不重试，分支标记成功 |
| `Aborted` (10) | `"ONGOING"` | **ONGOING** | 保持间隔，继续重试 |
| `Aborted` (10) | 其他 | **FAILURE** | Saga action → 触发补偿；compensate → 退避重试 |
| `FailedPrecondition` (9) | 任意 | **ONGOING** | 保持间隔，继续重试 |
| 其他 code / 网络错误 | — | **通用错误** | 退避重试（间隔翻倍） |

### 服务端响应映射（`DtmError2GrpcError`）

业务方返回以下 Go error 时，DTM SDK 自动映射：

| Go Error | gRPC Status Code |
|---|---|
| `nil` | `OK` |
| `ErrFailure` | `codes.Aborted` |
| `ErrOngoing` | `codes.FailedPrecondition` |
| 其他 error | 透传 |

### 典型场景

```
业务方正常完成 → 返回 nil → gRPC OK → DTM 标记分支 SUCCESS
业务方需要等待 → 返回 ErrOngoing → FailedPrecondition → DTM 保持间隔重试
业务方明确失败 → 返回 ErrFailure → Aborted → DTM 标记 Failed
网络断开/超时 → DeadlineExceeded/Unavailable → 退避重试
```

---

## 退避策略与间隔

核心逻辑位于 `execBranch`（`dtmsvr/trans_status.go`）：

```
SUCCESS  → cronReset → 重置为基础间隔
ONGOING  → cronKeep  → 保持当前间隔不变
FAILURE  → cronBackoff → 间隔 × 2（指数退避）
通用错误  → cronBackoff → 间隔 × 2
```

### 基础间隔（cronReset）的确定顺序

1. 事务级别的 `RetryInterval`（通过 `TransOptions.RetryInterval` 设置）
2. 事务级别的 `TimeoutToFail`（当它小于全局配置的 `RetryInterval` 时）
3. 全局配置 `conf.RetryInterval`（默认值，如 10s）

### 退避示例

```
基础间隔 = 10s
第1次失败 → 10s 后重试
第2次失败 → 20s 后重试
第3次失败 → 40s 后重试
第4次失败 → 80s 后重试
...
任一次成功 → 重置为 10s
```

当重试次数超过 `conf.AlertRetryLimit` 时会触发告警 webhook 回调。

---

## Saga 模式下的特殊处理

在 Saga 模式中（`trans_type_saga.go`），`action` 分支的 FAILURE 与 `compensate` 分支处理不同：

- **Action 返回 FAILURE**：分支标记为 `StatusFailed`，触发全局状态切换为 `aborting`，开始执行补偿操作
- **Compensate 返回 FAILURE**：不会标记分支为 failed，而是继续退避重试，确保补偿最终成功

从 `getBranchResult` 中体现：
```go
if t.TransType == "saga" && branch.Op == OpAction && errors.Is(err, ErrFailure) {
    return StatusFailed, nil  // action failed → 触发补偿
} else if errors.Is(err, ErrOngoing) {
    return "", ErrOngoing      // ongoing → 保持间隔重试
}
return "", fmt.Errorf("unkown result will be retried: %w", err)  // 其他 → 退避重试
```
