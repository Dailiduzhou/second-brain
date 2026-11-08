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
  - programming-language/rust/tcp
---

# Tokio mini-redis TCP连接

> [!note]
> 本文基于个人分支 [`feat/ArrayFullSupport`](https://github.com/Dailiduzhou/mini-redis/tree/feat/ArrayFullSupport)，重点说明 `src/connection.rs` 如何在 TCP 字节流上完成成帧、缓存和异常处理。数组写入与 `NullArray` 的扩展实现已拆分到 [[Tokio mini-redis Array写入与NullArray支持]]。

## 连接层职责

`Connection` 的职责并不是直接处理 Redis 命令，而是在 `TcpStream` 之上提供一个稳定的 `Frame` 读写边界。它主要完成三件事：

- 在读取方向维护内部缓冲区，持续累积字节，直到能够解析出一个完整的 RESP `Frame`。
- 在写入方向将 `Frame` 编码后写入 `BufWriter<TcpStream>`，减少细粒度系统调用。
- 在连接关闭或协议损坏时提供明确的错误语义。

## 关键数据结构

连接层同时使用了 `BytesMut` 和 `Cursor<&[u8]>`：

- `BytesMut` 负责保存尚未消费的网络字节，适合反复追加与推进读取游标。
- `Cursor<&[u8]>` 负责在不复制数据的前提下执行协议检查与解析。

这一组合的核心价值在于：读取缓存与协议解析彼此解耦，但又共享同一段底层字节数据。

## 读取路径

`read_frame` 的核心流程可以压缩为以下逻辑：

```rust
pub async fn read_frame(&mut self) -> crate::Result<Option<Frame>> {
    loop {
        if let Some(frame) = self.parse_frame()? {
            return Ok(Some(frame));
        }

        if 0 == self.stream.read_buf(&mut self.buffer).await? {
            if self.buffer.is_empty() {
                return Ok(None);
            } else {
                return Err("connection reset by peer".into());
            }
        }
    }
}
```

这个循环体现了连接层的基本策略：

1. 先尝试从已有缓冲区直接解析，避免不必要的网络读取。
2. 只有在当前字节不足以组成完整 `Frame` 时，才继续从 socket 拉取数据。
3. 若对端关闭连接，则根据缓冲区是否还有残留数据区分“正常结束”和“异常中断”。

## `parse_frame` 如何完成成帧

读取端的关键不在于“读到了多少字节”，而在于“这些字节是否足以形成一个完整的协议单元”。`parse_frame` 先调用 `Frame::check` 验证边界，再调用 `Frame::parse` 生成结构化结果：

```rust
let mut buf = Cursor::new(&self.buffer[..]);

match Frame::check(&mut buf) {
    Ok(_) => {
        let len = buf.position() as usize;
        buf.set_position(0);
        let frame = Frame::parse(&mut buf)?;
        self.buffer.advance(len);
        Ok(Some(frame))
    }
    Err(Incomplete) => Ok(None),
    Err(e) => Err(e.into()),
}
```

这里有两个关键点：

- `Frame::check` 只负责判断“是否完整”，因此能在真正分配 `Frame` 前尽早失败。
- `self.buffer.advance(len)` 只移除已经消费的部分，剩余字节会留给下一次调用继续解析。

## 半包与粘包为什么都能处理

TCP 只保证字节流顺序，不保证应用层消息边界。因此连接层必须自行完成成帧。

### 半包

如果一次只读到半条命令，`Frame::check` 会返回 `Incomplete`，`read_frame` 不会把它当成错误，而是继续 `read_buf`，直到缓冲区里的字节终于凑够一个完整 `Frame`。

这里最容易让人产生误解的点是：`read_frame` 虽然看起来像“一个函数调一次就结束”，但它实际上背后背着一个一直活着的 `Connection` 对象。半包没有被处理掉之前，那个半截数据并不会因为 `.await` 就消失。

可以把过程想得更口语一点：

1. 对端发来一个完整命令，但这次网卡只先吐出来前半截。
2. `read_buf` 先把这前半截塞进 `self.buffer`。
3. `parse_frame` 一看，发现字节还不够，没法拼出一个完整 RESP 帧，于是返回 `Ok(None)`，意思不是“炸了”，而是“先别急，还差点料”。
4. 任务在 `.await` 处挂起，把 CPU 让出去；但 `Connection` 和里面的 `self.buffer` 还在，半个包就这么老老实实地躺着。
5. 后半截数据到了以后，Tokio 再把这个任务叫醒，新字节继续往同一个 `buffer` 的尾巴上追加。
6. 下一轮循环里，`parse_frame` 再检查一次，这回材料齐了，才真正组出一个 `Frame` 返回给上层。

所以，半包处理能成立，核心不是 Tokio 会“自动帮你补包”，而是这段实现自己做了两件事：

- 用 `BytesMut` 把前一次没读完的数据留住。
- 用 `loop + parse_frame + read_buf` 反复尝试，直到协议边界完整出现。

再往下看一层，底层缓冲区本身也很关键。

### 二、 底层是如何在 buffer 后面追加数据的？（BytesMut 的底层黑魔法）

在代码中，`self.buffer` 的类型是 `bytes::BytesMut`。它不是标准的 `Vec<u8>`，而是 Rust 异步网络编程中专门为了高性能 I/O 设计的**双端队列式字节缓冲区**。

我们可以把 `BytesMut` 的底层内存结构看作一段连续的连续空间，它内部通过三个关键指标来维护：

1. **Reader Index（读指针/起点）：** 当前有效数据的开始位置。
2. **Writer Index（写指针/长度）：** 当前有效数据的结束位置（也是新数据追加的起点）。
3. **Capacity（容量）：** 这块内存的总大小。

#### 1. 追加数据的底层逻辑（`read_buf` 的零拷贝设计）

当你调用 `stream.read_buf(&mut self.buffer).await?` 时，底层的运转流程如下：

- **识别空闲空间（Spare Capacity）：**`BytesMut` 实现了 Tokio 的 `BufMut` 特性（Trait）。这意味着它能向 Tokio 暴露自己**从写指针到容量终点之间那段“尚未使用的空白内存”**。
- **直接传入系统调用：** Tokio 在调用操作系统的 `recv` 或 `read` 系统调用时，会直接将这块**空白内存的起始地址指针**传给操作系统内核。
- **内核直接写入：** 操作系统内核直接把网卡接收缓冲区里的字节，拷贝到这块空白内存中。**整个过程没有产生任何中间临时变量或二次内存拷贝。**
- **推进写指针：** 操作系统返回实际写入了 `n` 个字节。Tokio 收到返回值后，会自动调用 `BytesMut` 的内部方法，将有效数据的长度（Length/Writer Index）向前推进 `n` 个字节。

#### 2. 消费数据与粘包处理

这里的核心点不是“删掉前面的字节”，而是**推进已消费边界**。

- 在这份 `mini-redis` 实现里，`parse_frame` 成功后调用的是 `self.buffer.advance(len)`。
- 这个操作同样**不会**触发整段内存向前搬移；它只是把逻辑上的读取起点往后推。
- 因此，即使前半段数据已经被消费，后面那段还没处理的“粘包”内容也依然可以留在原地，等待下一次循环继续解析。

- 如果换成 `split_to` 这一类接口，思路其实也是一样的：避免把整块剩余数据为了“删除前缀”而整体拷贝。

这就解释了为什么它处理半包时既自然又高效：前半包先攒着，后半包来了继续接上；真正凑齐之后，再把已经消费掉的那一段从逻辑上划过去，剩下的字节继续留给下一轮。

### 粘包

如果一次读到多条命令，`parse_frame` 只消费当前第一条命令对应的字节。其余数据仍保留在 `self.buffer` 中，下次调用 `read_frame` 时会优先继续解析，而不是再次访问网络。

这也是 `Connection` 能稳定处理 RESP over TCP 的根本原因：它面向的是“字节缓冲区 + 协议边界”，而不是单次 `read` 调用的返回值。

## 连接关闭的语义

`read_buf` 返回 `0` 表示对端已经关闭写端。此时需要结合缓冲区状态判断连接结束是否完整：

- `self.buffer.is_empty()` 为真：说明此前的所有帧都已经完整消费，返回 `Ok(None)` 表示正常 EOF。
- `self.buffer.is_empty()` 为假：说明对端在发送半帧时中断，返回错误以避免上层误把残缺数据当成合法消息。

这种区分能让上层逻辑明确识别“对端正常退出”和“协议流中途损坏”。

## 写入路径的定位

本文聚焦连接层的读路径与成帧策略。写路径仍由 `Connection::write_frame` 统一负责：

- 使用 `BufWriter<TcpStream>` 聚合写操作。
- 将 `Frame` 编码为 RESP 字节序列后再统一 `flush`。

其中数组写入、显式栈迭代和 `NullArray` 的序列化设计，已经拆分到 [[Tokio mini-redis Array写入与NullArray支持]]。

## 小结

`mini-redis` 的连接层实现展示了一种很典型的网络编程分层方式：

- I/O 层只负责从 TCP 中积累和输出字节。
- 协议层负责识别 RESP 的边界并构造 `Frame`。
- 缓冲区负责承接半包、粘包以及跨次调用的残留数据。

如果只看接口，`read_frame` 返回的是一个 `Frame`；但从实现上看，它真正解决的是“如何把无边界字节流稳定地还原成有边界的应用层消息”。
