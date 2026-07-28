---
title: Git submodule 使用规范
category: knowledge-management
type: standard
topic: git-submodule
status: seedling
tags:
  - knowledge-management/repository
  - git/submodule
aliases:
  - Git 子模块规范
  - 笔记仓库 submodule 规范
---

> [!abstract] 适用范围
> 本文只规定 `source/` 下 git submodule 的读写边界、源码检索方式和版本控制要求。具体 Git 命令用法应查阅 Git 文档，不在本笔记重复维护。

## 仓库边界

本仓库把笔记和外部源码分开管理。父仓库保存笔记、`.gitmodules` 和 submodule gitlink；上游仓库保存源码历史；gitlink 负责把笔记所引用的源码固定到确切 commit。

| 对象 | 父仓库 | submodule 上游仓库 |
| --- | --- | --- |
| Markdown 笔记 | 保存 | 不保存 |
| `.gitmodules` | 保存路径和上游地址 | 不保存 |
| submodule gitlink | 保存确切 commit | 提供该 commit |
| `source/<仓库>/` 源码 | 不作为普通文件保存 | 保存源码及其历史 |

当前 submodule 配置以 `.gitmodules` 为准。本规范由 [[Index Page]] 的“仓库规范”入口索引。

> [!important] 父仓库只固定版本
> 父仓库记录的是 submodule commit，不拥有 `source/` 中的源码文件。笔记提交与上游源码提交属于两个独立的版本控制边界。

## 读写边界

### 默认允许的只读行为

- 阅读 `.gitmodules`、父仓库记录的 gitlink 和 `source/` 中已经检出的源码。
- 检查 submodule 当前 commit、工作区状态以及源码路径是否存在。
- 使用 CodeGraph MCP、ripgrep 或其他不会写入源码的工具定位符号、调用关系和引用。
- 在笔记中引用源码路径、符号和固定版本。
- 查询上游 ref 指向，但不因此改变本地检出版本。

### 必须获得明确授权的写行为

- 初始化、更新、新增、删除或移动 submodule。
- 获取远端对象后切换 submodule commit，或修改父仓库 gitlink。
- 编辑、格式化、生成、暂存、提交或推送 `source/` 中的文件。
- 创建或更新 CodeGraph 索引。
- 恢复、清理或覆盖 submodule 中的已有修改和未跟踪文件。

> [!warning] 查询不等于更新
> 用户要求“查看最新 commit”“搜索实现”或“确认调用关系”时，只授权查询。除非用户同时明确要求更新，否则不得改变 submodule、gitlink 或 `source/` 工作区。

### 异常状态处理

发现以下情况时，Agent 应停止可能写入或覆盖内容的操作：

- submodule 当前 commit 与父仓库 gitlink 不一致。
- submodule 中存在已跟踪修改或未跟踪文件。
- 笔记标注的 commit 与实际用于分析的版本不一致。
- `.gitmodules`、gitlink 和实际目录之间存在路径或来源冲突。

报告时应说明受影响路径、版本差异、已有修改和建议处理方式。恢复、stash、reset、clean 或强制切换都必须由用户决定。

## 在 `source/` 中检索代码

源码检索是只读行为，应在具体 submodule 根目录内进行，避免把多个独立仓库的结果混在一起。

### 优先使用 CodeGraph MCP

如果目标源码仓库根目录存在 `.codegraph/`：

1. 优先调用 CodeGraph MCP 的 `codegraph_explore`。
2. 将该源码仓库路径作为 `projectPath`，不要使用笔记仓库路径代替。
3. 查询中写明目标符号、文件或问题，例如实现位置、调用路径、动态分派关系和修改影响范围。
4. 使用返回的行号源码和调用链支撑笔记结论，不需要再进行重复的全库文本搜索。

> [!note] 索引边界
> CodeGraph 索引是否创建或更新由用户决定。不存在 `.codegraph/` 时直接使用 ripgrep，不要为了本次笔记整理自行建索引。

