import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { sanitize, readdirSorted, toMdLink } from './util.js'
import { redact } from './secrets.js'
import { safePath, assertTree, atomicJson, readJson, digest, cleanOwned } from './safety.js'

/**
 * 后处理单个知识库：把 yuque-dl 的原始输出（`标题_<uuid>.md` 命名、
 * `img/<uuid>/`、`attachments/<uuid>/` 资源目录）转换为干净结构：
 * - 纯标题命名，同名自动加序号
 * - 每篇笔记的资源放在同名的 `<笔记>.assets/` 目录中
 * - markdown 内资源引用、index.md 内文档链接均改写为相对路径
 * 仅复制有变化的文件，并清理输出目录中已不存在于源的陈旧文件。
 * 空间优化：笔记成功导出后，删除其在 raw 中的资源副本（输出目录是唯一拷贝），
 * raw 只保留 md 与 progress.json 供增量判断使用。
 * @param {string} bookRaw yuque-dl 原始输出目录（md/progress.json 保留，资源按需清理）
 * @param {string} bookOut 干净输出目录
 * @returns {Promise<number>} 处理的笔记数
 */

/** 后处理逻辑版本：逻辑变更时提升，触发一次全量重扫描 */
const LOGIC_VERSION = 3

export async function postprocessBook(bookRaw, bookOut, options = {}) {
  const { mode = 'retain', confirmed = false, preview = false } = options
  await assertTree(bookRaw)
  await assertTree(bookOut)
  if (!fs.existsSync(bookRaw)) return 0

  // 1. 建立 raw 相对路径 -> clean 相对路径 映射（仅 md 文件与目录）
  const fileMap = new Map()
  const uuids = await loadUuids(bookRaw)
  const uuidByPath = await loadUuidByPath(bookRaw)
  await buildMaps(bookRaw, '', '', fileMap, uuids)

  // 状态文件记录后处理逻辑版本；版本变化时全量重扫（防止旧逻辑输出被跳过）
  const stateFile = path.join(bookRaw, '.export-state.json')
  const state = await readJson(stateFile, {})
  if (state.output && state.output !== path.resolve(bookOut)) throw new Error('输出目录归属不匹配；保留已有数据')
  const owned = state.files || {}
  const fullScan = state.version !== LOGIC_VERSION
  if (!state.files) console.log('      首次建立文件归属清单；未登记的旧文件保留')
  if (preview) {
    const planned = new Set(['index.md'])
    for (const [uuid, rel] of Object.entries(state.notePaths || {})) {
      if (options.tocUuids && !options.tocUuids.has(uuid)) continue
      planned.add(rel)
      const name = assetsNameFor(rel)
      const prefix = path.posix.join(path.posix.dirname(rel), name || '') + '/'
      for (const asset of Object.keys(owned)) if (asset.startsWith(prefix)) planned.add(asset)
    }
    if (confirmed) await cleanOwned(bookOut, owned, planned, options)
    return fileMap.size
  }

  // 2. 逐个 md 处理，收集输出的全部文件（含资源），keepSet 用于镜像清理
  const keepSet = new Set()
  const errors = []
  let noteCount = 0
  const copiedRaw = new Map()
  const produced = new Set()
  const notePaths = {}

  for (const [rawRel, cleanRel] of fileMap) {
    const rawAbs = path.join(bookRaw, rawRel)
    const outAbs = await safePath(bookOut, cleanRel)
    const uuid = uuidByPath.get(rawRel)
    if (uuid) notePaths[uuid] = cleanRel
    try {
      // 未变化的笔记（输出 mtime 与 raw 一致）直接跳过，避免重复处理
      if (!fullScan && owned[cleanRel] && await isNoteUnchanged(rawAbs, outAbs) &&
          await digest(outAbs) === owned[cleanRel] && await assetsPresent(bookOut, owned, cleanRel)) {
        keepSet.add(cleanRel)
        await keepExistingAssets(bookOut, cleanRel, keepSet, owned)
        noteCount++
        continue
      }
      const prevContent = await readFileOrNull(outAbs)
      await processNote({ bookRaw, bookOut, rawRel, cleanRel, fileMap, keepSet, prevContent, owned, copiedRaw, produced, previousRel: state.notePaths?.[uuid] })
      noteCount++
      // 导出成功：删除 raw 中该笔记的资源副本（输出目录已是完整拷贝）
      // Raw copies are collected only after a verified successful copy.
    } catch (e) {
      // 单篇失败（如被杀毒软件隔离、文件损坏）不中断整个知识库的处理
      errors.push({ rawRel, msg: e.message })
    }
  }

  if (errors.length) {
    console.log(`      失败 ${errors.length} 篇（后处理）:`)
    for (const err of errors) console.log(redact(`        ${err.rawRel}: ${err.msg}`))
  }

  // Any processing failure blocks cleanup and preserves the last good ledger.
  let files = { ...owned }
  if (confirmed && !errors.length) files = await cleanOwned(bookOut, owned, keepSet, options)
  for (const rel of keepSet) {
    const target = await safePath(bookOut, rel)
    const hash = await digest(target)
    if (!owned[rel] || produced.has(rel) || hash === owned[rel]) files[rel] = hash
  }
  const rawFiles = {}
  for (const rel of fileMap.keys()) {
    if (uuidByPath.has(rel) || rel === 'index.md') rawFiles[rel] = await digest(await safePath(bookRaw, rel))
  }
  await atomicJson(stateFile, { ...state, version: LOGIC_VERSION, output: path.resolve(bookOut), files, rawFiles, notePaths, cleanupScope: options.cleanupScope ?? state.cleanupScope })
  // The durable ledger is saved before reclaiming verified raw copies.
  if (!errors.length) await cleanOwned(bookRaw, Object.fromEntries(copiedRaw), new Set(), { mode: 'mirror', report: () => {} })

  return noteCount
}

