---
category: programming-language
type: language-feature
topic: rust
status: seedling
tags:
  - programming-language/rust
  - programming-language/rust/async
  - programming-language/rust/stream
---

# Rust Stream 与 async_stream

`Stream` 是 Rust 异步生态中的核心抽象之一；`async-stream` crate 则是把 `Stream` 写成同步式语法的常用工具。本文整理 `Tokio Mini-Redis` 源码阅读中涉及到的两个前置概念。

## `Stream` 本质

在 `futures` crate 中的定义如下：

```rust
pub trait Stream {
    type Item;

    // Required method
    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>>;

    // Provided method
    fn size_hint(&self) -> (usize, Option<usize>) { ... }
}
```

它本质上是一个**异步迭代器（`Iterator`）**。

通过 `next().await` 调用。如果数据未准备好，`tokio` 会先“让出”CPU，数据准备好后再被唤醒并返回数据。

> [!tip] 与 `Iterator` 的对应关系
> - `Iterator::next() -> Option<Item>`
> - `Stream::poll_next() -> Poll<Option<Item>>`
>
> 二者的核心差异在于 `Stream` 需要参与异步调度，因此返回值用 `Poll<Option<...>>` 表达“未就绪 / 已结束 / 有值”三种状态。

## `async_stream` 中宏的作用

[`async-stream`](https://docs.rs/async-stream/latest/async_stream/index.html) 提供了两个常用宏：

- `stream!`：返回类型为 `impl Stream<Item = T>`
- `try_stream!`：返回类型为 `impl Stream<Item = Result<T, E>>`

将底层的 `async` 状态机做了封装，可以配合 `loop` / `yield` 关键字，进行持续、复杂的数据产出。

```rust
use async_stream::stream;
use futures_core::stream::Stream;
use futures_util::pin_mut;
use futures_util::stream::StreamExt;

fn zero_to_three() -> impl Stream<Item = u32> {
    stream! {
        for i in 0..3 {
            yield i;
        }
    }
}

#[tokio::main]
async fn main() {
    let s = zero_to_three();
    pin_mut!(s); // needed for iteration

    while let Some(value) = s.next().await {
        println!("got {}", value);
    }
}
```

> [!note] `pin_mut!` 的作用
> 借用 `Stream` 的同时保持其 `Unpin` 视图，从而可以在 `while let` 中反复调用 `s.next().await`。`Stream` 内部通常包含自引用结构，必须钉住之后才能安全地轮询。

## 相关链接

- [[Tokio Mini-Redis 源码阅读]]
- [[Tokio mini-redis SUB 实现]] - 实际使用 `async_stream` 与 `StreamMap` 聚合订阅的工程案例
- [[Rust]]