### 使用 ripgrep 兜底

没有 `.codegraph/`、CodeGraph MCP 不可用，或只需查找字面文本和文件名时，使用 `rg`：

- `rg --files`：列出目标源码仓库中的文件。
- `rg -n '<pattern>' <path>`：查找符号、字符串或配置项并保留行号。
- 用 `--glob` 缩小语言、目录或文件类型范围，避免输出无关依赖和生成文件。

ripgrep 的搜索范围应指向具体 submodule 或模块目录。不要通过搜索命令写文件，也不要因为搜索结果不足而擅自更新源码版本。

## 版本控制要求

### 分析前固定版本

基于源码整理笔记前，应确认：

- submodule 路径来自 `.gitmodules`。
- 父仓库 gitlink 指向的确切 commit。
- 实际检出的 commit 是否与 gitlink 一致。
- submodule 工作区是否已有修改。

如果版本不一致，Agent 可以描述差异，但不能混用两个版本的源码得出结论。

### 笔记必须标注 commit

凡是基于 `source/` 源码得出结论的笔记，都应在 frontmatter 后、正文主体前添加版本 callout：

```markdown
> [!note] 源码版本
> 本文分析基于 submodule `source/ccnubox-be` 的 commit `afcc2ad`，重点目录为 `be-classlist_v2`。
```

- commit 必须足以唯一定位；需要严格复现时使用完整 SHA。
- 不使用“最新代码”“当前版本”等会随时间失效的表述。
- 同一篇笔记涉及多个 submodule 时，分别记录路径和 commit。
- 未能确认版本时，明确标注“待验证”，不能把推断写成确定事实。

### 版本更新后的同步要求

只有用户明确要求升级源码版本时，才允许改变 submodule commit 或父仓库 gitlink。版本变化后必须重新验证：

1. 笔记引用的文件和符号是否仍然存在。
2. 代码片段、调用关系和行为描述是否仍然成立。
3. 并发、事务、错误处理和配置等关键边界是否改变。
4. 所有受影响笔记的版本 callout 是否同步更新。
5. 父仓库是否只记录了预期的 gitlink 和笔记变更。

不能只替换 commit 字符串，就假定旧分析对新版本继续有效。

## 源码引用要求

源码文件不是 Obsidian 笔记，不使用 `[[...]]` 假装成笔记链接：

- 使用相对于笔记仓库根目录的路径，并统一使用 `/`。
- 尽量指向具体文件，同时在正文写出符号名。
- 需要点击跳转时使用相对 Markdown 链接。
- 不把易漂移的行号作为唯一定位方式。
- 只摘录支撑结论的最小代码，不复制与论点无关的大块源码。

示例：

```markdown
`GetClasses` 的实现见
[biz/usecase/classer.go](source/ccnubox-be/be-classlist_v2/biz/usecase/classer.go)
中的 `GetClasses` 方法。
```

笔记之间仍使用 Obsidian wikilink。新增源码分析笔记时，应由领域 hub 或概览笔记链接到它，并在分析笔记中链接回入口。

## Agent 完成检查

- 源码搜索使用了目标 submodule 的 CodeGraph 索引或限定范围的 ripgrep。
- 笔记结论对应一个明确、可复现的 submodule commit。
- 相对源码路径和符号名称在该 commit 中有效。
- 源码事实、推断和建议已经明确区分。
- `source/`、submodule commit 和父仓库 gitlink 没有因只读整理任务而改变。
- 如用户要求升级版本，所有受影响笔记已重新验证，而不是只替换 commit。
- 新建或拆分的笔记能从相关 hub 到达，并建立必要的双向 wikilink。

> [!warning] 提交边界
> 父仓库提交笔记、`.gitmodules` 和 submodule gitlink；上游仓库提交源码。不要把一个仓库的修改、暂存区或提交历史当成另一个仓库的一部分。
