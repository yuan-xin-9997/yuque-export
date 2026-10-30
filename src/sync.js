import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getUserBooks, filterBooks, getBookTocUuids } from './api.js'
import { postprocessBook } from './postprocess.js'
import { syncDeletions, repairMissingRawFiles } from './prune.js'
import { sanitize } from './util.js'
import { safePath, assertTree, validateRoot, atomicJson, readJson, syncMode } from './safety.js'
import { rememberSecret, redact } from './secrets.js'

const require = createRequire(import.meta.url)
const log = (...args) => console.log(...args.map(redact))

/** 缓存目录名（放在导出根目录下，存放 yuque-dl 的原始输出与增量状态） */
export const RAW_DIR_NAME = '.yuque-export-raw'

/** 统一日志缩进：详情行前缀（与 `[n/m] 知识库名` 对齐） */
const INDENT = '      '

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
    this.active = false
  }
  set(text) {
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
    if (this.onSample) this.onSample()
  }
}

/**
 * 判断是否为应抑制的 yuque-dl 日志行：
 * - "Download [===]" 逐篇进度条（检查/下载共用，无法区分）
 * - INFO 行（生成目录/已完成等，与我们的输出重复）
 * 保留 WARN/ERROR 行（下载失败详情等）透传。
 */
function isNoiseLine(line) {
  return /^Download \[/.test(line) || /\[INFO\]/.test(line)
}

/**
 * 运行 yuque-dl 下载单个知识库：
 * 抑制噪音日志，其余日志（WARN/ERROR）缩进透传。
 */
export function runYuqueDlBook(url, extraArgs, { onLine, bin = resolveYuqueDlBin() }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, url, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    let failed = false
    const handle = (chunk) => {
      buf += chunk.toString()
      const parts = buf.split(/\r|\n/)
      buf = parts.pop() // 末段可能不完整，留待下个 chunk
      for (const line of parts) {
        if (!line.trim()) continue
        if (/\[ERROR\]|✕ 失败/.test(line)) failed = true
        if (isNoiseLine(line)) continue
        onLine('yuque-dl 报告诊断信息（已隐藏原文以保护登录凭据）')
      }
    }
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('error', () => reject(new Error('无法启动 yuque-dl')))
    child.on('close', (code) => {
      if (buf.trim() && !isNoiseLine(buf)) onLine('yuque-dl 报告诊断信息（已隐藏原文以保护登录凭据）')
      if (/\[ERROR\]|✕ 失败/.test(buf)) failed = true
      if (code === 0 && !failed) resolve()
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

/** 读取 progress.json 为 uuid -> {title, type, updated} 映射（用于前后对比） */
async function readProgressMap(bookRaw) {
  const map = new Map()
  try {
    const arr = JSON.parse(await fsp.readFile(path.join(bookRaw, 'progress.json'), 'utf-8'))
    if (!Array.isArray(arr)) return map
    for (const it of arr) {
      const uuid = it?.toc?.uuid
      if (!uuid) continue
      map.set(uuid, {
        title: it.toc.title || it.path || uuid,
        type: String(it.toc.type || '').toUpperCase(),
        updated: it.contentUpdatedAt || '',
      })
    }
  } catch { /* 首次运行无 progress.json */ }
  return map
}

/** 主流程：枚举 → 过滤 → 逐库（修复缺失 → 下载 → 删除同步 → 后处理） */
export async function sync(config, { runBook = runYuqueDlBook } = {}) {
  rememberSecret(config.token)
  const mode = syncMode(config)
  if (mode === 'legacy') console.log('旧配置没有显式模式；保留数据，请预览后选择 --mode retain|recycle|mirror')
  const distDir = await validateRoot(config.distDir)
  await assertTree(distDir)
  if (!config.preview) await fsp.mkdir(distDir, { recursive: true })
  const ownerPath = path.join(distDir, '.yuque-export-owner.json')
  const owner = await readJson(ownerPath, { version: 1, root: distDir, books: {} })
  if (owner.version !== 1 || owner.root !== distDir || !owner.books || typeof owner.books !== 'object') {
    throw new Error('输出目录归属记录无效或路径已变化；拒绝同步')
  }
  const lockPath = path.join(distDir, '.yuque-export.lock')
  let lock
  try {
    if (!config.preview) {
      lock = await fsp.open(lockPath, 'wx', 0o600)
      await atomicJson(ownerPath, owner)
    }
    return await syncOwned(config, { runBook, distDir, owner, ownerPath, mode })
  } finally {
    if (lock) { await lock.close(); await fsp.unlink(lockPath) }
  }
}

async function syncOwned(config, { runBook, distDir, owner, ownerPath, mode }) {
  const rawDir = path.join(distDir, RAW_DIR_NAME)
  if (!config.preview) await fsp.mkdir(rawDir, { recursive: true })

  const allBooks = await getUserBooks({ token: config.token, key: config.key })
  const books = filterBooks(allBooks, config)
  await reportMissingBooks(owner, allBooks)
  if (books.length === 0) {
    console.log('没有匹配的知识库（检查配置中的 include/exclude）')
    return
  }

  console.log('== 同步开始 ==')
  console.log(`知识库 ${books.length} 个（账号共 ${allBooks.length} 个）`)

  // 知识库级删除同步：raw 中存在但账号已不存在的知识库 → 移除 raw 与输出
  // Account-list absence never proves deletion: permissions can change.

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
  const total = { checked: 0, added: [], updated: [], fixed: [], deleted: [], bytes: 0 }

  for (let i = 0; i < books.length; i++) {
    const b = books[i]
    const url = `https://www.yuque.com/${b.userLogin}/${b.slug}`
    const name = sanitize(b.name)
    if (!name || name.startsWith('.') || ['img', 'attachments'].includes(name.toLowerCase()) ||
        books.some(other => other.id !== b.id && sanitize(other.name).toLowerCase() === name.toLowerCase())) {
      throw new Error('知识库目录名不安全或重名；保留已有数据')
    }
    const bookRaw = await safePath(rawDir, name)
    const bookOut = await safePath(distDir, name)
    const existingOwner = Object.entries(owner.books).find(([id, entry]) => id !== String(b.id) && [entry.name, ...(entry.names || [])].some(n => n?.toLowerCase() === name.toLowerCase()))
    if (existingOwner) throw new Error('目录属于其他知识库；拒绝覆盖')
    if (owner.books[b.id]?.name !== undefined && owner.books[b.id].name !== name) {
      console.log('      知识库已改名；旧目录保留，请核对后手动归档')
    }
    console.log(`  [${i + 1}/${books.length}] ${b.name}`)

    let tocBefore
    try { tocBefore = await getBookTocUuids(url, { ...config, bookId: b.id }) }
    catch (e) { console.log('      目录不可核验，跳过此库: ' + e.message); continue }
    const previousState = await readJson(path.join(bookRaw, '.export-state.json'), {})
    const cleanupScope = tocBefore.cleanupScope
    if (previousState.cleanupScope && previousState.cleanupScope !== cleanupScope) {
      console.log('      登录身份或知识库权限变化；保留数据并跳过此库')
      continue
    }
    const scopeConfirmed = !!cleanupScope && previousState.cleanupScope === cleanupScope
    if (!scopeConfirmed) console.log('      缺少可比对的完整权限状态；本次只建立状态，不执行删除')
    if (config.preview) {
      console.log('      删除预览（只读；实际同步会重新核验）')
      const options = { mode, preview: true, confirmed: scopeConfirmed, tocUuids: tocBefore }
      await syncDeletions(bookRaw, tocBefore, options)
      await postprocessBook(bookRaw, bookOut, options)
      continue
    }
    // 下载前快照：用于对比出本次的新增/更新
    const oldProgress = await readProgressMap(bookRaw)
    // 修复：progress 记录已下载但文件缺失（如被杀毒软件隔离）→ 移除条目，本次重新下载
    const repairedUuids = await repairMissingRawFiles(bookRaw, bookOut)

    const meter = new ByteMeter(bookRaw, startTime)
    const live = new LiveLine()
    meter.onSample = () => {
      if (meter.bytes <= 0) return
      live.set(`${INDENT}下载中: ${fmtBytes(meter.bytes)} · ${fmtBytes(meter.speed)}/s`)
    }
    meter.start()
    let downloadOk = true
    try {
      await runBook(url, commonArgs, {
        onLine(line) {
          live.clear()
          process.stdout.write(`${INDENT}${redact(line)}\n`)
        },
      })
    } catch (e) {
      downloadOk = false
      console.log(`${INDENT}失败: 下载中断（${e.message}）`)
    } finally {
      meter.stop()
      await meter.sample().catch(() => {})
      live.clear()
    }
    if (!downloadOk) continue
    total.bytes += meter.bytes

    // 下载后：文档级删除同步 + 后处理
    const bookRawFound = await findBookRaw(rawDir, b)
    if (!bookRawFound) {
      console.log(`${INDENT}失败: 未找到下载结果，跳过后处理`)
      continue
    }
    let deletedTitles = []
    let confirmed = false
    try {
      const tocUuids = await getBookTocUuids(url, { ...config, bookId: b.id })
      confirmed = scopeConfirmed && cleanupScope === tocUuids.cleanupScope &&
        tocBefore.size === tocUuids.size && [...tocBefore].every(id => tocUuids.has(id))
      if (!confirmed) throw new Error('下载前后目录发生变化；本次不清理')
      await assertTree(bookRawFound)
      const progress = await readJson(path.join(bookRawFound, 'progress.json'))
      if (!Array.isArray(progress)) throw new Error('下载状态缺失；本次不清理')
      for (const uuid of tocUuids.docs) {
        const item = progress.find(i => i?.toc?.uuid === uuid)
        if (!item?.path || !fs.existsSync(await safePath(bookRawFound, item.path))) {
          confirmed = false
          throw new Error('下载结果不完整；本次不清理')
        }
      }
      deletedTitles = await syncDeletions(bookRawFound, tocUuids, { mode, confirmed })
    } catch (e) {
      confirmed = false
      // TOC 获取失败时保守跳过删除同步，绝不误删
      console.log(`${INDENT}注意: 目录树获取失败，跳过删除同步（${e.message}）`)
    }
    try {
      total.checked += await postprocessBook(bookRawFound, bookOut, { mode, confirmed, cleanupScope })
      owner.books[b.id] = { ...owner.books[b.id], name, names: [...new Set([...(owner.books[b.id]?.names || []), owner.books[b.id]?.name, name].filter(Boolean))] }
      await atomicJson(ownerPath, owner)
    } catch (e) {
      console.log(`${INDENT}失败: 后处理中断（${e.message}）`)
    }

    // 对比下载前后的 progress：得出本次新增/更新/修复
    const newProgress = await readProgressMap(bookRawFound)
    const added = []
    const updated = []
    const fixed = []
    for (const [uuid, info] of newProgress) {
      if (info.type !== 'DOC') continue
      if (repairedUuids.has(uuid)) { fixed.push(info.title); continue }
      const old = oldProgress.get(uuid)
      if (!old) added.push(info.title)
      else if (old.updated !== info.updated) updated.push(info.title)
    }

    if (added.length) console.log(`${INDENT}新增 ${added.length} 篇: ${added.join('、')}`)
    if (updated.length) console.log(`${INDENT}更新 ${updated.length} 篇: ${updated.join('、')}`)
    if (fixed.length) console.log(`${INDENT}修复 ${fixed.length} 篇（本地文件曾缺失，已重新下载）: ${fixed.join('、')}`)
    if (deletedTitles.length) console.log(`${INDENT}删除 ${deletedTitles.length} 篇: ${deletedTitles.join('、')}`)
    if (meter.bytes > 0) console.log(`${INDENT}下载: ${fmtBytes(meter.bytes)}`)
    if (!added.length && !updated.length && !fixed.length && !deletedTitles.length && meter.bytes === 0) {
      console.log(`${INDENT}无变化`)
    }
    total.added.push(...added)
    total.updated.push(...updated)
    total.fixed.push(...fixed)
    total.deleted.push(...deletedTitles)
  }

  console.log('== 同步完成 ==')
  console.log(`  检查 ${total.checked} 篇: 新增 ${total.added.length} · 更新 ${total.updated.length} · 修复 ${total.fixed.length} · 删除 ${total.deleted.length}`)
  if (total.added.length) console.log(`  新增: ${total.added.join('、')}`)
  if (total.updated.length) console.log(`  更新: ${total.updated.join('、')}`)
  if (total.fixed.length) console.log(`  修复: ${total.fixed.join('、')}`)
  if (total.deleted.length) console.log(`  删除: ${total.deleted.join('、')}`)
  if (total.bytes > 0) console.log(`  下载: ${fmtBytes(total.bytes)}`)
  console.log(`  导出目录: ${distDir}`)
  console.log(`  增量缓存: ${rawDir}（请勿删除或修改，否则增量失效）`)
}

// This API has no authoritative deletion tombstone.
async function reportMissingBooks(owner, allBooks) {
  const active = new Set(allBooks.map(b => String(b.id)))
  for (const [id, entry] of Object.entries(owner.books)) {
    if (!active.has(id)) console.log('保留整库: ' + entry.name + '（列表中消失，无法区分删除与权限/枚举变化）')
  }
}
