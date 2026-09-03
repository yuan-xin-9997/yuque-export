import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 按服务端 TOC（当前目录树）同步删除：
 * - progress.json 中不在 TOC 的条目 = 语雀端已删除的文档 → 删除其 raw md 与资源副本，并从 progress 移除
 * - raw 中不在 progress 路径集合中的 md（改名遗留的旧文件、下载残留）→ 删除
 * - 清理删除后产生的空目录
 * @param {string} bookRaw 知识库的 raw 目录
 * @param {Set<string>} tocUuids 服务端 TOC 的 uuid 集合
 * @returns {Promise<string[]>} 被移除文档的标题列表
 */
export async function syncDeletions(bookRaw, tocUuids) {
  const progressPath = path.join(bookRaw, 'progress.json')
  let progress
  try {
    progress = JSON.parse(await fsp.readFile(progressPath, 'utf-8'))
    if (!Array.isArray(progress)) return []
  } catch {
    return []
  }

  const kept = []
  const removed = []
  for (const item of progress) {
    if (item?.toc?.uuid && tocUuids.has(item.toc.uuid)) kept.push(item)
    else removed.push(item)
  }

  // 已删除文档：移除 raw md 与资源副本
  for (const item of removed) {
    const p = item?.path
    if (!p) continue
    await fsp.rm(path.join(bookRaw, p), { recursive: true, force: true })
    const uuid = item?.toc?.uuid
    const dir = path.posix.dirname(p)
    if (uuid) {
      await fsp.rm(path.join(bookRaw, dir, 'img', uuid), { recursive: true, force: true })
      await fsp.rm(path.join(bookRaw, dir, 'attachments', uuid), { recursive: true, force: true })
    }
  }

  // 孤儿 md：磁盘上存在但不在 progress 路径集合（改名遗留、历史残留）
  const keepPaths = new Set(kept.map((i) => i.path).filter(Boolean))
  await (async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(abs)
      } else if (e.name.endsWith('.md')) {
        const rel = path.relative(bookRaw, abs).split(path.sep).join('/')
        // 根 index.md 由 yuque-dl 每次运行重新生成，保留
        if (rel === 'index.md') continue
        if (!keepPaths.has(rel)) await fsp.rm(abs, { force: true })
      }
    }
  })(bookRaw)

  if (removed.length) {
    try {
      await fsp.writeFile(progressPath, JSON.stringify(kept))
    } catch { /* raw 目录只读时忽略 */ }
  }

  await removeEmptyDirs(bookRaw)

  return removed.map((i) => i?.toc?.title || i?.path || '').filter(Boolean)
}

/** 递归删除空目录（不删知识库根目录本身） */
async function removeEmptyDirs(dir, isRoot = true) {
  let empty = true
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) {
      const subEmpty = await removeEmptyDirs(path.join(dir, e.name), false)
      if (!subEmpty) empty = false
    } else {
      empty = false
    }
  }
  if (empty && !isRoot) {
    await fsp.rmdir(dir).catch(() => {})
    return true
  }
  return empty
}
