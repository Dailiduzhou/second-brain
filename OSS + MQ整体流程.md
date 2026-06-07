---
category: ecommerce
type: object-storage
topic: oss
status:
tags:
  - ecommerce
  - ecommerce/oss
---
结合你的技术栈，要完美解决**异步落库、上传失败检测、保证落库正常工作**，核心设计思想是：**“积极入库、延迟检查、依靠队列重试机制保障最终一致性”**。

### 一、 核心架构设计与时序
整个流程分为三个核心阶段，通过 River MQ 的**立即任务**和延迟任务（Delayed Job）来驱动：

```
阶段 1: 申请 Token (埋下暗线)
前端 -> Kratos: 申请上传凭证 
Kratos -> 开启 PG 事务:
   ├── 写入一条“上传中”的媒体存根记录到 DB
   └── 投递一个【延迟15分钟】的 River 检查任务 (CheckUploadTimeout)
Kratos -> 前端: 返回 Token & 业务ID

阶段 2: OSS 回调 (异步解耦)
前端 -> OSS: 携带 Token 直传文件
OSS -> Kratos: 发起回调 (Webhook)
Kratos -> 开启 PG 事务:
   ├── 投递一个【立即执行】的落库任务 (ProcessOssCallback)
   └── 提交事务，瞬间向 OSS 返回 {"Status":"OK"} (不等待真正落库，防止OSS超时)

阶段 3: 队列异步消费 (最终落地)
River Worker -> 执行 ProcessOssCallback 任务:
   └── 更新 DB 媒体记录为“已完成”，并绑定商品
River Worker -> 15分钟后执行 CheckUploadTimeout 任务:
   └── 检查 DB，若状态仍为“上传中”，说明前端失败或放弃。触发失败处理逻辑。

```

### 二、 Go-Kratos + River MQ 核心代码实现

#### 1. 定义 River MQ 任务结构体（Args）
在 Go 中，River 要求任务参数实现 `river.JobArgs` 接口：

```go
package jobs

import "context"

// ProcessOssCallbackArgs 立即执行：处理OSS回调落库
type ProcessOssCallbackArgs struct {
	ObjectKey string `json:"object_key"`
	GoodsID   string `json:"goods_id"`
	Size      int64  `json:"size"`
}
func (ProcessOssCallbackArgs) Kind() string { return "oss.callback.process" }

// CheckUploadTimeoutArgs 延迟执行：检测上传是否超时失败
type CheckUploadTimeoutArgs struct {
	ObjectKey string `json:"object_key"`
	GoodsID   string `json:"goods_id"`
}
func (CheckUploadTimeoutArgs) Kind() string { return "oss.upload.timeout_check" }

```

#### 2. Kratos 接口层：处理 OSS 回调并投递异步任务
在 Kratos 的 Raw Route 回调接口中，我们只做两件事：**验签**、**利用事务投递 River 任务并返回**。

```go
func (h *OssCallbackHandler) HandleCallback(w http.ResponseWriter, r *http.Request) {
	// ... 省略验签与 Body 解析逻辑 (得到 callbackData) ...

	// 开启 Postgres 事务
	ctx := r.Context()
	tx, err := h.db.Begin(ctx) // h.db 为 *jackc/pgx/v5 
	if err != nil {
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(ctx)

	// 使用同一个事务，向 River MQ 投递异步落库任务
	_, err = h.riverClient.InsertTx(ctx, tx, jobs.ProcessOssCallbackArgs{
		ObjectKey: callbackData.ObjectKey,
		GoodsID:   callbackData.GoodsID,
		Size:      callbackData.Size,
	}, nil)
	if err != nil {
		h.log.Errorf("投递异步落库任务失败: %v", err)
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}

	// 提交事务：DB 记录和队列任务同时成功
	if err := tx.Commit(ctx); err != nil {
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}

	// 瞬间响应 OSS，耗时极短 (<20ms)，绝不超时
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"Status":"OK"}`))
}