/** 笔记是否未变化：输出 md 的 mtime 与 raw md 一致（writeIfChanged 会同步 mtime） */
async function isNoteUnchanged(rawAbs, outAbs) {
  try {
    const [r, o] = await Promise.all([fsp.stat(rawAbs), fsp.stat(outAbs)])
    return Math.abs(r.mtimeMs - o.mtimeMs) < 10
  } catch {
    return false
  }
}

/** 跳过未变化笔记时，把输出中既有的资源文件登记进 keepSet（防被 pruneStale 清理） */
async function keepExistingAssets(bookOut, cleanRel, keepSet, owned) {
  const name = assetsNameFor(cleanRel)
  if (!name) return
  const dir = path.join(bookOut, path.posix.dirname(cleanRel), name)
  if (!fs.existsSync(dir)) return
  await (async function walk(d) {
    for (const e of await readdirSorted(d)) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) await walk(abs)
      else {
        const rel = path.relative(bookOut, abs).split(path.sep).join('/')
        if (owned[rel]) keepSet.add(rel)
      }
    }
  })(dir)
}

/** 笔记的资源目录名（index.md 用所属目录名；知识库根目录的 index.md 无资源） */
function assetsNameFor(cleanRel) {
  const base = path.posix.basename(cleanRel)
  const isIndex = base === 'index.md'
  if (isIndex && !cleanRel.includes('/')) return null
  return isIndex
    ? `${path.posix.basename(path.posix.dirname(cleanRel))}.assets`
    : `${base.replace(/\.md$/, '')}.assets`
}

async function assetsPresent(bookOut, owned, cleanRel) {
  const name = assetsNameFor(cleanRel)
  if (!name) return true
  const prefix = path.posix.join(path.posix.dirname(cleanRel), name) + '/'
  for (const rel of Object.keys(owned)) {
    if (rel.startsWith(prefix) && !fs.existsSync(await safePath(bookOut, rel))) return false
  }
  return true
}

async function readFileOrNull(p) {
  try {
    return await fsp.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

/** 处理单篇笔记（被 postprocessBook 调用，错误向上抛由其汇总） */
async function processNote({ bookRaw, bookOut, rawRel, cleanRel, fileMap, keepSet, prevContent, owned, copiedRaw, produced, previousRel }) {
  const rawAbs = path.join(bookRaw, rawRel)
  let content = await fsp.readFile(rawAbs, 'utf-8')

  const assetsName = assetsNameFor(cleanRel)

  // 改写 img/<uuid>/、attachments/<uuid>/ 资源引用，资源复制到 .assets
  if (assetsName) {
    content = await relocateAssets(content, {
      bookRaw,
      bookOut,
      rawRel,
      cleanRel,
      assetsName,
      keepSet,
      prevContent, owned, copiedRaw, produced, previousRel,
    })
  }

  // index.md 中指向其他笔记的链接（raw 路径 -> clean 路径）
  if (path.posix.basename(cleanRel) === 'index.md') content = rewriteDocLinks(content, fileMap)

  const outAbs = path.join(bookOut, cleanRel)
  await fsp.mkdir(path.dirname(outAbs), { recursive: true })
  await assertWritable(bookOut, cleanRel, owned, Buffer.from(content))
  await writeIfChanged(outAbs, content, rawAbs)
  keepSet.add(cleanRel)
  produced.add(cleanRel)
}

/** 从 progress.json 读取全部 toc uuid（用于精确剥离文件名后缀） */
async function loadUuids(bookRaw) {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(bookRaw, 'progress.json'), 'utf-8'))
    const uuids = new Set(info.map((i) => i?.toc?.uuid).filter(Boolean))
    return uuids.size ? uuids : null
  } catch {
    return null
  }
}

