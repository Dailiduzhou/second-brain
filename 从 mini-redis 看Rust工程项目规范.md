---
title: 从 mini-redis 看 Rust 工程项目规范
category: programming-language
type: architecture
topic: mini-redis
frameworks:
  - tokio
status: seedling
tags:
  - programming-language/rust
  - programming-language/rust/mini-redis
aliases:
  - Rust 项目规范讲解
  - mini-redis 工程结构
---

# 从 mini-redis 看 Rust 工程项目规范

本文以 [`tokio-rs/mini-redis`](https://github.com/tokio-rs/mini-redis) 为例，整理 Rust 工程项目中常见的目录划分、模块声明与可见性规范。

## 一、项目目录结构

```
mini-redis/
├── Cargo.toml              # 项目配置（依赖、bin/lib 声明）
├── src/
│   ├── lib.rs              # 库入口（对外暴露的 API）
│   ├── bin/
│   │   ├── server.rs       # 可执行文件：服务端
│   │   └── cli.rs          # 可执行文件：客户端
│   ├── cmd/
│   │   ├── mod.rs          # cmd 模块入口
│   │   ├── get.rs
│   │   ├── set.rs
│   │   ├── ping.rs
│   │   ├── publish.rs
│   │   ├── subscribe.rs
│   │   └── unknown.rs
│   ├── clients/
│   │   ├── mod.rs          # clients 模块入口
│   │   ├── client.rs
│   │   ├── blocking_client.rs
│   │   └── buffered_client.rs
│   ├── connection.rs       # 单文件模块
│   ├── db.rs
│   ├── frame.rs
│   ├── parse.rs
│   ├── server.rs
│   └── shutdown.rs
├── examples/               # 示例代码
└── tests/                  # 集成测试
```

## 二、`lib.rs` 的作用

`lib.rs` 是 **库 crate 的根文件**，相当于这个库的"总目录"。它做三件事：

1. **声明模块**：告诉编译器哪些文件/文件夹属于这个库
2. **控制可见性**：决定哪些东西对外暴露（`pub`），哪些内部使用
3. **重导出**：用 `pub use` 把内部类型提升到更简洁的路径

```rust
// src/lib.rs

pub mod clients;              // 公开模块，外部可以 mini_redis::clients::...
pub use clients::Client;      // 重导出，外部可以直接 mini_redis::Client

mod connection;               // 私有模块，外部不可见
pub use connection::Connection; // 但把 Connection 类型重导出为公开

mod db;                       // 完全私有
use db::Db;                   // 只在 crate 内部使用
```

## 三、`mod.rs` 的作用

`mod.rs` 是 **子模块的入口文件**。当一个模块是一个文件夹时，`mod.rs` 定义这个模块的内容。

例如 `src/cmd/` 是一个文件夹，`src/cmd/mod.rs` 就是 `cmd` 模块的根：

```rust
// src/cmd/mod.rs

mod get;                      // 私有子模块
pub use get::Get;             // 重导出 Get 类型

mod set;
pub use set::Set;

// 在这个文件里定义 Command 枚举，聚合所有命令
pub enum Command {
    Get(Get),
    Set(Set),
    // ...
}
```

> **注意**：Rust 2018 edition 之后，也可以用 `cmd.rs`（与文件夹同名）代替 `cmd/mod.rs`，两种风格选一即可。

## 四、可见性规范

Rust 的可见性有四个层级：

| 关键字 | 含义 |
|--------|------|
| `pub` | 对外公开，任何使用者都能访问 |
| `pub(crate)` | 整个 crate 内可见，外部不可见 |
| `pub(super)` | 父模块可见 |
| （默认私有） | 仅当前模块内可见 |

### mini-redis 中的实践

```rust
// src/lib.rs - 对外暴露的 API
pub mod clients;           // 公开模块
pub mod cmd;               // 公开模块
pub mod server;            // 公开模块
pub mod frame;             // 公开模块

mod connection;            // 私有！但通过 pub use 重导出
mod db;                    // 完全私有
mod parse;                 // 完全私有
mod shutdown;              // 完全私有
```

```rust
// src/cmd/mod.rs - 内部方法用 pub(crate)
impl Command {
    pub fn from_frame(...) -> ...            // 公开方法
    pub(crate) async fn apply(...)           // 仅 crate 内部使用
    pub(crate) fn get_name(...)              // 仅 crate 内部使用
}
```

## 五、可见性设计原则

### 1. 最小暴露原则

默认私有，只暴露必要的 API。`db`、`parse`、`shutdown` 都是内部实现细节，不对外暴露，通过 `pub use` 重导出需要的类型。

### 2. `pub(crate)` 用于内部共享

`Command::apply()` 需要被 `server` 模块调用，但不需要对外暴露。这比 `pub` 更安全，编译器会阻止外部误用。

### 3. 结构体字段默认私有

```rust
// src/cmd/get.rs
pub struct Get {
    key: String,    // 私有字段！外部无法直接访问
}
```

外部只能通过 `pub fn key(&self)` 方法读取，这保证了封装性。

### 4. bin 和 lib 分离

- `src/bin/server.rs` 是独立的可执行文件
- 它通过 `use mini_redis::...` 使用库的公开 API
- 无法访问 crate 内部的私有模块

```rust
// src/bin/server.rs
use mini_redis::{server, DEFAULT_PORT};  // 只能使用 pub 导出的内容
```

## 六、总结

| 文件 | 作用 |
|------|------|
| `lib.rs` | 库的根，声明所有模块，控制对外 API |
| `mod.rs` | 子模块的根，组织该模块的子项 |
| `bin/*.rs` | 可执行入口，只能使用 `pub` 导出的 API |

**可见性口诀**：

- 对外 API → `pub`
- 内部共享 → `pub(crate)`
- 模块私有 → 不加修饰符（默认）

## 相关文档

- [[Rust]]
- [[Tokio Mini-Redis 源码阅读]]
- [[Rust Stream 与 async_stream]]
