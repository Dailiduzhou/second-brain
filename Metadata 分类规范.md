---
category: knowledge-management
type: standard
topic: metadata
status: seedling
tags:
  - knowledge-management/metadata
  - obsidian/properties
---

# Metadata 分类规范

## 字段规范

- `category`：主分类，单值，用小写 kebab-case。
- `type`：笔记类型，单值，用小写 kebab-case。
- `topic`：具体主题，单值，用小写 kebab-case。
- `topics`：多个主题，列表格式。
- `frameworks`：相关框架，列表格式。
- `module`：业务模块，单值，用小写 kebab-case。
- `architecture_types`：架构子类型，列表格式。
- `status`：笔记状态，当前常用 `seedling`、`done`。
- `tags`：Obsidian 标签，统一使用列表格式，可用 `/` 表达层级。

## 主分类

- `microservice`：微服务、框架、分布式事务、可观测性、性能等。
- `database`：数据库、缓存、SQL 工具等。
- `message-queue`：消息队列与异步任务系统。
- `ecommerce`：电商系统与业务模块。
- `testing`：测试工具与测试实践。
- `programming-language`：编程语言。
- `productivity`：任务清单与个人效率。
- `index`：入口页、导航页。
- `knowledge-management`：知识库维护规范。

## 示例

```yaml
---
category: microservice
type: architecture
topic: layout
frameworks:
  - go-kratos
status: seedling
tags:
  - microservice/go-kratos
  - architecture/layout
---
```

## 维护原则

- 字段名保持稳定，避免 `framework` / `frameworks` 这类单双数混用。
- 多值字段统一写成 YAML 列表，避免字符串和列表混用。
- `category` 用于大类筛选，`tags` 用于跨主题检索。
- 标签层级优先表达检索路径，例如 `microservice/dtm`、`database/redis`。
