---
category: programming-language
type: deep-dive
topic: mini-redis
frameworks:
  - tokio
status: seedling
tags:
  - programming-language/rust
  - programming-language/rust/mini-redis
  - programming-language/rust/tokio
  - database/redis
---
## 存储结构实现

从左到右，由大到小。
```
DbDropGuard     ->    Db     ->    Shared    ->      State   ->     Entry
```

**`DbDropGuard`** 仿照 `MutexGuard` 保证了释放的安全性。
```rust
#[derive(Debug, Clone)]
pub(crate) struct Db {
    /// Handle to shared state. The background task will also have an
    /// `Arc<Shared>`.
    shared: Arc<Shared>,
}
// ...
// 实现Drop Trait 通过shutdown_purge_task实现安全退出
impl Drop for DbDropGuard {
    fn drop(&mut self) {
        // Signal the 'Db' instance to shut down the task that purges expired keys
        self.db.shutdown_purge_task();
    }
}
```

**`Db`** 提供了一个`thin wrapper`保证了获取共享状态的指针的**线程安全**。
```rust
#[derive(Debug, Clone)]
pub(crate) struct Db {
    /// Handle to shared state. The background task will also have an
    /// `Arc<Shared>`.
    shared: Arc<Shared>,
}
```

`Shared`表示一个带互斥锁的状态，并且包装了一个唤醒后台任务的句柄`Notify`。
```rust
#[derive(Debug)]
struct Shared {
    /// The shared state is guarded by a mutex. This is a `std::sync::Mutex` and
    /// not a Tokio mutex. This is because there are no asynchronous operations
    /// being performed while holding the mutex. Additionally, the critical
    /// sections are very small.
    ///
    /// A Tokio mutex is mostly intended to be used when locks need to be held
    /// across `.await` yield points. All other cases are **usually** best
    /// served by a std mutex. If the critical section does not include any
    /// async operations but is long (CPU intensive or performing blocking
    /// operations), then the entire operation, including waiting for the mutex,
    /// is considered a "blocking" operation and `tokio::task::spawn_blocking`
    /// should be used.
    state: Mutex<State>,

    /// Notifies the background task handling entry expiration. The background
    /// task waits on this to be notified, then checks for expired values or the
    /// shutdown signal.
    background_task: Notify,
}
```
由于`critical seciton`很窄，并且能靠`drop`来提前释放。
并且，`critical seciton`内部没有`await`需要`yield`，所以不需要线程安全的`tokio::sync::Mutex`。

**!!注意**：如果`critical seciton`包含**阻塞操作**或**重CPU操作**，就需要考虑重构，不要在阻塞情况持有锁。

`State`用`HashMap`来实现`Key-Value`的存储结构。

