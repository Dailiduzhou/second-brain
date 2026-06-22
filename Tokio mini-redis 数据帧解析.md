---
category: programming-language
type: deep-dive
topic: mini-redis
frameworks:
  - tokio
status: seedling
tags:
  - programming-language/rust/tokio
  - programming-language/rust/mini-redis
---

# Tokio mini-redis 数据帧解析

## 数据结构定义

```rust
/// A frame in the Redis protocol.
#[derive(Clone, Debug)]
pub enum Frame {
    Simple(String),
    Error(String),
    Integer(u64),
    Bulk(Bytes),   // Bulk String
    Null,
    Array(Vec<Frame>),
}
```

`Frame` 是对 `Redis Serialization Protocol (RESP)` 的简化建模，用于承接上层命令与底层字节流之间的数据表达。

> [!note]
> 上游 `mini-redis` 实现的是 RESP 子集，并未覆盖 `RESP 2` 中的 `Null Array (*-1\r\n)`。相关扩展可参考 [[Tokio mini-redis Array写入与NullArray支持]]。

## RESP 中数据结构的定义

`RESP` 的常见帧类型如下：

- `+` Simple String -> `+OK\r\n`
- `-` Simple Error -> `-ERR message\r\n`
- `:` Integer -> `:1000\r\n`
- `$` Bulk String，格式为 `$<length>\r\n<data>\r\n`，例如 `$5\r\nhello\r\n`，空值为 `$-1\r\n`
- `*` Array，例如 `*2\r\n$5\r\nhello\r\n$5\r\nworld\r\n`，空数组结果为 `*-1\r\n`

## 数据流向

```
BufWriter<TcpStream> -> BytesMut -> std::io::Cursor<&u8>
```

其中 `Cursor` 提供了若干适合协议解析的能力：

- `position` 获取当前游标位置
- `advance` 推进游标
- `remaining` 获取剩余字节数
- `chunk` 获取底层数组

因此，解析函数可以直接围绕字节切片和游标状态来编写，而无需额外复制缓冲区。

## 数据校验

`String::from_utf8` 会先校验字节序列是否符合 `UTF-8` 编码，再转换为 `String`。

## 数据读取

### 读取行（`get_line`）
```rust
/// Find a line
fn get_line<'a>(src: &mut Cursor<&'a [u8]>) -> Result<&'a [u8], Error> {
    // Scan the bytes directly
    let start = src.position() as usize;
    // Scan to the second to last byte
    let end = src.get_ref().len() - 1;

    for i in start..end {
        if src.get_ref()[i] == b'\r' && src.get_ref()[i + 1] == b'\n' {
            // We found a line, update the position to be *after* the \n
            src.set_position((i + 2) as u64);

            // Return the line
            return Ok(&src.get_ref()[start..i]);
        }
    }

    Err(Error::Incomplete)
}
```

每行都以 `\r\n` 结尾。函数返回当前行对应的切片，并把游标推进到下一段待解析数据的起点。

由于返回值直接借用了 `Cursor` 底层切片，因此这里需要显式标注生命周期参数 `'a`，以保证返回切片不会脱离原始缓冲区而悬垂。

### 读取数字（`get_decimal`）
```rust
/// Read a new-line terminated decimal
fn get_decimal(src: &mut Cursor<&[u8]>) -> Result<u64, Error> {
    use atoi::atoi;

    let line = get_line(src)?;

    atoi::<u64>(line).ok_or_else(|| "protocol error; invalid frame format".into())
}
```

这个函数的职责很单一：在已经按行切分的前提下，把 RESP 中的十进制长度或整数值转换为 `u64`。如果转换失败，则说明当前帧在协议层面已经非法。

## 与连接层的关系

本文关注的是 `frame.rs` 中的协议解析辅助逻辑，即“如何从一段字节中识别出 RESP 结构”。至于这些字节如何从 `TcpStream` 累积到缓冲区、如何处理半包和粘包，则放在 [[Tokio mini-redis TCP连接]] 中说明。
