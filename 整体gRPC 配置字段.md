---
category: ccnubox
type: deep-dive
topic: config
frameworks:
  - go-kratos
module: common
status: seedling
aliases:
  - 整体gRPC 配置字段
  - gRPC 配置结构拆分方案
  - ccnubox grpc conf
tags:
  - ccnubox
  - ccnubox/config
  - ccnubox/common
---
# gRPC 配置结构拆分与迁移方案

> 状态：待实施 / 灰度迁移
> 范围：仅拆分 server / client 结构体，保留旧 yaml 兼容
> 目标文件：`common/bizpkg/conf/type.go`

## 背景

当前 `common/bizpkg/conf/type.go` 中的 `GrpcConf` 同时承载 gRPC server 与 client 配置，并通过 `GrpcConfs map[string]*GrpcConf` 在单份 infra 配置中枚举全部服务。

这类设计的初衷是统一服务名，避免 server / client 配置命名不一致；但在实际使用中，server 侧、client 侧和通用服务元信息被混合在同一结构体内，导致职责边界不清晰。

## 主要问题

1. server / client 字段混用。`Addr`、`EtcdTTL`、`ServerTimeout` 只对 server 有意义；`ClientTimeout` 只对 client 有意义。
2. 服务名、map key、addr 重复维护。任一字段变更都可能引入不一致。
3. 超时单位依赖调用方。yaml 中使用裸整数，但具体换算逻辑分散在 server / client 初始化代码中。
4. client 侧缺少可配置项。当前实现固定关闭 health check，retry、keepalive 等参数无法外部化。
5. server 侧缺少可观测与连接控制配置。`ServerTimeout` 目前承担了过多职责。
6. WRR 权重在配置层静态化，运行时依赖 etcd metadata，配置表达力不足。
7. 多份 YAML 需要同步维护完整服务清单，新增服务或字段时容易产生重复修改。
8. gRPC client 初始化存在大量样板代码，主要是字符串和类型复制。
9. 缺失配置时直接 `log.Fatalf`，不利于测试和灰度场景处理。
10. `grpc_server.go` 与 `kratos_server.go` 两套实现并存，增加维护成本。

## 目标

- 将 `GrpcConf` 拆分为 `GrpcService`、`GrpcServerConf`、`GrpcClientConf`。
- 保留现有 yaml 字段名，降低迁移成本。
- 旧 yaml 仍可加载，并在启动时输出迁移告警。
- 不引入新的运行行为变更。

## 非目标

- 不将超时字段改为 `time.Duration`。
- 不新增 KeepAlive、Retry、TLS 等生产配置项。
- 不合并现有 `InitXxx` 样板函数。
- 不移除 `common/pkg/grpcx/grpc_server.go`。

## 结构设计

```go
// gRPC 服务最小信息，用于服务发现或直连
type GrpcService struct {
    Name string `yaml:"name"`
    Addr string `yaml:"addr"`
}

// 同一份 infra 配置下可见的所有 gRPC 服务
type GrpcConfs map[string]*GrpcService

// 本进程作为 gRPC server 时使用的配置
type GrpcServerConf struct {
    Name          string `yaml:"name"`
    Addr          string `yaml:"addr"`
    Weight        int    `yaml:"weight"`
    EtcdTTL       int    `yaml:"etcdTTL"`
    ServerTimeout int    `yaml:"serverTimeout"`
}

// gRPC client 默认配置
type GrpcClientConf struct {
    ClientTimeout int `yaml:"clientTimeout"`
}

type InfraConf struct {
    Env     *Env            `yaml:"env"`
    Etcd    *EtcdConf       `yaml:"etcd"`
    Redis   *RedisConf      `yaml:"redis"`
    Mysql   *MysqlConf      `yaml:"mysql"`
    Kafka   *KafkaConf      `yaml:"kafka"`
    Grpc    *GrpcConfs      `yaml:"grpc"`
    GrpcCli *GrpcClientConf `yaml:"grpcClient"`
    Otel    *OtelConf       `yaml:"otel"`
    Proxy   *ProxyConf      `yaml:"proxy"`
}

type BaseServerConf struct {
    Log  *LogConf        `yaml:"log"`
    Grpc *GrpcServerConf `yaml:"grpc"`
}
```

