# yuque-export

将语雀知识库按目录导出为 Markdown，图片、附件放入笔记同名 `.assets` 目录，使用相对链接，适合在 Obsidian 中阅读。继续使用 [yuque-dl](https://github.com/gxr404/yuque-dl) 下载，保留增量、同名笔记去重、缺失文件修复与后处理。

## 从源码安装

建议使用仍受维护的 Node.js 22 / 24；运行时下限与当前固定的上游版本一致，为 Node.js 18.4（Node.js 18 已停止维护）。运行测试请使用 Node.js 18.20.8 或 22 / 24。

```bash
git clone https://github.com/yuan-xin-9997/yuque-export.git
cd yuque-export
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
node bin/yuque-export.js --help
npm link
```

本说明面向源码安装，不要求 npm 上已有本版本。`npm link` 注册本地命令；也可以始终使用 `node bin/yuque-export.js`。MIT 许可证见 [LICENSE](LICENSE)。

```bash
yuque-export init --dir ./yuque-backup
yuque-export repos
yuque-export sync --preview
yuque-export sync
```

`init` 会在终端隐藏输入登录会话值。浏览器登录语雀后，从开发者工具 Application → Cookies → `https://www.yuque.com` 获取 `_yuque_session`。不要把会话值提交到 Git、粘贴进日志或截图。命令行 `--token` 仍兼容，但可能进入 shell 历史和本机进程参数，推荐交互输入。

## 配置与凭据

配置位于 `os.homedir()` 下的 `.yuque-export.json`，Windows 使用当前用户的主目录。配置展示完全隐藏 token 和 Cookie 字段；上游原始诊断日志不透传，以免其输出会话值。配置仍为本地明文，请保护系统账号及备份。

POSIX 首次写入使用 `0600`，读取/更新时收紧已有文件。保存采用同目录独占临时文件、刷盘、原子替换；失败或进程中断时旧配置保持完整。遗留临时文件不参与加载，可在确认没有写入进程后手动删除。配置损坏或无法读取会报错，不会当作首次运行覆盖。Windows 使用用户目录现有权限边界，不调整全局 umask 或目录 ACL。

以下配置示例不含登录凭据；先用 `init` 写入会话，再按需修改其他字段：

```json
{
  "distDir": "D:\\yuque-backup",
  "mode": "recycle",
  "include": [],
  "exclude": [],
  "toc": false,
  "hideFooter": false,
  "ignoreAttachments": false
}
```

`key` 默认为 `_yuque_session`，可设置其他 Cookie 键名；当前账号枚举与 URL 仍固定为 `www.yuque.com`，不承诺企业私有域名可用。`include/exclude` 按知识库名称或 slug 匹配，忽略大小写；过滤掉的库保留。`ignoreAttachments` 可为 `true` 或扩展名字符串如 `mp4,pdf`。

## 清理模式与旧配置升级

| 配置 | 行为 |
| --- | --- |
| 新建配置 | 默认 `recycle`，符合条件的旧产物移入回收目录 |
| `mode: "mirror"` | 显式镜像，符合条件的工具产物永久删除 |
| `mode: "retain"` | 输出中保留旧笔记和附件；过时 raw 文档移入缓存回收目录 |
| 旧配置没有模式 | `legacy` 待确认，提示选择模式，保留过时数据；普通 sync 不改写配置 |
| 兼容字段 `mirror: true/false` | 分别保留显式镜像/保留意图；`mode` 优先 |

`init` 更新旧配置时保留其他字段；缺失模式写为 `legacy`，不会批量改成新用户默认值。原有 `.export-state.json` 的额外字段也保留。版本 2 状态只有逻辑版本号，没有文件归属证明，因此不能授权清理旧文件。首次升级会记录可验证的新产物，未登记旧产物保留；冲突文件或本地修改不会被覆盖，需要先手动备份、移走冲突文件再同步。

先审阅预览，再明确选择：

```bash
yuque-export sync --mode mirror --preview
yuque-export sync --mode mirror
# 如需持久保存选择（保持已有 token、目录、其他字段）
yuque-export init --mode mirror
```

命令行模式只作用于本次同步。`--preview` 不下载、不写配置、状态或输出，展示基于当前本地状态与远端目录可确认的 raw/输出清理候选。新增、更新、重命名及下载后才产生的附件变化无法完全预演；执行时重新核验条件。

清理只作用于成功导出清单中有摘要且内容未被用户修改的文件。个人笔记、未登记文件、本地修改、用户空目录和回收区保留。资源副本仅在成功导出并持久化状态后，按实际复制的文件逐一回收空间；不递归删除整个资源目录。

## 远端状态判断

- 分页异常、重复条目、格式变化、计数不符、401、登录重定向等不会被当作空清单。
- 文档移除需满足：有效的知识库身份、有效且计数一致的 TOC、同一登录身份及完整管理/私有阅读权限、已有可比对状态、下载前后 UUID 清单一致、活跃文档下载结果存在。权限收窄或切换账号时跳过该库。
- 没有足够状态的首次同步只建立状态，不清理。缺少完整权限的只读账号可以导出，但不授权清理。未知 TOC 类型、计数语义变化会保守跳过此库。
- TOC 移除仅说明文档退出当前完整目录，不证明远端内容被永久销毁。`mirror` 按这个目录语义镜像；需要保留历史请选 `retain` / `recycle`。
- **整库从账号列表消失时始终保留 raw 和输出**，并说明无法区分删除、权限变化或枚举变化。当前 Web 接口没有可靠删除凭据，不自动销毁整库。
- 笔记重命名按 UUID 处理，并尝试复用已有附件；知识库改名会创建新目录，旧目录与状态保留，核对后自行归档。
- 上游即使退出码为 0，也可能有单篇失败；检测到 ERROR 诊断或不完整下载时阻止清理。后处理失败同样阻止输出清理。

## 输出、归属与恢复

```text
distDir/
├── .yuque-export-owner.json       # 根路径与知识库 ID/目录归属
├── .yuque-export-raw/
│   └── 知识库A/
│       ├── progress.json         # yuque-dl 增量状态
│       ├── .export-state.json    # 文件摘要、UUID 映射、权限状态
│       └── .yuque-export-trash/  # 已回收 raw 文件（按需产生）
└── 知识库A/
    ├── index.md
    ├── 笔记.md
    ├── 笔记.assets/
    ├── 父文档/
    │   ├── index.md
    │   ├── 父文档.assets/
    │   └── 子笔记.md
    └── .yuque-export-trash/      # 回收的输出文件（按需产生）
```

同名笔记自动加序号；语雀文档间链接保留远程链接。回收文件位于 `<所属库目录>/.yuque-export-trash/<随机批次>/<原相对路径>`，可检查后手动移回；工具不自动清空回收区。输出与 raw 的回收区独立。

请使用专用子目录。同步拒绝磁盘根目录、用户主目录、系统目录、当前项目根目录及其危险祖先；拒绝越界、绝对状态路径、符号链接、junction 和多重硬链接文件。根路径/库归属不匹配时停止。目录内有链接时整个同步停止，先移走链接再运行。

不要手动改写状态文件、让其他程序同时改动导出树，或把不同账号导出到同一目录。同步使用独占锁；进程被强制终止后，确认没有同步进程，再手动删除 `.yuque-export.lock`。移动整个导出树会触发路径归属校验，需要先备份并人工核对状态，工具不会自动重新认领。路径检查无法防御能同时篡改目录和状态的同用户恶意进程；本地权限边界仍由操作系统负责。

## 命令与测试

```text
yuque-export init [--dir <path>] [--mode retain|recycle|mirror]
yuque-export repos
yuque-export sync [--dir <path>] [--mode retain|recycle|mirror] [--preview]
yuque-export config
```

`sync` 按 uuid 与更新时间统计新增/更新，缺失 raw 或已登记输出资源时失效对应增量条目并重下；仅复制变化文件。下载量按落盘统计，无法给出准确百分比。

```bash
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm pack --dry-run
```

测试仅使用合成远端响应、运行时生成的随机凭据哨兵与临时目录，无真实账号。保留原有增量/同名/删除/修复测试，并增加配置权限与中断、迁移、模式、空/部分列表、异常、目录消失、重命名、附件修复、重复同步和外部哨兵保护测试。公共 CI 在 Windows / macOS / Linux 的 Node.js 18.20.8、22、24 上运行，不需要 secrets。

## 上游兼容与边界

当前固定 `yuque-dl 1.0.86`；核对了其发行包 CLI、`progress.json` 字段、TOC/权限类型及附件布局。其自身声明 Node.js ≥18.4。本工具不宣称兼容尚未验证的上游版本；升级需重新跑合成测试并复核字段/日志约定。语雀网页接口及内嵌 JSON 可能随时变化，不能保证长期稳定。

画板、数据表暂不支持；普通表格按 Markdown 表格导出，表格内图表存在限制。图片下载失败时上游可能保留远程引用，本工具不会将其视作完整离线备份。仍保留远程引用的失败图片重试行为由上游增量状态决定，不保证仅重跑即可补齐。

发布前需确认三平台 CI、在独立测试账号/测试知识库中人工验证当前语雀响应和上游附件行为、审阅依赖审计报告与包内容。尚未做真实登录验证；此修复不运行发布、部署、凭据轮换或共享历史改写。版本变更见 [CHANGELOG.md](CHANGELOG.md)。
