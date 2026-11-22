# yuque-export 协作说明

语雀知识库导出 CLI：npm 包名 `yuque-export-cli`，命令名仍是 `yuque-export`（npm 上的 `yuque-export` 属于别的项目）。本文件只写「改这个仓库不能踩的坑」，安装与用法见 [README.md](README.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 目录与职责

- `bin/yuque-export.js`：入口，只做异常兜底与退出码（单篇失败不改退出码）。
- `src/cli.js`：命令解析（`init` / `sync` / 预览）与参数校验。
- `src/sync.js`：主流程——枚举 → 过滤 → 修复缺失 → 下载 → 删除同步 → 后处理。
- `src/postprocess.js`：把 yuque-dl 的原始输出整理成「纯标题命名 + `<笔记>.assets/`」，核心逻辑都在这里。
- `src/prune.js`：TOC 删除同步、`progress.json` 缺失自愈。
- `src/safety.js`：越界/符号链接/文件归属清单/清理，**所有写操作都要经过它**。
- `src/secrets.js`：日志脱敏（`redact`）。
- `src/config.js`、`src/api.js`：配置与语雀 API。
- `test/`：`node --test` 风格用例，`npm test` 串行跑两个文件。

## 数据布局

- 输出：`<导出根>/<知识库>/…`，每篇笔记的资源在同名 `.assets/` 目录。
- `.yuque-export-raw/`：增量缓存，只保留 md、`progress.json`、`.export-state.json`；资源复制成功后会回收。
- `.export-state.json`：**文件归属清单**（相对路径 → sha256）。`assertWritable` 对「未登记」或「本地被改过」的文件一律拒绝覆盖。删掉它等于放弃这些文件的归属，之后只会被当作冲突文件。
- `.yuque-export-trash/`：`recycle` 模式的回收区。

## 必须守住的不变量

1. **整库无错误才做镜像清理**（`postprocessBook` 中 `if (confirmed && !errors.length)`）。单篇失败只能保留旧输出，绝不能顺手清别人的文件。
2. **raw 资源只在确认复制成功后回收**（`copiedRaw`），否则等于删数据。
3. **不要为了跑通而放宽 `assertWritable`**：它挡的是误覆盖用户文件。
4. **路径一律走 `safePath`**：拒绝越界、符号链接与 junction。macOS 上 `/tmp` 是符号链接，脚本和测试里要先 `realpath`，否则会报「拒绝符号链接或 junction 路径」。
5. **改后处理逻辑要提升 `LOGIC_VERSION`**，否则旧输出会被增量跳过。

## 踩过的坑

- **不要用正则切 Markdown 链接**。yuque-dl 把附件原名原样写进链接，名字里可能有空格或成对括号：`名录(上海).txt`、`2026-01-06-GS Asia Views_ ….pdf`、`新联酒店菜单设计文件  2024年 11.20.pdf`。`[^)\s]+` 这类写法会在空格或 `)` 处截断，表现为「资源缺失；保留已有输出，等待重新下载」，且整篇不再更新。统一用 `scanInlineLinks` / `parseLinkUrl`。
- 笔记是否变化看 mtime + sha256 双重判据；`writeIfChanged` 会保留源的 mtime。
- 日志必须过 `redact`，不要把 token、Cookie、上游原始诊断打到终端或文件里。
- 单篇失败只计数、退出码仍是 0；判断成败要看汇总里的「失败 N 篇」。

## 改动流程

1. 先复现：在 `test/postprocess.test.mjs` 里照 `makeFixture` 造夹具，写明失败现象。
2. `npm test` 必须全绿；影响输出结构的改动，用真实数据在临时目录（clonefile 复制即可）跑新旧对比，**不要直接改用户的导出目录**。
3. 更新 [CHANGELOG.md](CHANGELOG.md) 的「未发布」段落。
4. 提交用 `fix:` / `feat:` / `docs:` / `chore:` 前缀 + 中文描述。

## 发布到 npm

`package.json` 的 `files` 白名单只有 `bin/ src/ docs/ README.md CHANGELOG.md LICENSE`，本文件不进包。

1. `npm test`
2. `npm version patch --no-git-tag-version`（同时改 `package-lock.json`）
3. CHANGELOG 把「未发布」改成 `## X.Y.Z — YYYY-MM-DD`
4. `npm pack --dry-run` 确认打包内容
5. 提交 `chore: release X.Y.Z` 并推送
6. `npm publish`（账号 `yuanxinnpm`，本机登录信息在 `~/.npmrc`，Granular Access Token 需勾选 Bypass 2FA；Token 失效时需重新签发，见个人仓库 `refs/npm账号.md`）
7. 校验：`npm view yuque-export-cli version`、`npm view yuque-export-cli dist.tarball`
