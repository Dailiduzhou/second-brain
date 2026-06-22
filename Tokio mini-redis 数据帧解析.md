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

这个`Frame`是对 `Redis Serialization Protocol(RESP)`的简单模拟。

**!!注意**，`mini-redis`至今还未对`RESP 2`标准中的 **空`Array`** 提供支持。

## RESP 中数据结构的定义

`RESP`的定义中：
- `+` Simple String -> `+OK\r\n`
-  `-` Simple Error -> `-ERR message\r\n`
-  `:` Integer -> `:1000\r\n`
-  `$` Bulk String(format: `$<length>\r\n<data>\r\n`) -> `$5\r\nhello\r\n`(null: `$-1\r\n`)
-  `*` Array -> `*2\r\n$5\r\nhello\r\n$5\r\nworld\r\n` (null: `*-1\r\n`)

## 数据流向

```
BufWriter<TcpStream> -> BytesMut -> std::io::Cursor<&u8>
```

其中`Cursor`提供了很多方便的方法来处理数组。比如：
-  `position` 获得游标位置
-  `advance` 推进游标位置
-  `remaining` 获取剩余元素个数
- `chunk` 获取底层数组

辅助处理数组的函数编写。

## 数据校验

`String::from_utf8` 会先校验数据是否符合`UTF-8`编码，再转为`String`。

## 数据读取

### 读取行(`get_line`)
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

每行以`\r\n`结尾。每次获取这一行的数组切片后，再将游标设置在`\r\n`之后。

由于要获取`Cursor`底层数组的切片，为防止悬垂引用，需要加上生命周期参数(`'a`)，来防止被`Rust clippy`肘飞（。
## 读取数字(`get_decimal`)
```rust
/// Read a new-line terminated decimal
fn get_decimal(src: &mut Cursor<&[u8]>) -> Result<u64, Error> {
    use atoi::atoi;

    let line = get_line(src)?;

    atoi::<u64>(line).ok_or_else(|| "protocol error; invalid frame format".into())
}
```