```

#### 3. Worker 消费层：实现异步落库与超时检测
编写 Worker 来具体执行队列中的任务。

```go
// OssCallbackWorker 处理真正的业务落库
type OssCallbackWorker struct {
	river.WorkerDefaults[jobs.ProcessOssCallbackArgs]
	repo *biz.ProductRepo
}

func (w *OssCallbackWorker) Work(ctx context.Context, job *river.Job[jobs.ProcessOssCallbackArgs]) error {
	args := job.Args
	
	// 1. 保证幂等性：去数据库查一下这个 ObjectKey 是否已经处理过了
	media, err := w.repo.FindByKey(ctx, args.ObjectKey)
	if err == nil && media.Status == biz.StatusActive {
		return nil // 已经处理成功，直接返回（幂等成功）
	}

	// 2. 真正的落库业务：更新状态为“可用”，并绑定到商品
	err = w.repo.CompleteAndBindMedia(ctx, args.GoodsID, args.ObjectKey, args.Size)
	if err != nil {
		// 返回错误，River MQ 会自动触发指数退避重试 (Exponential Backoff)
		return err 
	}
	return nil
}

// TimeoutCheckWorker 处理超时检测
type TimeoutCheckWorker struct {
	river.WorkerDefaults[jobs.CheckUploadTimeoutArgs]
	repo *biz.ProductRepo
	ossClient *oss.Client
}

func (w *TimeoutCheckWorker) Work(ctx context.Context, job *river.Job[jobs.CheckUploadTimeoutArgs]) error {
	args := job.Args
	
	media, err := w.repo.FindByKey(ctx, args.ObjectKey)
	if err != nil {
		return nil // 没找到记录，可能被其他业务清理了
	}

	// 如果15分钟后，状态依然是 "Pending"（上传中），说明前端上传失败了、或者用户直接关闭了网页
	if media.Status == biz.StatusPending {
		// 1. 将数据库中的存根状态改为 "Failed" (上传失败)
		_ = w.repo.UpdateStatus(ctx, args.ObjectKey, biz.StatusFailed)
		
		// 2. 异步清理：调用 OSS SDK 彻底删除 OSS 上的这个孤儿文件（防止万一前端传了一半）
		_ = w.ossClient.DeleteObject(args.ObjectKey)
	}
	return nil
}

```

### 三、 深度探索：River MQ 与 Postgres 状态流转
为了让你彻底看清在**正常上传、网络抖动、用户流产、数据库故障**等各种极端情况下，PostgreSQL 的数据状态与 River MQ 的任务队列是如何交织演进、自我修复的，你可以通过下方的**分布式状态模拟器**进行直观演练：

### 四、 如何百分之百保证落库正常工作？（避坑与高可用防线）

1. **River MQ 的最大救星：自动重试**
如果你的数据库发生短暂死锁、网络连接满，Worker 在执行 `Work()` 时返回 `err`，River 会根据默认规则自动进行 **指数退避重试（比如：1秒后、2秒后、4秒后...重试）**。这消除了瞬时抖动带来的业务失败。
2. **核心红线：强幂等设计**
由于 River 会重试，或者 OSS 回调可能会由于网络原因发送多次，`OssCallbackWorker` 内部更新数据库时，**绝对不能盲目 UPDATE**。必须先校验当前状态，如果是 `Active`，直接返回 `nil` 宣告成功。
3. **优雅停机（Graceful Shutdown）**
当你的 Kratos 实例因为部署新版本需要重启时，正在执行落库的 Worker 不能被强行杀死。在 Kratos 的 `main.go` 中关停服务时，务必**先关闭 HTTP/gRPC 网关，再调用 riverClient.Stop()**。River 会等待当前正在运行的作业完成（默认有超时保护）再退出，防止落库任务断在线上。
4. **River 的 SKIP LOCKED 性能保障**
很多传统的 PG 队列会因为大量的 `SELECT ... FOR UPDATE` 导致锁表，而 River MQ 底层充分利用了 Postgres 的 `FOR UPDATE SKIP LOCKED` 特性。这使得你可以部署多个 Kratos 节点作为 Worker 抢占式消费落库任务，横向扩展能力极强，完全能够撑住大促期间的并发上传落库。