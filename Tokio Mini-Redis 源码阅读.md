---
category: programming-language
type: source-code
topic: mini-redis
frameworks:
  - tokio
status: seedling
tags:
  - programming-language/rust/tokio
  - programming-language/rust/mini-redis
---

# Tokio Mini-Redis 源码阅读

## `tokio-rs/mini-redis` 简介

[mini-redis](https://github.com/tokio-rs/mini-redis) 并不是一个要在生产环境中使用的项目，它的核心目标是**示范如何在 Rust 中正确使用 Tokio**。通过它，可以系统观察以下问题的实现方式：

- 如何基于 TCP 构建异步的网络服务端与客户端。
- 如何在多个异步任务（Tasks）之间安全地共享状态。
- 如何使用消息通道（Channels）进行任务间的通信。
- 如何处理字节流并将其解析为具有业务意义的数据帧（Framing）。
- 如何优雅地关闭异步服务（Graceful shutdown）。

[Tokio Tutorial](https://tokio.rs/tokio/tutorial) 也以 `mini-redis` 为例讲解了其中的关键设计。

## 项目结构

```
.
├── Cargo.lock
├── Cargo.toml
├── examples
│   ├── chat.rs
│   ├── hello_world.rs
│   ├── pub.rs
│   └── sub.rs
├── LICENSE
├── README.md
├── src
│   ├── bin
│   │   ├── cli.rs        # cli 入口，使用clap
│   │   └── server.rs
│   ├── clients
│   │   ├── blocking_client.rs
│   │   ├── buffered_client.rs
│   │   ├── client.rs
│   │   └── mod.rs
│   ├── cmd             # 子命令实现
│   │   ├── get.rs
│   │   ├── mod.rs
│   │   ├── ping.rs
│   │   ├── publish.rs
│   │   ├── set.rs
│   │   ├── subscribe.rs
│   │   └── unknown.rs
│   ├── connection.rs
│   ├── db.rs
│   ├── frame.rs                 # 数据帧解析实现
│   ├── lib.rs
│   ├── parse.rs
│   ├── server.rs
│   └── shutdown.rs
├── target
└── tests
```

## 阅读路径

下面的几篇笔记按照“工程结构 -> 协议解析 -> 连接实现 -> 协议扩展”的顺序组织，便于逐步展开阅读。

### 工程项目规范

- [[从 mini-redis 看Rust工程项目规范]]

### 协议解析与成帧

- [[Tokio mini-redis 数据帧解析]]
- [[Tokio mini-redis TCP连接]]

### 数据存储和定时清理实现

- [[Tokio mini-redis DB实现]]
### 扩展实现

- [[Tokio mini-redis Array写入与NullArray支持]]
