---
category: programming-language
type: deep-dive
topic: mini-redis
frameworks:
  - tokio
status: seedling
tags:
  - programming-language/rust
  - programming-language/rust/tokio
  - database/redis
  - programming-language/rust/mini-redis
  - programming-language/rust/stream
---

# Tokio mini-redis SUB 实现

> [!note] 前置阅读
> 本文聚焦 `mini-redis` 中 `SUBSCRIBE` 命令的服务端实现。`Stream` 与 `async-stream` 的基础概念见 [[Rust Stream 与 async_stream]]。

`SUBSCRIBE` 服务端要做三件事：

1. 维护待订阅 `channel` 缓冲区，监听更新。
2. 聚合多个 `channel` 的消息流。
3. 处理 `TCP` 流与协议命令。

## 数据结构

```plaintext
Subscribe.channels: Vec<String>  →  待订阅缓冲区
StreamMap (subscriptions)        →  已订阅的活跃流
```

- `channels` 暂存本轮尚未提交到 `StreamMap` 的订阅请求。
- `subscriptions` 用 `tokio_stream::StreamMap` 聚合各 `channel` 对应的 `Stream`，以 `select!` 统一消费。

## `apply` 主循环

主要逻辑部分代码（`src/cmd/subscribe.rs`）：

```rust
#[derive(Debug)]
pub struct Subscribe {
    channels: Vec<String>, // channels 是一个待订阅 channel 的缓冲区
}

pub(crate) async fn apply(
    mut self,
    db: &Db,
    dst: &mut Connection,
    shutdown: &mut Shutdown,
) -> crate::Result<()> {
    // 使用 StreamMap 聚合各 Stream 的数据
    let mut subscriptions = StreamMap::new();

    loop {
        // 清空缓冲区，并聚合输入流
        // 虽然不是每次都需要更新订阅 channel 信息，
        // 但是 `drain` 对空 Vec 是安全的，且只有 O(1) 的复杂度
        for channel_name in self.channels.drain(..) {
            subscribe_to_channel(channel_name, &mut subscriptions, db, dst).await?;
        }

        // 监听三种事件：
        // 1. 从订阅的 channel 获取到数据
        // 2. 从客户端获得订阅 / 取消订阅的消息
        // 3. 服务端关闭
        select! {
            // 1. 已订阅 channel 推来的消息
            Some((channel_name, msg)) = subscriptions.next() => {
                dst.write_frame(&make_message_frame(channel_name, msg)).await?;
            }
            // 2. 客户端发来新的 SUBSCRIBE / UNSUBSCRIBE 命令
            res = dst.read_frame() => {
                let frame = match res? {
                    Some(frame) => frame,
                    // 客户端已断开连接
                    None => return Ok(()),
                };

                handle_command(
                    frame,
                    &mut self.channels,
                    &mut subscriptions,
                    dst,
                ).await?;
            }
            // 3. 服务端收到关闭信号
            _ = shutdown.recv() => {
                return Ok(());
            }
        };
    }
}
```

## 处理 SUB / UNSUB

### 订阅一个新 channel

```rust
async fn subscribe_to_channel(
    channel_name: String,
    subscriptions: &mut StreamMap<String, Messages>,
    db: &Db,
    dst: &mut Connection,
) -> crate::Result<()> {
    let mut rx = db.subscribe(channel_name.clone());

    // 将 broadcast::Receiver 适配为 Stream，
    // Item 类型与 msg 相同。
    let rx = Box::pin(async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(msg) => yield msg,
                // 消费速度跟不上广播时，丢弃过期的消息并继续
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
    });

    // 记录到当前客户端的订阅集合
    subscriptions.insert(channel_name.clone(), rx);

    // 回写订阅成功响应
    let response = make_subscribe_frame(channel_name, subscriptions.len());
    dst.write_frame(&response).await?;

    Ok(())
}
```

### 处理客户端发来的命令

```rust
async fn handle_command(
    frame: Frame,
    subscribe_to: &mut Vec<String>,
    subscriptions: &mut StreamMap<String, Messages>,
    dst: &mut Connection,
) -> crate::Result<()> {
    // 仅 `SUBSCRIBE` 与 `UNSUBSCRIBE` 命令在此上下文中合法。
    match Command::from_frame(frame)? {
        Command::Subscribe(subscribe) => {
            // 把新 channel 暂存到缓冲区，下一轮主循环统一处理
            subscribe_to.extend(subscribe.channels.into_iter());
        }
        Command::Unsubscribe(mut unsubscribe) => {
            // 不指定 channel 时，视为退订全部
            if unsubscribe.channels.is_empty() {
                unsubscribe.channels = subscriptions
                    .keys()
                    .map(|channel_name| channel_name.to_string())
                    .collect();
            }

            for channel_name in unsubscribe.channels {
                subscriptions.remove(&channel_name); // 移除 channel

                let response = make_unsubscribe_frame(channel_name, subscriptions.len());
                dst.write_frame(&response).await?;
            }
        }
        command => {
            let cmd = Unknown::new(command.get_name());
            cmd.apply(dst).await?;
        }
    }
    Ok(())
}
```

## 设计要点

- **聚合输出**：`StreamMap` 让多个 `channel` 的消息流被统一 `select!` 出来，避免嵌套 `select!`。
- **延迟订阅**：客户端可以在同一条 `SUBSCRIBE` 命令中传入多个 channel，实现方式是先写缓冲区再统一 `drain`，保证 channel 集合在追加过程中不被并发修改。
- **Lagged 处理**：广播通道在订阅者消费过慢时会丢消息；这里通过 `RecvError::Lagged` 静默恢复，让订阅者继续接收后续消息。
- **优雅关闭**：服务端 `shutdown` 信号会直接退出主循环，避免遗留订阅任务。

## 相关文档

- [[Rust]]
- [[Rust Stream 与 async_stream]]
- [[Tokio Mini-Redis 源码阅读]]
- [[Tokio mini-redis DB实现]] - `Db::subscribe` 的广播源