/** 从 progress.json 建立 md 路径 -> doc uuid 映射（用于清理 raw 资源副本） */
async function loadUuidByPath(bookRaw) {
  const map = new Map()
  try {
    const info = JSON.parse(await fsp.readFile(path.join(bookRaw, 'progress.json'), 'utf-8'))
    for (const item of info) {
      if (item?.path && item?.toc?.uuid) map.set(item.path, item.toc.uuid)
    }
  } catch { /* 忽略 */ }
  return map
}

/**
 * 剥离 yuque-dl 文件名中的 `_<uuid>` 后缀。
 * 优先用 progress.json 中的精确 uuid 集合匹配；缺失时退化为长度启发式。
 */
function stripUuid(name, uuids, isFile) {
  if (uuids) {
    for (const uuid of uuids) {
      if (name.endsWith('_' + uuid)) {
        return name.slice(0, name.length - uuid.length - 1)
      }
      if (isFile && name.endsWith('_' + uuid + '.md')) {
        // 去掉 `_<uuid>.md` 共 uuid.length+4 个字符，保留 `.md`
        return name.slice(0, name.length - uuid.length - 4) + '.md'
      }
    }
    return name
  }
  return isFile
    ? name.replace(/_[A-Za-z0-9_-]{15,24}\.md$/, '.md')
    : name.replace(/_[A-Za-z0-9_-]{15,24}$/, '')
}

/** 递归扫描，登记 md 文件 raw -> clean 映射 */
async function buildMaps(bookRaw, rawDir, cleanDir, fileMap, uuids) {
  const entries = await readdirSorted(path.join(bookRaw, rawDir))
  const used = new Set() // 当前 clean 目录已占用名（Windows 不区分大小写）

  const planned = []
  for (const e of entries) {
    if (e.name === 'progress.json' || e.name.startsWith('.')) continue
    if (e.isDirectory() && (e.name === 'img' || e.name === 'attachments')) continue // 资源缓存，按需取用
    const clean = dedupe(sanitize(stripUuid(e.name, uuids, e.isFile())), used)
    used.add(clean.toLowerCase())
    planned.push({ entry: e, clean })
  }

  for (const { entry, clean } of planned) {
    const rawRel = rawDir ? `${rawDir}/${entry.name}` : entry.name
    const cleanRel = cleanDir ? `${cleanDir}/${clean}` : clean
    if (entry.isDirectory()) {
      await buildMaps(bookRaw, rawRel, cleanRel, fileMap, uuids)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      fileMap.set(rawRel, cleanRel)
    }
  }
}

/** 同名冲突时追加序号：标题、标题 (2)、标题 (3)… */
function dedupe(name, used) {
  if (!used.has(name.toLowerCase())) return name
  const m = name.match(/^(.*?)(\.[^.]+)$/)
  const base = m ? m[1] : name
  const ext = m ? m[2] : ''
  let i = 2
  while (used.has(`${base} (${i})${ext}`.toLowerCase())) i++
  return `${base} (${i})${ext}`
}

/**
 * 改写 md 中相对引用的 img/、attachments/ 资源链接：
 * 将资源复制到 `<笔记>.assets/`，并把链接改为指向新位置的相对路径。
 * 安全网：若 raw 中的资源已被清理（笔记未变化或历史版本处理过），
 * 沿用输出目录中仍存在的既有引用，避免链接失效。
 */
