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
  - programming-language/rust/mini-redis
  - programming-language/rust/resp
---

# Tokio mini-redis Array写入与NullArray支持

> [!note]
> 本文基于个人分支 [`feat/ArrayFullSupport`](https://github.com/Dailiduzhou/mini-redis/tree/feat/ArrayFullSupport)，说明两个扩展点：`Frame::Array` 的写入实现，以及 `Frame::NullArray` 的协议建模。

## 扩展目标

相较于上游 `mini-redis`，这一分支主要补足了两类能力：

- 支持 `Frame::Array` 的完整 TCP 写出。
- 支持 `RESP 2` 中 `*-1\r\n` 所表示的 `Null Array`。

这两项能力都属于协议层扩展，但会直接影响连接层的写入逻辑和解析逻辑。

## `Frame::Array` 的写入策略

数组在 RESP 中的格式为：

```text
*<len>\r\n
<element-1>
<element-2>
...
```

这一实现没有采用异步递归，而是使用显式栈展开嵌套结构：

```rust
let mut stack = vec![frame];

while let Some(frame) = stack.pop() {
    match frame {
        Frame::Array(values) => {
            stream.write_u8(b'*').await?;
            Self::write_decimal_to(stream, values.len() as u64).await?;

            for value in values.iter().rev() {
                stack.push(value);
            }
        }
        // ...
    }
}
```

这里逆序压栈的原因很直接：栈是后进先出，只有先压入尾部元素，弹出时才能保持 RESP 所需的原始写出顺序。

## 为什么不用异步递归

显式栈相较于异步递归有两个直接优势：

- 避免 `async fn` 递归带来的 `Box::pin` 或额外装箱成本。
- 避免深层嵌套数组触发调用栈溢出。

因此，这种写法并不只是风格选择，而是更适合高频 I/O 路径的工程实现。

## 为什么单独引入 `Frame::NullArray`

RESP 中至少存在三种容易混淆但语义不同的“空值”：

- `*0\r\n`：空数组。
- `$-1\r\n`：空 Bulk String，对应 `Frame::Null`。
- `*-1\r\n`：空数组结果，对应 `Frame::NullArray`。

如果将 `Null Array` 折叠进 `Frame::Array(Vec<Frame>)` 或 `Option<Vec<Frame>>`，会让协议语义与分支处理都变得模糊。单独建模为枚举变体后，解析和序列化都更直接。

## 解析阶段的表现

在 `frame.rs` 中，数组长度的解析已经显式区分了 `-1`：

```rust
b'*' => match get_length(src)? {
    None => Ok(Frame::NullArray),
    Some(len) => {
        let len = len.try_into()?;
        let mut out = Vec::with_capacity(len);
        // ...
    }
}
```

这样做有两个好处：

- 协议语义保持准确，`Null Array` 不会被误当成空数组。
- 可以避免把 `-1` 错误转换成无符号长度后引发异常容量分配。

## 写入阶段的表现

由于 `NullArray` 被建模为叶子节点，写入端只需要一个分支即可完成序列化：

```rust
Frame::NullArray => {
    stream.write_all(b"*-1\r\n").await?;
}
```

它不需要压栈子元素，也不会引入额外分配。这让显式栈的写入流程在处理普通数组与 `NullArray` 时保持一致的结构。

## 与其他笔记的关系

- `[[Tokio mini-redis 数据帧解析]]` 关注 RESP 基本数据结构与解析辅助函数。
- `[[Tokio mini-redis TCP连接]]` 关注连接层的缓冲区、成帧与读写边界。

本文补充的是“协议扩展如何落到具体实现”这一层。

## 小结

这组改动的核心不在于多加了一个枚举分支，而在于把 RESP 的协议语义完整带回代码模型：

- `Frame::Array` 的写入使用显式栈，兼顾性能与健壮性。
- `Frame::NullArray` 单独建模，保证解析与序列化的对称性。

从结果上看，这使得分支实现比上游更接近完整的 `RESP 2` 行为。
