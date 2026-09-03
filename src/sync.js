import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getUserBooks, filterBooks, getBookTocUuids } from './api.js'
import { postprocessBook } from './postprocess.js'
import { syncDeletions } from './prune.js'
import { sanitize } from './util.js'

const require = createRequire(import.meta.url)

/** 缓存目录名（放在导出根目录下，存放 yuque-dl 的原始输出与增量状态） */
export const RAW_DIR_NAME = '.yuque-export-raw'

/** 定位 yuque-dl 的入口脚本（直接用 node 运行，避免 shell 转义 token） */
function resolveYuqueDlBin() {
  try {
    const pkgJson = require.resolve('yuque-dl/package.json')
    const pkg = require('yuque-dl/package.json')
    const binPath = path.join(path.dirname(pkgJson), pkg.bin['yuque-dl'])
    if (fs.existsSync(binPath)) return binPath
  } catch { /* fallthrough */ }
  throw new Error('未找到 yuque-dl，请先在项目目录执行 npm install')
}

/** 运行 yuque-dl（透传 stdio，实时展示进度） */
function runYuqueDl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveYuqueDlBin(), ...args], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`yuque-dl 退出码 ${code}`))
    })
  })
}

/** 主流程：枚举 → 过滤 → 下载 → 后处理 */
export async function sync(config) {
  const distDir = path.resolve(config.distDir)
  const rawDir = path.join(distDir, RAW_DIR_NAME)
  await fsp.mkdir(rawDir, { recursive: true })

  console.log('▶ 正在获取知识库列表...')
  const allBooks = await getUserBooks({ token: config.token, key: config.key })
  const books = filterBooks(allBooks, config)
  if (books.length === 0) {
    console.log('没有匹配的知识库（检查配置中的 include/exclude）')
    return
  }
  console.log(`共 ${allBooks.length} 个知识库，本次同步 ${books.length} 个：`)
  books.forEach((b) => console.log(`   - ${b.name}（${b.itemsCount} 篇）`))
  console.log('')

  const yuqueDlArgs = [
    'batch',
    ...books.map((b) => `https://www.yuque.com/${b.userLogin}/${b.slug}`),
    '-t', config.token,
    '-d', rawDir,
    '--incremental',
  ]
  if (config.key) yuqueDlArgs.push('-k', config.key)
  if (config.toc) yuqueDlArgs.push('--toc')
  if (config.hideFooter) yuqueDlArgs.push('--hideFooter')
  if (config.ignoreAttachments === true) {
    yuqueDlArgs.push('--ignoreAttachments')
  } else if (typeof config.ignoreAttachments === 'string') {
    yuqueDlArgs.push('--ignoreAttachments', config.ignoreAttachments)
  }

  console.log('▶ 开始下载（增量模式，首次会比较慢）...\n')
  await runYuqueDl(yuqueDlArgs)

  // 知识库级删除同步：raw 中存在但账号已不存在的知识库 → 移除 raw 与输出
  await pruneDeletedBooks(distDir, rawDir, allBooks)

  console.log('\n▶ 删除同步与后处理：清理已删文档、清理命名、重组资源到 .assets 目录...')
  let totalNotes = 0
  for (const b of books) {
    const bookRaw = path.join(rawDir, b.name)
    const bookOut = path.join(distDir, sanitize(b.name))
    if (!fs.existsSync(bookRaw)) {
      // yuque-dl 目录名带非法字符替换，兜底找一下
      const found = await fsp.readdir(rawDir).then((names) =>
        names.find((n) => n.replace(/[\\/:*?"<>|]/g, '_') === b.name.replace(/[\\/:*?"<>|]/g, '_')),
      )
      if (!found) {
        console.log(`   ✕ 跳过「${b.name}」：未找到下载结果`)
        continue
      }
      const res = await postprocessBook(path.join(rawDir, found), path.join(distDir, sanitize(found)))
      totalNotes += res
      continue
    }
    try {
      // 文档级删除同步：以服务端 TOC 为准清理已删除文档
      try {
        const tocUuids = await getBookTocUuids(`https://www.yuque.com/${b.userLogin}/${b.slug}`, {
          token: config.token,
          key: config.key,
        })
        const removed = await syncDeletions(bookRaw, tocUuids)
        if (removed.length) {
          console.log(`   - 「${b.name}」已删除 ${removed.length} 篇: ${removed.join('、')}`)
        }
      } catch (e) {
        // TOC 获取失败时保守跳过删除同步，绝不误删
        console.log(`   ⚠ 「${b.name}」目录树获取失败，跳过删除同步: ${e.message}`)
      }
      const res = await postprocessBook(bookRaw, bookOut)
      totalNotes += res
    } catch (e) {
      console.log(`   ✕ 「${b.name}」后处理失败: ${e.message}`)
    }
  }

  console.log(`\n√ 同步完成：${books.length} 个知识库，共处理 ${totalNotes} 篇笔记`)
  console.log(`  导出目录: ${distDir}`)
  console.log(`  增量缓存: ${rawDir}（请勿删除或修改，否则增量失效）`)
}

/** 知识库级删除同步：raw 中存在但账号知识库列表已不存在的 → 移除 raw 与输出 */
async function pruneDeletedBooks(distDir, rawDir, allBooks) {
  const norm = (s) => s.replace(/[\\/:*?"<>|\n\r]/g, '_')
  const activeBooks = new Set(allBooks.map((b) => norm(b.name)))
  for (const entry of await fsp.readdir(rawDir).catch(() => [])) {
    if (entry.startsWith('.')) continue
    const entryStat = await fsp.stat(path.join(rawDir, entry)).catch(() => null)
    if (!entryStat?.isDirectory()) continue
    if (activeBooks.has(norm(entry))) continue
    // 账号中已不存在的知识库（被删除），本地一并移除
    await fsp.rm(path.join(rawDir, entry), { recursive: true, force: true })
    const outDir = path.join(distDir, entry)
    if (fs.existsSync(outDir)) await fsp.rm(outDir, { recursive: true, force: true })
    console.log(`   - 知识库「${entry}」已在语雀端删除，本地已移除`)
  }
}
