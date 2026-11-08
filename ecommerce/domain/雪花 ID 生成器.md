---
category: ecommerce
type: implementation
topic: id-generator
frameworks:
  - go-kratos
  - bwmarrin/snowflake
module: foundation
status: done
tags:
  - ecommerce/foundation
  - id/snowflake
  - microservice/go-kratos
aliases:
  - 雪花算法实现
  - Snowflake ID Generator
---

# 雪花 ID 生成器

使用 `bwmarrin/snowflake` 作为底层库，在 `data` 层封装 `snowflakeGenerator`，由 `biz.IDGenerator` 接口消费。节点 ID 同时支持 `conf.Snowflake.NodeId` 和环境变量 `SNOWFLAKE_NODE_ID`，方便本地与测试环境无 YAML 配置时启动。

## 节点 ID 解析

`conf.Snowflake` 优先，环境变量兜底，缺失时直接报错，避免上线后节点 ID 冲突。

```go
const EnvSnowflakeNodeID = "SNOWFLAKE_NODE_ID"

func resolveSnowflakeNodeID(c *conf.Snowflake) (int64, error) {
    if c != nil && c.NodeId > 0 {
        return int64(c.NodeId), nil
    }
    raw := os.Getenv(EnvSnowflakeNodeID)
    if raw == "" {
        return 0, fmt.Errorf("snowflake node_id is required: set %s or conf.snowflake.node_id", EnvSnowflakeNodeID)
    }
    nodeID, err := strconv.ParseInt(raw, 10, 64)
    if err != nil {
        return 0, fmt.Errorf("invalid %s=%q: %w", EnvSnowflakeNodeID, raw, err)
    }
    if nodeID < 0 || nodeID > snowflakeMaxNode() {
        return 0, fmt.Errorf("snowflake node_id out of range [0,%d]: got %d", snowflakeMaxNode(), nodeID)
    }
    return nodeID, nil
}

func snowflakeMaxNode() int64 {
    return int64(1)<<snowflake.NodeBits - 1
}
```

> [!info] 范围校验
> `snowflake.NodeBits=10` 时节点 ID 上限是 1023，提前返回明确错误，避免 snowflake 包内部的 `panic`。

## 构造与基础生成

```go
type snowflakeGenerator struct {
    node *snowflake.Node
}

func NewSnowflakeIDGenerator(c *conf.Snowflake) (*snowflakeGenerator, error) {
    nodeID, err := resolveSnowflakeNodeID(c)
    if err != nil {
        return nil, err
    }
    node, err := snowflake.NewNode(nodeID)
    if err != nil {
        return nil, fmt.Errorf("create snowflake node %d: %w", nodeID, err)
    }
    return &snowflakeGenerator{node: node}, nil
}

func (g *snowflakeGenerator) GenerateString() string {
    return g.node.Generate().String()
}
```

## 32 位订单号

格式：`业务前缀(2位) + 时间戳(14位) + 雪花ID十六进制(16位) = 32位`。适用于微信支付 `out_trade_no` 32 位限制。

```go
func (g *snowflakeGenerator) GenerateOrderNo32(prefix string) string {
    if len(prefix) > 2 {
        prefix = prefix[:2]
    } else if len(prefix) < 2 {
        prefix = fmt.Sprintf("%-2s", prefix)
    }

    timestamp := time.Now().Format("20060102150405")
    snowInt64 := g.node.Generate().Int64()

    return fmt.Sprintf("%s%s%016x", prefix, timestamp, snowInt64)
}
```

> [!tip] 十六进制的意义
> `%016x` 把 64 位整数压成绝对 16 位小写十六进制字符串，比十进制更紧凑且不丢精度。

## 64 位订单号

格式：`业务前缀(4位) + 时间戳(14位) + 用户ID(8位) + 雪花ID(19位) + 随机串(19位) = 64位`。适用于支付宝 `out_trade_no` 最大 64 位限制。

```go
func (g *snowflakeGenerator) GenerateOrderNo64(prefix string, userID int64) string {
    if len(prefix) > 4 {
        prefix = prefix[:4]
    } else if len(prefix) < 4 {
        prefix = fmt.Sprintf("%-4s", prefix)
    }

    timestamp := time.Now().Format("20060102150405")
    snowInt64 := g.node.Generate().Int64()
    randomStr := generateSecureRandomString(19)

    return fmt.Sprintf("%s%s%08d%019d%s", prefix, timestamp, userID, snowInt64, randomStr)
}

func generateSecureRandomString(length int) string {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    b := make([]byte, length)
    if _, err := rand.Read(b); err != nil {
        return fmt.Sprintf("%019d", time.Now().UnixNano())[:length]
    }
    for i := 0; i < length; i++ {
        b[i] = charset[int(b[i])%len(charset)]
    }
    return string(b)
}
```

> [!warning] 退化分支
> `crypto/rand` 失败时退化到纳秒时间戳，仅用于防 `panic`，日志必须告警。

## 关键约束

- 雪花 ID 与时间戳是唯一性根，**绝对不能截断**；超出长度时只能截断“业务前缀”。
- 业务前缀要做字典限制（已在 `biz` 层校验），避免下游解析失败。
- 节点 ID 在集群部署中必须人工分配，[[支付查单与 River 兜底]] 走的是同源 ID 体系。

## 相关链接

- [[订单号唯一字段规范]]
- [[IDGenerator 抽象接口]]
- [[支付系统分层设计]]
- [[支付通道 Adapter 设计]]
