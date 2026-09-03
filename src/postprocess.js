import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { sanitize, readdirSorted, toMdLink } from './util.js'

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
const LOGIC_VERSION = 2

export async function postprocessBook(bookRaw, bookOut) {
  if (!fs.existsSync(bookRaw)) return 0

  // 1. 建立 raw 相对路径 -> clean 相对路径 映射（仅 md 文件与目录）
  const fileMap = new Map()
  const uuids = await loadUuids(bookRaw)
  const uuidByPath = await loadUuidByPath(bookRaw)
  await buildMaps(bookRaw, '', '', fileMap, uuids)

  // 状态文件记录后处理逻辑版本；版本变化时全量重扫（防止旧逻辑输出被跳过）
  const stateFile = path.join(bookRaw, '.export-state.json')
  let stateVersion = null
  try {
    stateVersion = JSON.parse(await fsp.readFile(stateFile, 'utf-8')).version
  } catch { /* 首次运行 */ }
  const fullScan = stateVersion !== LOGIC_VERSION

  // 2. 逐个 md 处理，收集输出的全部文件（含资源），keepSet 用于镜像清理
  const keepSet = new Set()
  const errors = []
  let noteCount = 0

  for (const [rawRel, cleanRel] of fileMap) {
    const rawAbs = path.join(bookRaw, rawRel)
    const outAbs = path.join(bookOut, cleanRel)
    try {
      // 未变化的笔记（输出 mtime 与 raw 一致）直接跳过，避免重复处理
      if (!fullScan && (await isNoteUnchanged(rawAbs, outAbs))) {
        keepSet.add(cleanRel)
        await keepExistingAssets(bookOut, cleanRel, keepSet)
        noteCount++
        continue
      }
      const prevContent = await readFileOrNull(outAbs)
      await processNote({ bookRaw, bookOut, rawRel, cleanRel, fileMap, keepSet, prevContent })
      noteCount++
      // 导出成功：删除 raw 中该笔记的资源副本（输出目录已是完整拷贝）
      await pruneRawAssets(bookRaw, rawRel, uuidByPath.get(rawRel))
    } catch (e) {
      // 单篇失败（如被杀毒软件隔离、文件损坏）不中断整个知识库的处理
      errors.push({ rawRel, msg: e.message })
    }
  }

  if (errors.length) {
    console.log(`   ⚠ 「${path.basename(bookRaw)}」有 ${errors.length} 篇笔记处理失败:`)
    for (const err of errors) console.log(`     ✕ ${err.rawRel}: ${err.msg}`)
  }

  // 3. 删除输出目录中已不存在的文件与空目录
  await pruneStale(bookOut, keepSet)

  try {
    await fsp.writeFile(stateFile, JSON.stringify({ version: LOGIC_VERSION }))
  } catch { /* 只读 raw 目录时忽略 */ }

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
async function keepExistingAssets(bookOut, cleanRel, keepSet) {
  const name = assetsNameFor(cleanRel)
  if (!name) return
  const dir = path.join(bookOut, path.posix.dirname(cleanRel), name)
  if (!fs.existsSync(dir)) return
  await (async function walk(d) {
    for (const e of await readdirSorted(d)) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) await walk(abs)
      else keepSet.add(path.relative(bookOut, abs).split(path.sep).join('/'))
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

/** 删除 raw 中该笔记的资源副本（img/<uuid>、attachments/<uuid>） */
async function pruneRawAssets(bookRaw, rawRel, uuid) {
  if (!uuid) return
  const dir = path.posix.dirname(rawRel)
  for (const kind of ['img', 'attachments']) {
    await fsp.rm(path.join(bookRaw, dir, kind, uuid), { recursive: true, force: true })
  }
}

async function readFileOrNull(p) {
  try {
    return await fsp.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

/** 处理单篇笔记（被 postprocessBook 调用，错误向上抛由其汇总） */
async function processNote({ bookRaw, bookOut, rawRel, cleanRel, fileMap, keepSet, prevContent }) {
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
      prevContent,
    })
  }

  // index.md 中指向其他笔记的链接（raw 路径 -> clean 路径）
  if (path.posix.basename(cleanRel) === 'index.md') content = rewriteDocLinks(content, fileMap)

  const outAbs = path.join(bookOut, cleanRel)
  await fsp.mkdir(path.dirname(outAbs), { recursive: true })
  await writeIfChanged(outAbs, content, rawAbs)
  keepSet.add(cleanRel)
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
    if (e.name === 'progress.json') continue
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
async function relocateAssets(content, { bookRaw, bookOut, rawRel, cleanRel, assetsName, keepSet, prevContent }) {
  const rawMdDir = path.posix.dirname(rawRel)
  const cleanMdDir = path.posix.dirname(cleanRel)
  const outAssetsRel = cleanMdDir === '.' ? assetsName : `${cleanMdDir}/${assetsName}`
  const usedAssetNames = new Map() // 原始文件名 -> 输出文件名（目录内去重）

  /** 处理单个引用路径，返回改写后的引用（无需改写时返回 null） */
  const handleRef = async (ref) => {
    try {
      const m = ref.match(/^\.?\/?(img|attachments)\/(.+)$/)
      if (!m) return null
    // yuque-dl 在 Windows 上生成的视频引用含反斜杠分隔，统一为正斜杠
    const assetPath = m[2].replace(/\\/g, '/')
    const rawAssetRel = `${rawMdDir === '.' ? '' : rawMdDir + '/'}${m[1]}/${assetPath}`
    let rawAssetAbs
    try {
      rawAssetAbs = path.join(bookRaw, decodeURIComponent(rawAssetRel))
    } catch {
      return null
    }
    if (!fs.existsSync(rawAssetAbs)) return null
    if (!(await fsp.stat(rawAssetAbs)).isFile()) return null

    const origName = path.posix.basename(decodeURIComponent(assetPath))
    let outName = usedAssetNames.get(origName)
    if (!outName) {
      const taken = new Set([...usedAssetNames.values()].map((s) => s.toLowerCase()))
      outName = origName
      let i = 2
      const dot = origName.lastIndexOf('.')
      while (taken.has(outName.toLowerCase())) {
        outName = dot > 0 ? `${origName.slice(0, dot)}-${i}${origName.slice(dot)}` : `${origName}-${i}`
        i++
      }
      usedAssetNames.set(origName, outName)
    }

    const outRel = `${outAssetsRel}/${outName}`
    const outAbs = path.join(bookOut, outRel)
    await fsp.mkdir(path.dirname(outAbs), { recursive: true })
    await copyIfChanged(rawAssetAbs, outAbs)
    keepSet.add(outRel)

    // 新引用 = 笔记位置到资源的相对路径
    const rel = path.posix.relative(cleanMdDir, outRel)
    return toMdLink(rel)
    } catch {
      return null
    }
  }

  // markdown 链接/图片语法（图片 ![]() 与附件 []()）
  const refs = []
  content = content.replace(/(!?\[[^\]]*\]\(\s*)([^)\s]+)([^)]*\))/g, (full, pre, ref, post) => {
    refs.push(ref)
    return `${pre}\x00${refs.length - 1}\x00${post}`
  })
  const rewritten = await Promise.all(refs.map(handleRef))

  // 上次输出的引用（与本次提取顺序一致），raw 资源缺失时回退沿用
  const prevRefs = []
  if (prevContent) {
    prevContent.replace(/(!?\[[^\]]*\]\(\s*)([^)\s]+)([^)]*\))/g, (full, pre, ref) => {
      prevRefs.push(ref)
      return full
    })
  }

  content = content.replace(/\x00(\d+)\x00/g, (full, idx) => {
    const i = Number(idx)
    if (rewritten[i] !== null) return rewritten[i]
    const prev = prevRefs[i]
    if (prev) {
      try {
        const target = path.resolve(
          bookOut,
          path.posix.dirname(cleanRel),
          decodeURIComponent(prev.replace(/^\.\//, '')),
        )
        if (fs.existsSync(target)) {
          keepSet.add(path.relative(bookOut, target).split(path.sep).join('/'))
          return prev
        }
      } catch { /* 引用解码失败则放弃回退 */ }
    }
    return refs[i]
  })
  return content
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

/** 删除输出目录中不在 keepSet 里的文件与空目录 */
async function pruneStale(bookOut, keepSet) {
  if (!fs.existsSync(bookOut)) return
  await (async function walk(dir) {
    for (const e of await readdirSorted(dir)) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(abs)
        // 目录内已无文件则删除
        const left = await fsp.readdir(abs)
        if (left.length === 0) await fsp.rmdir(abs)
      } else {
        const rel = path.relative(bookOut, abs).split(path.sep).join('/')
        if (!keepSet.has(rel)) await fsp.rm(abs, { force: true })
      }
    }
  })(bookOut)
}