async function relocateAssets(content, { bookRaw, bookOut, rawRel, cleanRel, assetsName, keepSet, owned, copiedRaw, produced, previousRel }) {
  const rawMdDir = path.posix.dirname(rawRel)
  const cleanMdDir = path.posix.dirname(cleanRel)
  const outAssetsRel = path.posix.join(cleanMdDir, assetsName)
  const names = new Map()
  const refs = []
  content = content.replace(/(!?\[[^\]]*\]\(\s*)([^)\s]+)([^)]*\))/g, (full, pre, ref, post) => {
    refs.push(ref)
    return pre + '\x00' + (refs.length - 1) + '\x00' + post
  })
  const rewritten = []
  for (const ref of refs) {
    const match = ref.match(/^\.?\/?(img|attachments)\/(.+)$/)
    if (!match) { rewritten.push(ref); continue }
    const assetPath = decodeURIComponent(match[2].replace(/\\/g, '/'))
    const rawAssetAbs = await safePath(bookRaw, path.posix.join(rawMdDir, match[1]) + '/' + assetPath)
    let outName = names.get(assetPath)
    if (!outName) {
      const orig = path.posix.basename(assetPath)
      outName = orig
      let i = 2
      const ext = path.posix.extname(orig)
      while ([...names.values()].some(n => n.toLowerCase() === outName.toLowerCase())) {
        outName = orig.slice(0, orig.length - ext.length) + '-' + i++ + ext
      }
      names.set(assetPath, outName)
    }
    const outRel = path.posix.join(outAssetsRel, outName)
    const outAbs = await safePath(bookOut, outRel)
    let source = rawAssetAbs
    if (!fs.existsSync(source)) {
      const prior = previousRel || cleanRel
      source = await safePath(bookOut, path.posix.join(path.posix.dirname(prior), assetsNameFor(prior), outName))
      if (!fs.existsSync(source)) throw new Error('资源缺失；保留已有输出，等待重新下载')
    }
    await assertWritable(bookOut, outRel, owned, await fsp.readFile(source))
    await fsp.mkdir(path.dirname(outAbs), { recursive: true })
    if (source !== outAbs) await copyIfChanged(source, outAbs)
    if (source === rawAssetAbs) copiedRaw.set(path.relative(bookRaw, source).split(path.sep).join('/'), await digest(outAbs))
    keepSet.add(outRel)
    produced.add(outRel)
    rewritten.push(toMdLink(path.posix.relative(cleanMdDir, outRel)))
  }
  return content.replace(/\x00(\d+)\x00/g, (full, idx) => rewritten[Number(idx)])
}

/** index.md 中指向其他笔记的链接改写（uuid 命名 -> 干净命名）；指向已删除文档的死链降级为纯文本 */
function rewriteDocLinks(content, fileMap) {
  return content.replace(/(\[([^\]]*)\]\(\s*)([^)\s]+)(\s*(?: "[^"]*")?\))/g, (full, pre, text, ref, post) => {
    if (/^https?:/.test(ref)) return full
    const decoded = ref.replace(/%20/g, ' ').replace(/^\.\//, '')
    const clean = fileMap.get(decoded)
    if (clean) return `${pre}${toMdLink(clean)}${post}`
    if (decoded.endsWith('.md')) return text // 文档已删除：保留标题文字，去掉死链
    return full
  })
}

/** 二进制文件复制（内容有变化才写，并保留源文件 mtime 供下次比对） */
async function copyIfChanged(srcAbs, dstAbs) {
  const [srcStat] = await Promise.all([fsp.stat(srcAbs)])
  let same = false
  try {
    const dstStat = await fsp.stat(dstAbs)
    same = dstStat.size === srcStat.size && Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 10
  } catch { /* 不存在 */ }
  if (same) return
  await fsp.copyFile(srcAbs, dstAbs)
  await fsp.utimes(dstAbs, srcStat.atime, srcStat.mtime)
}

/** 文本文件写入（内容不同才写，保留源 mtime） */
async function writeIfChanged(dstAbs, content, srcAbs) {
  const srcStat = await fsp.stat(srcAbs)
  let same = false
  try {
    same = (await fsp.readFile(dstAbs, 'utf-8')) === content
  } catch { /* 不存在 */ }
  if (same) {
    await fsp.utimes(dstAbs, srcStat.atime, srcStat.mtime)
    return
  }
  await fsp.writeFile(dstAbs, content, 'utf-8')
  await fsp.utimes(dstAbs, srcStat.atime, srcStat.mtime)
}

async function assertWritable(root, rel, owned, bytes) {
  const target = await safePath(root, rel)
  if (!fs.existsSync(target)) return
  const current = await fsp.readFile(target)
  if (current.equals(bytes)) return
  if (!owned[rel] || await digest(target) !== owned[rel]) {
    throw new Error('目标为未登记文件或本地修改；请先移走冲突文件')
  }
}
