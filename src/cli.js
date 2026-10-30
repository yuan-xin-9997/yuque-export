import path from 'node:path'
import { loadConfig, initConfig } from './config.js'
import { getUserBooks, filterBooks } from './api.js'
import { sync } from './sync.js'
import { rememberSecret, publicConfig, redact } from './secrets.js'
import { syncMode } from './safety.js'

const HELP = `
yuque-export — 语雀知识库导出工具（基于 yuque-dl，无需语雀会员）

用法:
  yuque-export init [--token <_yuque_session>] [--dir <导出目录>]   初始化配置
  yuque-export repos                                                列出账号下所有知识库
  yuque-export sync                                                 增量同步（--mode retain|recycle|mirror；--preview 只预览清理）
  yuque-export config                                               查看当前配置

配置文件 ~/.yuque-export.json 支持的字段:
  mode               retain 保留 / recycle 回收（新配置默认）/ mirror 显式镜像
  token              语雀 Cookie 中 _yuque_session 的值
  key                Cookie 键名（默认 _yuque_session，企业版需修改）
  distDir            导出根目录
  include/exclude    知识库名或 slug 的白/黑名单（数组，忽略大小写）
  toc                在笔记开头生成目录（默认 false）
  hideFooter         不在笔记尾部追加更新时间/原文链接（默认 false）
  ignoreAttachments  忽略附件下载，可传后缀字符串（默认 false）

导出效果:
  distDir/知识库名/...              干净的纯标题目录结构
  distDir/知识库名/笔记.md           笔记正文（Markdown）
  distDir/知识库名/笔记.assets/      该笔记的图片、附件等资源（相对引用）
  distDir/.yuque-export-raw/        yuque-dl 增量缓存（勿删，删了下次全量）
`

function parseArgs(argv) {
  const rest = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next
        i++
      } else {
        opts[key] = true
      }
    } else {
      rest.push(a)
    }
  }
  return { command: rest[0], opts }
}

export async function run(argv) {
  const { command, opts } = parseArgs(argv)

  if (!command || command === 'help' || opts.help) {
    console.log(HELP)
    return
  }

  if (command === 'init') {
    await initConfig({ token: opts.token, distDir: opts.dir, mode: opts.mode })
    console.log('\n下一步: 运行 yuque-export sync 开始同步')
    return
  }

  // 以下命令均需已初始化
  const config = await loadConfig()
  if (!config?.token || !config?.distDir) {
    throw new Error('尚未初始化，请先运行: yuque-export init')
  }
  if (opts.token) config.token = opts.token
  rememberSecret(config.token)
  if (opts.mode) config.mode = opts.mode
  syncMode(config)
  config.preview = opts.preview === true
  if (opts.dir) config.distDir = path.resolve(opts.dir)

  if (command === 'config') {
    const shown = publicConfig(config)
    delete shown.preview
    console.log(redact(JSON.stringify(shown, null, 2)))
    return
  }

  if (command === 'repos') {
    const books = await getUserBooks({ token: config.token, key: config.key })
    const selected = new Set(filterBooks(books, config).map((b) => b.id))
    console.log(`共 ${books.length} 个知识库：\n`)
    for (const b of books) {
      const mark = selected.has(b.id) ? '√' : ' '
      console.log(` ${mark} ${b.visibility ? '[公开]' : '[私有]'} ${b.name}（${b.itemsCount} 篇）  https://www.yuque.com/${b.userLogin}/${b.slug}`)
    }
    return
  }

  if (command === 'sync') {
    await sync(config)
    return
  }

  throw new Error(`未知命令: ${command}。运行 yuque-export --help 查看用法`)
}
