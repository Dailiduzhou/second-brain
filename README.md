# second-brain

或许比第一个好？
Maybe better than the first biological brain?

站点：<https://dailiduzhou.github.io/second-brain/>

## 发布到 GitHub Pages

笔记用 [Quartz 4](https://quartz.jzhao.xyz/) 渲染，`main` 上的每次推送由 `.github/workflows/publish.yml` 构建并发布。

> [!warning] 仓库是公开的
> GitHub Pages 只发布渲染结果，不会让仓库变私有。把笔记标成 `draft: true` 只是不生成页面，
> `.md` 原文仍然能从 GitHub 仓库读到。真正的敏感内容要移出本仓库。

- 内容目录就是仓库根目录，Quartz 用 git 历史推算笔记的创建/修改时间，所以 CI 里必须 `fetch-depth: 0`。
- Quartz 本体不 vendor 进仓库：`scripts/quartz.sh` 把固定版本（`QUARTZ_REF`，当前 `v4.5.2`）克隆到 `.quartz-framework/`，
  再把 `.quartz/` 里的 `quartz.config.ts`、`quartz.layout.ts`、`custom.scss` 覆盖进去。构建产物在该目录的 `public/`。
- 站点入口依赖 `Index Page.md` 的 `aliases: [index]`：Quartz 要求根目录存在 `index.md`，别名会生成一个跳到 `/Index-Page` 的重定向页。

### 本地预览与构建

```bash
./scripts/quartz.sh serve            # http://localhost:8080，热重载
./scripts/quartz.sh serve --port 8099 # 8080 被占用时换端口
./scripts/quartz.sh build            # 静态产物在 .quartz-framework/public
```

需要 `bun`（当前固定 1.4.3）和 `git`；首次运行会克隆 Quartz 并安装依赖。

### 隐藏不公开的笔记

在笔记 frontmatter 里加 `draft: true`，Quartz 的 `RemoveDrafts` 过滤器会跳过它（页面、搜索索引、RSS、反向链接都不再包含）。
也可以直接把整篇笔记放进 `private/` 目录，该目录已在 `ignorePatterns` 里排除。

`AGENTS.md`、`README.md`、`source/` 也不发布，见 `.quartz/quartz.config.ts` 的 `ignorePatterns`。

### 凭据扫描（gitleaks）

`.gitleaks.toml` 在默认规则集上补充了连接串内嵌密码、阿里云 AccessKey、JWT 字面量、微信支付密钥等规则，
并允许清单过滤 `.obsidian/` 里的第三方插件打包产物和文档里的占位符（`postgres://user:pass@localhost:5432/mydb` 这类示例）。

```bash
gitleaks git --config .gitleaks.toml --redact --log-opts=--all   # 扫历史
gitleaks dir . --config .gitleaks.toml --redact                   # 扫工作区
docker run --rm -v "$PWD:/repo" -w /repo ghcr.io/gitleaks/gitleaks:latest \
  git --config .gitleaks.toml --redact --log-opts=--all           # 没装 gitleaks 时
```

CI 里用 `--redact`，命中值在公开日志里显示为 `REDACTED`；一旦命中，`secret-scan` job 失败，构建与发布都会被拦下。

### 首次部署

仓库设置里需要把 Pages 的 Source 设为 **GitHub Actions**，之后 `deploy` job 才能发布。也可以用 CLI：

```bash
gh api -X POST /repos/Dailiduzhou/second-brain/pages -f build_type=workflow
```
