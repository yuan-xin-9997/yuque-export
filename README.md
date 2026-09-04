# yuque-export

语雀知识库导出工具：保持目录结构导出为本地 Markdown，图片/附件本地化到笔记同名的 `.assets` 目录并采用相对引用，支持增量同步。**无需语雀会员。**

底层下载基于成熟开源项目 [yuque-dl](https://github.com/gxr404/yuque-dl)（语雀 Web API + Cookie），本工具在其上做封装：知识库枚举/过滤 + 后处理（纯标题命名、资源重组、链接改写、镜像同步）。

## 环境要求

- Node.js ≥ 18.4（Windows / macOS / Linux）

## 安装

```bash
cd yuque-export
npm install
npm link   # 之后即可在任意位置使用 yuque-export 命令
```

## 快速开始

```bash
# 1. 初始化（按提示粘贴 token、选择导出目录）
yuque-export init

# 2. 查看账号下所有知识库（标记 √ 的为本次会同步的）
yuque-export repos

# 3. 同步（首次全量，之后增量）
yuque-export sync
```

### sync 输出说明

逐个知识库处理：先增量检查，有真实下载时才显示下载状态行（已下载量 · 速度），每个知识库列出本次的新增/更新/修复/删除明细，结束汇总各类篇数：

```
== 同步开始 ==
知识库 9 个（账号共 9 个）
  [1/9] 个人信息
      无变化
  [2/9] 数字生活
      下载中: 12.5 MB · 2.1 MB/s          ← 仅在实际下载数据时出现，单行实时刷新
      更新 2 篇: 摄影workflow、NAS备份方案
      新增 1 篇: 新买的镜头
      下载: 12.5 MB
  [3/9] 技术
      修复 1 篇（本地文件曾缺失，已重新下载）: 安全漏洞
      删除 1 篇: 过时的笔记
  ...
== 同步完成 ==
  检查 415 篇: 新增 1 · 更新 2 · 修复 1 · 删除 1
  新增: 新买的镜头
  更新: 摄影workflow、NAS备份方案
  修复: 安全漏洞
  删除: 过时的笔记
  下载: 12.5 MB
  导出目录: E:\YuqueExportLibrary
  增量缓存: E:\YuqueExportLibrary\.yuque-export-raw（请勿删除或修改，否则增量失效）
```

- 新增/更新：对比下载前后 yuque-dl 的 `progress.json`（按文档 uuid 与内容更新时间）
- 修复：增量记录显示已下载、但本地文件缺失（如被杀毒软件隔离）的笔记，自动重新下载
- 删除：以服务端目录树为准同步移除（目录树获取失败时保守跳过，绝不误删）
- 下载量按磁盘实际落盘统计（yuque-dl 不提供字节级进度，总量无法预知，故显示已下载量与速度而非百分比）

### 获取 Token

私有知识库需要登录 Cookie：

1. 浏览器登录 [yuque.com](https://www.yuque.com)
2. `F12` 打开开发者工具 → **Application（应用）** → **Cookies** → `https://www.yuque.com`
3. 找到 `_yuque_session`，复制它的值
4. `yuque-export init` 时粘贴，或编辑 `~/.yuque-export.json`

> token 过期后重新获取并更新配置即可（一般几个月有效）。

## 配置文件 `~/.yuque-export.json`

```jsonc
{
  "token": "_yuque_session 的值",
  "key": "_yuque_session",              // 企业版语雀需改成对应的 Cookie 键名
  "distDir": "D:\\yuque-backup",        // 导出根目录
  "include": [],                        // 可选：知识库名/slug 白名单
  "exclude": ["草稿本", "trash"],       // 可选：黑名单（与 include 二选一使用）
  "toc": false,                         // 笔记开头生成目录
  "hideFooter": false,                  // 不在笔记尾部追加更新时间/原文链接
  "ignoreAttachments": false            // true=忽略附件；"mp4,pdf"=忽略指定后缀
}
```

## 导出目录结构

```
distDir/
├── .yuque-export-raw/          # yuque-dl 增量缓存（仅保留 md 与 progress.json，
│   └── 知识库A/                 #   图片附件导出成功后即从缓存删除，不占额外空间）
├── 知识库A/                     # ← 干净的导出结果（纯标题命名）
│   ├── index.md                 # 知识库目录（链接已改写为干净路径）
│   ├── 笔记一.md
│   ├── 笔记一.assets/           # 笔记一的图片、附件、音视频（唯一拷贝在这里）
│   │   └── image.png
│   ├── 父文档/                   # 带子文档的笔记：正文为 父文档/index.md
│   │   ├── index.md
│   │   ├── 父文档.assets/
│   │   └── 子笔记.md
│   └── 子笔记.assets/
```

- 同名笔记自动加序号：`标题.md`、`标题 (2).md`
- Markdown 内资源引用均为相对路径（`./笔记一.assets/image.png`）
- 语雀内文档间链接保留为语雀远程链接

## 增量同步说明

- `sync` 每次运行：只下载内容有更新的笔记（按语雀端更新时间比对），后处理仅复制有变化的文件，未变化笔记直接跳过
- **删除同步**：每次 sync 以服务端目录树（TOC）为准——语雀端删除的文档、改名遗留的旧文件、整个被删除的知识库，本地都会同步移除；目录树获取失败时保守跳过，绝不误删
- **自愈**：增量记录显示已下载、但本地文件缺失的笔记（如被杀毒软件隔离），自动重新下载
- **空间优化**：笔记导出成功后，其图片/附件副本立即从 `.yuque-export-raw/` 缓存中删除（输出目录是唯一拷贝）；文档更新时 yuque-dl 会重新下载该文档的全部资源，不受影响
- **请勿删除或修改 `distDir/.yuque-export-raw/`**，它是增量状态所在；删除后下次将全量重新下载
- **导出目录由工具完全管理**：不要把个人文件放进导出目录（不在源里的文件会在同步时被清理）
- 在语雀重命名笔记 = 本地文件同步改名（增量按文档 uuid 追踪，重命名后的首次同步会重新下载该篇内容）

## 命令一览

```
yuque-export init [--token <t>] [--dir <path>]   初始化配置
yuque-export repos                                列出账号知识库
yuque-export sync [--token <t>] [--dir <path>]   增量同步
yuque-export config                               查看当前配置（token 打码）
```

## 已知限制

- 语雀「画板」「数据表」类型文档暂不支持（yuque-dl 限制）
- 表格类文档导出为 Markdown 表格，表格内图表不支持
- 图片下载失败时该图保留为语雀远程链接（重跑 `sync` 可重试）
