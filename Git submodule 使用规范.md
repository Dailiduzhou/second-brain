---
title: Git submodule 使用规范
category: meta
type: standard
topic: repository
status: seedling
tags:
  - meta
  - meta/repository
  - git
  - git/submodule
aliases:
  - Git 子模块规范
  - 笔记仓库 submodule 规范
---

> [!abstract] 适用范围
> 本文规定本笔记仓库如何引入、更新和引用外部代码仓库。规范适用于所有放在 `source/` 下的 git submodule，也适用于只阅读源码并在笔记中建立代码引用的场景。

## 当前仓库约定

本仓库把笔记和外部源码分开管理：笔记由当前仓库提交，源码由上游仓库维护，当前仓库只记录 submodule 指向的确切提交。

| 项目           | 约定                                         |
| ------------ | ------------------------------------------ |
| 外部源码根目录      | `source/`                                  |
| 重点阅读模块       | `source/ccnubox-be/be-classlist_v2`        |
| submodule 配置 | `.gitmodules`                              |

`source/ccnubox-be` 在父仓库中是一个 gitlink，而不是普通目录。父仓库不会保存其中的源码文件，只保存上游仓库 URL、子模块路径和当前提交指针。

## 笔记引用规范

### 内部笔记使用 wikilinks

笔记之间的关联使用 Obsidian wikilinks，保证重命名时由 Obsidian 维护引用：

- 直接链接：`[[华师匣子课表查询]]`
- 链接到章节：`[[华师匣子课表查询-GetClass调用链#Kafka 延迟重试机制]]`
- 自定义显示文本：`[[华师匣子-代码结构|代码结构]]`

涉及本规范的导航入口是 [[Index Page]]；与当前 submodule 相关的阅读入口包括 [[华师匣子-代码结构]]、[[华师匣子课表查询]] 和 [[华师匣子课表查询-GetClass调用链]]。

### 外部源码使用相对路径

源码不是 Obsidian 笔记，不使用 `[[...]]` 假装成笔记链接，也不把源码复制进笔记仓库。引用代码时遵守以下规则：

- 使用仓库根目录相对路径，并统一使用 `/`：`source/ccnubox-be/be-classlist_v2/biz/usecase/classer.go`。
- 尽量引用具体文件和符号，不只写 `be-classlist_v2` 目录。
- 代码分析对应的 submodule 提交应写入笔记，例如 `afcc2ad`；上游仓库的网页链接用于补充外部出处。
- 若需要可点击跳转，使用相对 Markdown 链接；笔记之间仍然使用 wikilinks。

示例：

```markdown
`GetClasses` 的实现见 [biz/usecase/classer.go](source/ccnubox-be/be-classlist_v2/biz/usecase/classer.go)。

相关设计说明见 [[华师匣子课表查询-GetClass调用链]]。
```

## 新增 submodule

新增外部源码时，从仓库根目录执行：

```bash
git submodule add <上游仓库 URL> source/<仓库目录名>
```

例如：

```bash
git submodule add https://github.com/asynccnu/ccnubox-be.git source/ccnubox-be
```

新增后必须检查：

```bash
git status --short
git diff -- .gitmodules
git diff --cached --submodule=short
git submodule status
```

父仓库提交中应同时包含 `.gitmodules` 和对应的 `source/<仓库目录名>` gitlink。不要执行 `git add source/<仓库目录名>/**` 把子模块源码当作父仓库普通文件加入暂存区。

## 克隆和恢复工作区

首次克隆时优先递归初始化 submodule：

```bash
git clone --recurse-submodules <笔记仓库 URL>
```

已有笔记仓库但 `source/` 为空时，执行：

```bash
git submodule update --init --recursive
```

恢复后确认父仓库记录的提交已经检出：

```bash
git submodule status
git -C source/ccnubox-be rev-parse HEAD
git -C source/ccnubox-be status --short
```

正常情况下，最后一条命令没有输出；如果子模块存在未提交修改，应先确认这些修改属于源码开发工作，不能直接把它们混入笔记仓库提交。

## 更新 submodule 指针

更新源码必须是有意识的版本升级，而不是让笔记仓库跟随上游工作区漂移。推荐流程：

```bash
git -C source/ccnubox-be fetch origin
git -C source/ccnubox-be checkout <目标提交>
git -C source/ccnubox-be rev-parse HEAD
git add source/ccnubox-be
```

然后在笔记中同步检查：

1. 代码路径是否仍然存在。
2. 代码片段、符号名称和行文结论是否仍然匹配。
3. 记录分析所依据的新提交，避免笔记继续声称基于旧版本。
4. 用 `git diff --cached --submodule=short` 确认父仓库只更新了 gitlink，而不是意外收录源码文件。

如果需要修改上游代码，应在 submodule 内单独创建分支、提交并按照上游项目流程推送；笔记仓库只在需要阅读该新版本时更新 gitlink。不要在 detached HEAD 上直接积累源码修改。

## 提交前检查清单

涉及 submodule 或源码引用的笔记变更，提交父仓库前至少执行：

```bash
git status --short
git diff --check
git submodule status
git -C source/ccnubox-be status --short
git diff --cached --submodule=short
```

检查结果应满足：

- `.gitmodules` 的 URL 和路径与实际目录一致。
- submodule 工作区干净，父仓库记录的 gitlink 指向预期提交。
- 笔记中的源码路径存在，使用 `/`，且没有把内部笔记误写成普通 Markdown 外链。
- 新笔记有完整 frontmatter，`category`、`type`、`topic`、`status`、`tags` 与本仓库现有 metadata 风格一致。
- 新增的内部笔记已从 [[Index Page]] 或相关 hub 笔记可达。
- 代码分析明确写出版本或提交，不用“当前代码”这类无法复现的表述。

## 常见问题

### 子模块目录为空

这是未初始化 submodule 的工作区状态，不要手动 `git clone` 覆盖目录。执行：

```bash
git submodule update --init --recursive
```

### 父仓库显示 submodule 有修改

先进入子模块查看：

```bash
git -C source/ccnubox-be status --short
git -C source/ccnubox-be diff
```

如果只是切换到了不同提交，切回父仓库记录的提交；如果是真正的源码修改，则在子模块中单独处理，不要把源码文件复制到父仓库。

### 笔记链接失效

先确认链接目标相对于笔记仓库根目录仍然存在，再确认笔记引用的 submodule 提交是否发生变化。内部笔记改名时使用 Obsidian 的 wikilink 维护能力；源码文件改名则应同步更新所有相对路径引用。

> [!warning] 提交边界
> 父仓库提交的是笔记、`.gitmodules` 和 submodule gitlink；上游仓库提交的是源码。两者的提交历史、权限和发布流程相互独立，不要把一个仓库的提交当成另一个仓库的源码提交。
