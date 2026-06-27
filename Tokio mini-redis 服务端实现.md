---
category: programming-language
type: deep-dive
topic: mini-redis
frameworks:
  - tokio
status: done
title: Tokio mini-redis 服务端实现
aliases:
  - mini-redis server
tags:
  - programming-language/rust
  - programming-language/rust/mini-redis
  - programming-language/rust/tokio
  - database/redis
---

# Tokio mini-redis 服务端实现

> [!note] 前置阅读
> 本文聚焦 `mini-redis` 中 `server::run` 的实现。数据帧解析见 [[Tokio mini-redis 数据帧解析]]，存储结构见 [[Tokio mini-redis DB实现]]。

## 目标

- 梳理 `Listener` 的整体控制流：监听连接 → 分发到 `Handler` → 优雅退出。
- 解释 `broadcast` / `mpsc` / `Semaphore` 三个原语在 server 中的角色。
- 说明**优雅退出**（Graceful Shutdown）是如何通过信号量、广播与多对一收信组合实现的。

## 整体流程

```plaintext
server::run(..., ctrl_c()) 创建服务
|
Listener 负责控制整体的退出，使用 Semaphore 控制并发
|
Handler 负责数据帧解析和指令执行
```

## `server::run` 入口

`server::run` 是服务端启动入口，主要做了三件事：

1. 构造 `Listener`，初始化数据库 (`DbDropGuard`)、信号量 (`Semaphore`)、关闭信号 (`broadcast`) 与完成通知 (`mpsc`)。
2. 用 `tokio::select!` 监听两类信号：监听循环自身退出 / `shutdown` 触发（一般是 `ctrl_c`）。
3. 显式 `drop(notify_shutdown)` + `drop(shutdown_complete_tx)`，再 `await` 所有 `Handler` 退出。

```rust
pub async fn run(listener: TcpListener, shutdown: impl Future) {

    // notify_shutdown 向各 Handler 发送关闭消息
    // shutdown_complete_tx 用于传递各 Handler 安全退出的通知
    // shutdown_complete_rx 得到信息，则说明安全退出成功
    let (notify_shutdown, _) = broadcast::channel(1);
    let (shutdown_complete_tx, mut shutdown_complete_rx) = mpsc::channel(1);

    // 初始化 listener 状态
    let mut server = Listener {
        listener,
        db_holder: DbDropGuard::new(),
        limit_connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        notify_shutdown,
        shutdown_complete_tx,
    };

    // shutdown 用于接受 ctrl_c() 的退出信号
    tokio::select! {
        res = server.run() => {
            // 这里是若接收错误，TCP listener 多次 accept 失败，
            // 服务端放弃并关闭。
            //
            // 处理单条连接时遇到的错误不会冒泡到这一层。
            if let Err(err) = res {
                error!(cause = %err, "failed to accept");
            }
        }
        _ = shutdown => {
            // 已收到关闭信号
            info!("shutting down");
        }
    }

    // 解构出 shutdown_complete 收发端
    // 显式 drop shutdown_transmitter。这一点很关键，
    // 否则下面的 .await 永远等不到完成。
    let Listener {
        shutdown_complete_tx,
        notify_shutdown,
        ..
    } = server;

    // 当 notify_shutdown 被 drop 后，所有 subscribe 过的任务都会
    // 收到关闭信号并退出
    drop(notify_shutdown);
    // drop 最后一个 Sender，下面的 Receiver 才能结束
    drop(shutdown_complete_tx);

    // 等待所有活跃连接处理完毕。由于 listener 持有的 Sender
    // 已经在上面 drop，剩下的 Sender 只由 connection handler
    // 任务持有。handler 退出后，mpsc 通道会关闭，
    // recv() 返回 None。
    let _ = shutdown_complete_rx.recv().await;
}
```

> [!tip] 为什么最后要 `drop` 两个 sender
> - `drop(notify_shutdown)`：触发所有 `Handler` 的 `shutdown()` 接收端。
> - `drop(shutdown_complete_tx)`：让 `shutdown_complete_rx.recv()` 能在所有 handler 退出后返回 `None`。
> 缺一不可，否则 `recv()` 永远阻塞。

## 信号量控制并发

通过 `Arc<Semaphore>` 控制**同时**处理的连接数，超出上限的连接在 `accept` 后需要等信号量。

```rust
let permit = self
    .limit_connections
    .clone()
    .acquire_owned()
    .await
    .unwrap();

//...
// 生成接收信号的 handler
tokio::spawn(async move {
    // 处理连接。如果遇到错误，记录日志
    if let Err(err) = handler.run().await {
        error!(cause = ?err, "connection error");
    }

    // 在退出后，释放信号量
    drop(permit);
});
```

> [!info] 用 `acquire_owned` + `drop(permit)` 的好处
> `permit` 是 owned 形式，可以直接 `move` 到 `spawn` 出来的任务里。
> handler 退出 → `permit` 被 `drop` → 信号量计数自动 +1，不需要手动 `release()`。

## 指数退让（Exponential Backoff）

`Listener::accept` 在 `accept` 失败时**指数退让**，避免对系统造成持续压力：

```rust
async fn accept(&mut self) -> crate::Result<TcpStream> {
    let mut backoff = 1;

    // 尝试 accept 几次
    loop {
        // 执行 accept 操作。如果成功 accept 一个 socket，
        // 就返回它；否则保留错误
        match self.listener.accept().await {
            Ok((socket, _)) => return Ok(socket),
            Err(err) => {
                if backoff > 64 {
                    // Accept 失败次数过多，返回错误
                    return Err(err.into());
                }
            }
        }

        // 暂停执行直到退避期结束
        time::sleep(Duration::from_secs(backoff)).await;

        // 把退避时间翻倍
        backoff *= 2;
    }
}
```

退避序列：`1s → 2s → 4s → 8s → 16s → 32s → 64s`，超过 `64s` 后直接放弃并把错误冒泡到 `server::run` 的 `tokio::select!` 分支。

## 跨主题链接

- [[Tokio mini-redis 数据帧解析]] — `Frame` 与解析
- [[Tokio mini-redis TCP连接]] — 连接建立
- [[Tokio mini-redis DB实现]] — 存储结构
- [[Tokio Mini-Redis 源码阅读]] — 总览
- [[Tokio mini-redis SUB 实现]] — Pub/Sub 服务端
