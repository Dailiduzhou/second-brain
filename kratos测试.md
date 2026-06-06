---
category: microservice
frameworks:
  - go-kratos
topic: testing
status: seedling
tags:
  - microservice/go-kratos
  - testing
---
## 使用SQLC
参考[[SQLC使用]].
1. 配置`sqlc.yaml` ，让sqlc生成接口文件。
```yaml
version: "2"
sql:
  - schema: "schema.sql"
    queries: "query.sql"
    engine: "mysql"
    gen:
      go:
        package: "db"
        out: "db"
        emit_interface: true # 关键：让 sqlc 生成 Querier 接口
```
执行 `sqlc generate` 后，`db` 目录下会多出一个 `Querier` 接口。这个接口包含了所有的 SQL 方法。
2. 使用`mockgen`
```bash
# 假设你的 sqlc 生成代码在 data/db 目录下
mockgen -source=data/db/querier.go -destination=data/db/mock/querier_mock.go -package=mockdb
```
3. 模拟redis
社区常见的mock `redis`的方法是引入[miniredis](github.com/alicebob/miniredis) 。
**[[miniredis须知]]** 
代码样例
```go
package data

import (
    "context"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestRedisCache_SetAndGet(t *testing.T) {
    // 1. 在内存中启动一个 miniredis 服务器
    mr, err := miniredis.Run()
    require.NoError(t, err)
    defer mr.Close() // 测试结束自动关闭

    // 2. 将你的真实业务客户端指向 miniredis 的地址
    client := redis.NewClient(&redis.Options{
        Addr: mr.Addr(),
    })
    defer client.Close()

    ctx := context.Background()

    // 3. 执行你的业务代码 (写)
    err = client.Set(ctx, "user:1", "kratos", time.Minute).Err()
    require.NoError(t, err)

    // 4. 执行你的业务代码 (读)
    val, err := client.Get(ctx, "user:1").Result()
    require.NoError(t, err)
    assert.Equal(t, "kratos", val)

    // --- 高级技巧：测试过期逻辑 ---
    
    // miniredis 允许你“快进”时间！非常适合测试缓存过期逻辑
    mr.FastForward(2 * time.Minute)
    
    // 时间快进后，我们再次获取
    _, err = client.Get(ctx, "user:1").Result()
    assert.ErrorIs(t, err, redis.Nil) // 应该返回 key 不存在的错误
}
```
如果需要更接近真实的redis行为，可以使用[testcontainer](github.com/testcontainers/testcontainers-go) 
[[Testcontainers-go须知]]