### 设计要点

- `GrpcConfs` 保持在 `InfraConf` 中，但 value 缩减为 `name + addr`。
- 服务自身的完整 server 配置进入 `BaseServerConf.Grpc`。
- 客户端默认超时从 `InfraConf.GrpcCli` 读取，与具体被调服务解耦。

## 兼容策略

采用“双结构体解码 + 迁移函数”方案。

1. 先按新结构反序列化到 `InfraConf`。
2. 若新结构未命中，再按 legacy 结构反序列化。
3. 将 legacy 的 `Grpc` 数据迁移到新结构：
   - `GrpcConfs` 仅保留 `Name` 和 `Addr`。
   - `BaseServerConf.Grpc` 提取 `Weight`、`EtcdTTL`、`ServerTimeout`。
   - `GrpcCli.ClientTimeout` 提取为全局 client 默认值。
4. 打印迁移告警，提示尽快更新 yaml。
5. 若无法识别本服务身份，则仅迁移 `GrpcConfs` 和 `GrpcCli`，`BaseServerConf.Grpc` 保持为空并输出告警。

## 代码迁移点

### `common/bizpkg/grpc/server/server.go`

- 入参从 `*conf.GrpcConf` 改为 `*conf.GrpcServerConf`。
- timeout 逻辑保持不变。

### `common/bizpkg/grpc/client/client.go`

- `GetConf` 返回 `*conf.GrpcService`。
- `NewGrpcClient` 接收 `GrpcClientConf` 中的默认超时。
- 缺省时使用兜底值，保持现有运行行为。

### `common/bizpkg/grpc/grpc.go`

- 不修改。

### 调用点

- `be-*/ioc/grpc.go`：server 侧改为读取 `ServerConf.Grpc`。
- `be-*/ioc/<peer>.go`：client 侧从 `cfg.GrpcCli` 读取默认超时。
- `be-*/wire.go` 与 `be-*/wire_gen.go`：保持注入链路一致。

## 文件清单

| 路径 | 改动 |
|---|---|
| `common/bizpkg/conf/type.go` | 拆分 gRPC 配置结构，`InfraConf` 增加 `GrpcCli`，`BaseServerConf` 增加 `Grpc` |
| `common/bizpkg/conf/conf.go` | 增加 legacy 结构与迁移逻辑，`InitInfraConfig` 走双解码路径 |
| `common/bizpkg/grpc/server/server.go` | 入参切换为 `*conf.GrpcServerConf` |
| `common/bizpkg/grpc/client/client.go` | `GetConf` 返回 `*conf.GrpcService`，支持全局 client 默认超时 |
| `be-*/ioc/grpc.go` | server 侧读取 `ServerConf.Grpc` |
| `be-*/ioc/<peer>.go` | client 侧注入 `GrpcCli` 默认超时 |
| `be-*/config/config-infra-example.yaml` | 按新结构重写 grpc 配置 |
| `deployment/kubernetes/config-map.yaml` | 同步更新部署配置 |

## YAML 示例

### 纯 client 进程

```yaml
grpcClient:
  clientTimeout: 60

grpc:
  ccnu:
    name: "ccnu"
    addr: ":20000"
  grade:
    name: "grade"
    addr: ":20007"
```

### server + client 进程

```yaml
# infra 配置
grpcClient:
  clientTimeout: 60

grpc:
  ccnu:
    name: "ccnu"
    addr: ":20000"
  user:
    name: "user"
    addr: ":20010"

# server 配置
serverGrpc:
  name: "grade"
  addr: ":20007"
  weight: 100
  etcdTTL: 60
  serverTimeout: 60
```

## 验证

1. `go build ./...`
2. `go vet ./...`
3. 旧 yaml 回退验证：确认迁移告警正常输出，且 `GrpcCli` 与 `ServerConf.Grpc` 字段可正确填充。
4. 新 yaml 验证：确认不再触发迁移告警。
5. 端到端验证：执行一次真实 HTTP -> gRPC 调用，确认服务发现、默认超时和 etcd 注册行为正常。
