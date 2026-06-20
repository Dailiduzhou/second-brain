---
category: ccnubox
type: reference
topic: invalid-apis
module: bff
status: seedling
tags:
  - ccnubox
  - ccnubox/bff
---

# BFF 中表示不可用的接口列表

以下路由在 Swagger 注解中注册但标记为不可用（`/library/search_user`、`/library/reserve_discussion`、`/library/create_comment`）。

```go
// @Router /library/search_user [get]
// @Router /library/reserve_discussion [post]
// @Router /library/create_comment [post]
```

## 跨主题链接

- [[华师匣子BFF结构]] — BFF 整体架构与路由组织
- [[华师匣子]] — 项目总览