`pub_sub`存储了`broadcast::Sender<...>`，能实现一对多的广播。
`expiraions`使用`BTreeSet`存储`(<过期时间>, <键名>)`，有以下优点：
1. 保证**相同过期时间**的键值对不冲突。
2. 保证某个键的过期时间能**及时更新**。
3. 保证过期时间的升序有序性，方便过期时间清理[[Tokio mini-redis DB实现#过期时间清理]]。
```rust
#[derive(Debug)]
struct State {
    /// The key-value data. We are not trying to do anything fancy so a
    /// `std::collections::HashMap` works fine.
    entries: HashMap<String, Entry>,

    /// The pub/sub key-space. Redis uses a **separate** key space for key-value
    /// and pub/sub. `mini-redis` handles this by using a separate `HashMap`.
    pub_sub: HashMap<String, broadcast::Sender<Bytes>>,

    /// Tracks key TTLs.
    ///
    /// A `BTreeSet` is used to maintain expirations sorted by when they expire.
    /// This allows the background task to iterate this map to find the value
    /// expiring next.
    ///
    /// While highly unlikely, it is possible for more than one expiration to be
    /// created for the same instant. Because of this, the `Instant` is
    /// insufficient for the key. A unique key (`String`) is used to
    /// break these ties.
    expirations: BTreeSet<(Instant, String)>,

    /// True when the Db instance is shutting down. This happens when all `Db`
    /// values drop. Setting this to `true` signals to the background task to
    /// exit.
    shutdown: bool,
}
```

`Entry` 可能有或没有过期时间，于是`expiration`很自然地设置为`Option`。
```rust
/// Entry in the key-value store
#[derive(Debug)]
struct Entry {
    /// Stored data
    data: Bytes,

    /// Instant at which the entry expires and should be removed from the
    /// database.
    expires_at: Option<Instant>,
}
```

## 过期时间清理

```rust
impl Db {
    /// Create a new, empty, `Db` instance. Allocates shared state and spawns a
    /// background task to manage key expiration.
    pub(crate) fn new() -> Db {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                entries: HashMap::new(),
                pub_sub: HashMap::new(),
                expirations: BTreeSet::new(),
                shutdown: false,
            }),
            background_task: Notify::new(),
        });

        // Start the background task.
        tokio::spawn(purge_expired_tasks(shared.clone()));

        Db { shared }
    }

	// ...
}
```

在获取`Db`实例的时候，开启了后台清理过期键值对的任务。

 ```rust
 /// Routine executed by the background task.
///
/// Wait to be notified. On notification, purge any expired keys from the shared
/// state handle. If `shutdown` is set, terminate the task.
async fn purge_expired_tasks(shared: Arc<Shared>) {
    // If the shutdown flag is set, then the task should exit.
    while !shared.is_shutdown() {
        // Purge all keys that are expired. The function returns the instant at
        // which the **next** key will expire. The worker should wait until the
        // instant has passed then purge again.
        if let Some(when) = shared.purge_expired_keys() {

            // 并非忙等待，在下一个即将过期的键值对真正过期之前，
            // 都在`sleep`。
            // **除非**恰好插入或更新了一个过期事件更靠前的键值对。
            tokio::select! {
                _ = time::sleep_until(when) => {}
                _ = shared.background_task.notified() => {}
            }
        } else {
            // There are no keys expiring in the future. Wait until the task is
            // notified.
            shared.background_task.notified().await;
        }
    }

    debug!("Purge background task shut down")
}

impl Shared {
    /// Purge all expired keys and return the `Instant` at which the **next**
    /// key will expire. The background task will sleep until this instant.
    /// 将已经过期的键值对全部清除，并返回下一个即将过期的键值对
    fn purge_expired_keys(&self) -> Option<Instant> {
        let mut state = self.state.lock().unwrap();

        if state.shutdown {
            // The database is shutting down. All handles to the shared state
            // have dropped. The background task should exit.
            return None;
        }

        // This is needed to make the borrow checker happy. In short, `lock()`
        // returns a `MutexGuard` and not a `&mut State`. The borrow checker is
        // not able to see "through" the mutex guard and determine that it is
        // safe to access both `state.expirations` and `state.entries` mutably,
        // so we get a "real" mutable reference to `State` outside of the loop.
        let state = &mut *state;

        // Find all keys scheduled to expire **before** now.
        let now = Instant::now();
		
		// 得益于 `BTreeSet` 的有序性，能将复杂度从整体遍历的 `O(n)` 降到 `O(K)`
		// K 为目前过期的键个数。
		// 这里使用 `ref` 是一种语法糖，避免获取所有权。
        while let Some(&(when, ref key)) = state.expirations.iter().next() {
            if when > now {
                // Done purging, `when` is the instant at which the next key
                // expires. The worker task will wait until this instant.
                return Some(when);
            }

            // The key expired, remove it
            state.entries.remove(key);
            state.expirations.remove(&(when, key.clone()));
        }

        None
    }

    /// Returns `true` if the database is shutting down
    ///
    /// The `shutdown` flag is set when all `Db` values have dropped, indicating
    /// that the shared state can no longer be accessed.
    fn is_shutdown(&self) -> bool {
        self.state.lock().unwrap().shutdown
    }
}
 ```