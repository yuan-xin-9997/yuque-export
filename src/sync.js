import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getUserBooks, filterBooks, getBookTocUuids } from './api.js'
import { postprocessBook } from './postprocess.js'
import { syncDeletions, repairMissingRawFiles } from './prune.js'
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

/** 字节数格式化 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

/** 终端中可被 \r 覆盖刷新的单行状态 */
class LiveLine {
  constructor() {
    this.text = ''
    this.active = false
  }
  set(text) {
    this.text = text
    this.active = true
    process.stdout.write(`\r\x1b[2K${text}`)
  }
  clear() {
    if (this.active) process.stdout.write('\r\x1b[2K')
    this.active = false
  }
}

/**
 * 下载量监控：周期扫描 raw 目录，按 mtime 统计本次运行实际写入的数据量
 * （yuque-dl 不提供字节级进度，这里以磁盘落盘量为准）。
 */
class ByteMeter {
  constructor(dir, sinceMs) {
    this.dir = dir
    this.since = sinceMs
    this.bytes = 0
    this.docs = 0
    this.speed = 0
    this._prev = { bytes: 0, time: Date.now() }
    this._timer = null
    this.onSample = null
  }
  start() {
    this._timer = setInterval(() => this.sample().catch(() => {}), 800)
  }
  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }
  async sample() {
    let bytes = 0
    let docs = 0
    const walk = async (d) => {
      let entries
      try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = path.join(d, e.name)
        if (e.isDirectory()) {
          await walk(abs)
          continue
        }
        // 排除每次运行都会重写的状态文件，只统计真实下载数据
        if (e.name === 'progress.json' || e.name === 'index.md' || e.name.startsWith('.')) continue
        const st = await fsp.stat(abs).catch(() => null)
        if (!st || st.mtimeMs < this.since) continue
        bytes += st.size
        if (e.name.endsWith('.md')) docs++
      }
    }
    await walk(this.dir)
    const now = Date.now()
    const dt = (now - this._prev.time) / 1000
    if (dt > 0.2) {
      const inst = Math.max(0, (bytes - this._prev.bytes) / dt)
      this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst
      this._prev = { bytes, time: now }
    }
    this.bytes = bytes
    this.docs = docs
    if (this.onSample) this.onSample()
  }
}

/**
 * 运行 yuque-dl 下载单个知识库：
 * 抑制其逐篇 "Download [===]" 进度条，其余日志（INFO/ERROR）原样透传。
 */
function runYuqueDlBook(url, extraArgs, { onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveYuqueDlBin(), url, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    const handle = (chunk) => {
      buf += chunk.toString()
      const parts = buf.split(/\r|\n/)
      buf = parts.pop() // 末段可能不完整，留待下个 chunk
      for (const line of parts) {
        if (!line.trim()) continue
        if (/^Download \[/.test(line)) continue // 逐篇检查/下载共用同一条进度条，无法区分，统一抑制
        onLine(line)
      }
    }
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (buf.trim() && !/^Download \[/.test(buf)) onLine(buf)
      if (code === 0) resolve()
      else reject(new Error(`yuque-dl 退出码 ${code}`))
    })
  })
}

/** 在 raw 中定位知识库目录（yuque-dl 目录名做了非法字符替换） */
async function findBookRaw(rawDir, b) {
  const direct = path.join(rawDir, sanitize(b.name))
  if (fs.existsSync(direct)) return direct
  const norm = (s) => s.replace(/[\\/:*?"<>|\n\r]/g, '_')
  const names = await fsp.readdir(rawDir).catch(() => [])
  const found = names.find((n) => norm(n) === norm(b.name))
  return found ? path.join(rawDir, found) : null
}

/** 主流程：枚举 → 过滤 → 逐库（修复缺失 → 下载 → 删除同步 → 后处理） */
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

  // 知识库级删除同步：raw 中存在但账号已不存在的知识库 → 移除 raw 与输出
  await pruneDeletedBooks(distDir, rawDir, allBooks)

  const commonArgs = ['-t', config.token, '-d', rawDir, '--incremental']
  if (config.key) commonArgs.push('-k', config.key)
  if (config.toc) commonArgs.push('--toc')
  if (config.hideFooter) commonArgs.push('--hideFooter')
  if (config.ignoreAttachments === true) {
    commonArgs.push('--ignoreAttachments')
  } else if (typeof config.ignoreAttachments === 'string') {
    commonArgs.push('--ignoreAttachments', config.ignoreAttachments)
  }

  const startTime = Date.now()
  let totalNotes = 0
  let totalBytes = 0

  for (let i = 0; i < books.length; i++) {
    const b = books[i]
    const url = `https://www.yuque.com/${b.userLogin}/${b.slug}`
    const label = `[${i + 1}/${books.length}] ${b.name}`
    const bookRaw = path.join(rawDir, sanitize(b.name))

    // 修复：progress 记录已下载但文件缺失（如被杀毒软件隔离）→ 移除条目，本次重新下载
    const repaired = await repairMissingRawFiles(bookRaw)
    if (repaired > 0) {
      console.log(`▶ ${label}`)
      console.log(`   - 检测到 ${repaired} 篇本地文件缺失（可能被杀毒软件隔离），将重新下载`)
    }

    const meter = new ByteMeter(bookRaw, startTime)
    const live = new LiveLine()
    meter.onSample = () => {
      if (meter.bytes <= 0) return
      const parts = [`   ↓ ${label} 已下载 ${fmtBytes(meter.bytes)}`, `${fmtBytes(meter.speed)}/s`]
      if (meter.docs > 0) parts.push(`${meter.docs} 篇更新`)
      live.set(parts.join(' · '))
    }
    meter.start()
    let downloadOk = true
    try {
      await runYuqueDlBook(url, commonArgs, {
        onLine(line) {
          live.clear()
          process.stdout.write(`${line}\n`)
        },
      })
    } catch (e) {
      downloadOk = false
      console.log(`   ✕ ${label} 下载失败: ${e.message}`)
    } finally {
      meter.stop()
      await meter.sample().catch(() => {})
      live.clear()
    }
    if (downloadOk) {
      if (meter.bytes > 0) {
        console.log(`   √ ${label}: 下载 ${fmtBytes(meter.bytes)}${meter.docs > 0 ? `，${meter.docs} 篇更新` : ''}`)
      } else {
        console.log(`   √ ${label}: 无更新`)
      }
    }
    totalBytes += meter.bytes

    // 下载后：文档级删除同步 + 后处理
    const bookRawFound = await findBookRaw(rawDir, b)
    if (!bookRawFound) {
      console.log(`   ✕ ${label}: 未找到下载结果，跳过后处理`)
      continue
    }
    try {
      try {
        const tocUuids = await getBookTocUuids(url, { token: config.token, key: config.key })
        const removed = await syncDeletions(bookRawFound, tocUuids)
        if (removed.length) {
          console.log(`   - ${label}: 已删除 ${removed.length} 篇: ${removed.join('、')}`)
        }
      } catch (e) {
        // TOC 获取失败时保守跳过删除同步，绝不误删
        console.log(`   ⚠ ${label}: 目录树获取失败，跳过删除同步: ${e.message}`)
      }
      const res = await postprocessBook(bookRawFound, path.join(distDir, path.basename(bookRawFound)))
      totalNotes += res
    } catch (e) {
      console.log(`   ✕ ${label}: 后处理失败: ${e.message}`)
    }
  }

  console.log(`\n√ 同步完成：${books.length} 个知识库，共处理 ${totalNotes} 篇笔记` +
    (totalBytes > 0 ? `，本次下载 ${fmtBytes(totalBytes)}` : ''))
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
