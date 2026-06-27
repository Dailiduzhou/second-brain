---
category: programming-language
type: enhancement
topic: mini-redis
frameworks:
  - tokio
status: done
tags:
  - programming-language/rust
  - programming-language/rust/tokio
  - programming-language/rust/mini-redis
  - architecture
  - pitfalls
---
## 设计中出现的问题

```rust
#[derive(Debug)]
struct State {
    entries: HashMap<String, Entry>,
    pub_sub: HashMap<String, broadcast::Sender<Bytes>>,
    expirations: BTreeSet<(Instant, String)>,
    shutdown: bool,
}
```

`Db`存储的状态，既包含**存储层**（数据持久化和状态存储），也包含**网络层**（消息代理和网络通信）功能，造成了整体的**职责混淆**。
整体的**分层结构**被打破。

## 理想的架构

```rust
// 1. 纯粹的存储引擎 (不再负责发消息)
pub struct KvStore {
    entries: HashMap<String, Entry>,
}

// 2. 专门的发布订阅代理
pub struct PubSubBroker {
    channels: HashMap<String, broadcast::Sender<Bytes>>,
}

// 3. 全局应用状态 (组合它们)
pub struct AppState {
    pub kv: Mutex<KvStore>,
    pub broker: Mutex<PubSubBroker>,
}

// 4. 在命令处理层 (Handler) 进行调度
async fn process_publish(app: &AppState, channel: String, msg: Bytes) {
    let broker = app.broker.lock().unwrap();
    if let Some(sender) = broker.channels.get(&channel) {
        // 网络/路由动作留在命令处理层
        let _ = sender.send(msg); 
    }
}
```

**重构后的好处：**
- **锁分离（Lock Sharding）：** 执行 `SET/GET` 压测时，不再会因为获取 `Db` 的锁而阻塞 `SUBSCRIBE/PUBLISH` 的流量，极大地提升了系统的并发吞吐量。
- **语义清晰：** 存储归存储，消息归消息。