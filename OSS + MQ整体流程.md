---
category: ecommerce
type: object-storage
topic: oss
frameworks:
  - go-kratos
  - riverqueue
status: seedling
tags:
  - ecommerce/oss
  - message-queue/riverqueue
---

# OSS + MQ整体流程

OSS 上传落库适合采用“预创建记录、快速确认回调、队列异步落库、延迟任务兜底”的模式。核心目标是让 OSS 回调尽快返回，同时用 River 的事务性入队和重试机制保证最终一致性。

## 状态模型

| 状态 | 含义 |
|------|------|
| `pending` | 已发放上传凭证，等待前端上传或 OSS 回调 |
| `active` | OSS 已确认上传，媒体记录可被业务使用 |
| `failed` | 超时未完成或确认失败 |
| `deleted` | 已被业务或清理任务删除 |

## 三阶段流程

### 1. 申请 Token

```text
前端 -> Kratos: 申请上传凭证
Kratos -> PostgreSQL:
  - 创建 media(status=pending)
  - 事务性投递延迟任务 CheckUploadTimeout
Kratos -> 前端: 返回 token、object_key、media_id
```

### 2. OSS 回调

```text
前端 -> OSS: 直传文件
OSS -> Kratos: 回调上传结果
Kratos -> River:
  - 验签
  - 事务性投递立即任务 ProcessOssCallback
Kratos -> OSS: 快速返回 {"Status":"OK"}
```

### 3. Worker 落库

```text
River Worker -> PostgreSQL:
  - 根据 media_id 或 object_key 查询记录
  - 幂等更新为 active
  - 绑定商品、用户或业务上下文
延迟 Worker:
  - 15 分钟后检查仍为 pending 的记录
  - 标记 failed，并触发对象清理
```

## River Job Args

```go
package jobs

type ProcessOssCallbackArgs struct {
    MediaID   string `json:"media_id"`
    ObjectKey string `json:"object_key"`
    GoodsID   string `json:"goods_id"`
    Size      int64  `json:"size"`
}

func (ProcessOssCallbackArgs) Kind() string {
    return "oss.callback.process"
}

type CheckUploadTimeoutArgs struct {
    MediaID   string `json:"media_id"`
    ObjectKey string `json:"object_key"`
}

func (CheckUploadTimeoutArgs) Kind() string {
    return "oss.upload.timeout_check"
}
```

## 回调内只投递任务

```go
func (h *OssCallbackHandler) HandleCallback(w http.ResponseWriter, r *http.Request) {
    // 省略验签与解析，得到 callbackData。

    ctx := r.Context()
    tx, err := h.db.Begin(ctx)
    if err != nil {
        http.Error(w, "Internal Error", http.StatusInternalServerError)
        return
    }
    defer tx.Rollback(ctx)

    _, err = h.riverClient.InsertTx(ctx, tx, jobs.ProcessOssCallbackArgs{
        MediaID:   callbackData.MediaID,
        ObjectKey: callbackData.ObjectKey,
        GoodsID:   callbackData.GoodsID,
        Size:      callbackData.Size,
    }, nil)
    if err != nil {
        http.Error(w, "Internal Error", http.StatusInternalServerError)
        return
    }

    if err := tx.Commit(ctx); err != nil {
        http.Error(w, "Internal Error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    _, _ = w.Write([]byte(`{"Status":"OK"}`))
}
```

## Worker 幂等落库

```go
type OssCallbackWorker struct {
    river.WorkerDefaults[jobs.ProcessOssCallbackArgs]
    repo *biz.MediaRepo
}

func (w *OssCallbackWorker) Work(ctx context.Context, job *river.Job[jobs.ProcessOssCallbackArgs]) error {
    args := job.Args

    media, err := w.repo.FindByID(ctx, args.MediaID)
    if err != nil {
        return err
    }
    if media.Status == biz.MediaStatusActive {
        return nil
    }

    return w.repo.CompleteUpload(ctx, args.MediaID, args.ObjectKey, args.Size)
}
```

## 超时检测

```go
type TimeoutCheckWorker struct {
    river.WorkerDefaults[jobs.CheckUploadTimeoutArgs]
    repo      *biz.MediaRepo
    ossClient biz.OSSProvider
}

func (w *TimeoutCheckWorker) Work(ctx context.Context, job *river.Job[jobs.CheckUploadTimeoutArgs]) error {
    args := job.Args

    media, err := w.repo.FindByID(ctx, args.MediaID)
    if err != nil {
        return nil
    }
    if media.Status != biz.MediaStatusPending {
        return nil
    }

    if err := w.repo.MarkFailed(ctx, args.MediaID); err != nil {
        return err
    }
    return w.ossClient.DeleteObject(ctx, args.ObjectKey)
}
```

## 高可用要点

- River Worker 返回 `error` 时会重试，落库代码必须幂等。
- 队列入队和业务数据变更尽量放进同一个 PostgreSQL 事务。
- 多实例消费依赖 River 的锁机制，业务层仍需用唯一索引约束 `media_id` 或 `object_key`。
- 部署时先停止 HTTP 接入，再停止 River Worker，避免正在执行的任务被中断。

## 相关链接

- [[OSS 实现]]
- [[OSS 回调处理]]
- [[River key takeaway]]
- [[电商系统幂等性和细节]]
