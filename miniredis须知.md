---
category: database
type: cache
topic: miniredis
status: seedling
---
## Lua脚本支持
对redis 7.0及以上复杂的lua支持不完全。
底层使用`gopher-lua`作为lua解释器。
## 类型转换
类型转换和精度上表现得和原版redis不完全相同。
## 快进时间测试
```go
	mr, err := miniredis.Run()
	defer mr.Close()

	// 2. 将你的真实业务客户端指向 miniredis 的地址
    client := redis.NewClient(&redis.Options{
        Addr: mr.Addr(),
    })
    defer client.Close()
    
    // ...
    
    // --- 高级技巧：测试过期逻辑 --- 
    // miniredis 允许你“快进”时间！非常适合测试缓存过期逻辑 
    mr.FastForward(2 * time.Minute)
    
```
### 测试并发冲突的优势
模拟乐观锁`Watch`的冲突场景。
```go
func TestRedisTransaction_Watch_Conflict(t *testing.T) {
    mr, _ := miniredis.Run()
    defer mr.Close()

    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    ctx := context.Background()

    // 1. 初始化数据
    mr.Set("inventory", "10") // 使用 miniredis 的底层 API 直接设值

    // 2. 业务代码：使用 WATCH 实现扣减库存
    err := client.Watch(ctx, func(tx *redis.Tx) error {
        // 获取当前库存
        n, err := tx.Get(ctx, "inventory").Int()
        require.NoError(t, err)

        // 😈 核心技巧：在这个微小的空隙里，我们假装有另一个并发请求改了数据！
        // 直接调用 miniredis 的底层方法绕过 client，强行制造并发冲突！
        mr.Set("inventory", "9") 

        // 开启事务 (MULTI)
        _, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
            pipe.Set(ctx, "inventory", n-1, 0)
            return nil
        })
        return err // 如果发生冲突，这里会返回 redis.TxFailedErr
    }, "inventory")

    // 3. 断言：验证我们的业务代码是否正确抛出了事务失败的错误
    assert.ErrorIs(t, err, redis.TxFailedErr)
    
    // 验证库存其实是被那个“并发请求”改成了 9，而不是我们期望的 10-1=9（因为事务被拦截了）
    assert.Equal(t, "9", mr.Get("inventory")) 
}
```