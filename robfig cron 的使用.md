---
title: robfig cron 的使用
category: knowledge-management
type: deep-dive
topic: cron
status: seedling
tags:
  - programming-language/go
  - programming-language/go/cron
---

# robfig cron 的使用

[robfig/cron/v3](https://github.com/robfig/cron/v3) 是一个 Go 语言定时任务库。

## **核心特性**

1. **秒级调度**: 实现精确到秒的定时任务
2. **中间件(`Chain`/`Job Wrapper`)**：内置了类似Web框架的中间件
3. **动态管理**:使用`AddFunc`和`Remove`方便地添加和删除定时任务。

## 底层原理

`robfig/cron/v3` 的底层并不依赖任何外部组件，而是纯粹基于 **Golang 的原生并发原语（Goroutines & Channels）** 和 **标准库时间处理（`time.Timer`）** 实现的。
其核心运行机制是一个**事件驱动的单主协程循环**：

1. **数据结构**：所有添加的任务都被封装成一个 `Entry` 结构体，存放在一个切片中。每次添加或执行完任务后，调度器会根据下次执行时间（`Next`）对这个切片进行排序。
2. **时间计算**：调度器取出切片中**最先需要执行**的任务，计算当前时间到该任务执行时间的差值（Duration）。
3. **睡眠等待**：主调度协程（Dispatcher）启动一个 `time.Timer`，并在这个时间差内进入阻塞（`select` 监听定时器 channel 和外部控制 channel）。
4. **并发执行**：一旦定时器触发，调度器会被唤醒，遍历所有到达执行时间的任务，并为每个任务**单独启动一个新的 Goroutine** 进行并发执行（`go job.Run()`）。
5. **循环往复**：任务启动后，调度器重新计算这些任务的下一次执行时间，重新排序，并回到步骤 2。

## 用法

### **基础用法**
```go
package main

import (
	"fmt"
	"time"
	"github.com/robfig/cron/v3"
)

func main() {
	// 1. 创建支持秒级任务的调度器
	c := cron.New(cron.WithSeconds())

	// 2. 添加定时任务 (AddFunc)
	// 表达式: 每 5 秒钟执行一次
	// 定时任务时间格式（WithSeconds 启用秒级）：<秒> <分> <时> <日> <月> <星期>
	c.AddFunc("*/5 * * * *", func() {
		fmt.Println("任务执行:", time.Now().Format("15:04:05"))
	})

	// 3. 启动调度器 (在后台单独启动一个 Goroutine 运行)
	c.Start()
	fmt.Println("Cron 调度器已启动...")

	// 4. 阻塞主协程，防止程序退出
	select {} 
}
```

### **指定时区**
```go
// 加载上海时区
loc, _ := time.LoadLocation("Asia/Shanghai")

// 初始化时注入时区
c := cron.New(cron.WithLocation(loc))

// 或者在表达式中直接指定时区 (CRON_TZ)
c.AddFunc("CRON_TZ=Asia/Tokyo 0 12 * * *", func() {
    fmt.Println("每天东京时间中午 12 点执行")
})
```

### 使用 Wrapper 控制并发与容错

官方内置了三种极为实用的 Wrapper：
1. `SkipIfStillRunning`：如果上一次任务还没执行完，**跳过**本次执行（防重叠最常用）。
2. `DelayIfStillRunning`：如果上一次任务还没执行完，**排队等待**它完成后再执行本次任务。
3. `Recover`：捕获任务内部发生的 `panic`，防止整个程序崩溃。

示例：
```go
package main

import (
	"fmt"
	"time"
	"github.com/robfig/cron/v3"
)

// 定义一个实现 cron.Job 接口的结构体
type myJob struct{}

func (m myJob) Run() {
	fmt.Println("开始执行耗时任务...")
	time.Sleep(3 * time.Second) // 模拟耗时 3 秒的任务
	fmt.Println("任务执行完毕！")
}

func main() {
	c := cron.New(cron.WithSeconds())

	// 组装中间件链：先捕获 panic，再防重叠跳过
	chain := cron.NewChain(
		cron.Recover(cron.DefaultLogger),
		cron.SkipIfStillRunning(cron.DefaultLogger),
	)

	// 任务设置为每 1 秒触发一次，但任务本身耗时 3 秒
	// 结果：第 1 秒触发执行，第 2、3 秒的触发会被跳过，第 4 秒再次触发执行
	c.AddJob("*/1 * * * * *", chain.Then(myJob{}))

	c.Start()
	select {}
}
```

### 动态管理

```go
// AddFunc 会返回一个 EntryID
id, _ := c.AddFunc("0 0 * * *", func() { fmt.Println("每日任务") })

// 移除指定任务（不会影响正在执行的 Goroutine，但不会再触发下一次）
c.Remove(id)

// 停止调度器（阻止未来所有任务触发，但【不会】中断已经启动的 Goroutine）
c.Stop()
```