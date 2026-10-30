import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { redact } from './secrets.js'

// All paths read from remote responses and state files cross this boundary.
export async function safePath(root, rel = '') {
  if (rel && (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) ||
      rel.split(/[\\/]/).some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) {
    throw new Error('拒绝越界或非法路径')
  }
  const target = path.resolve(root, rel)
  const relative = path.relative(path.resolve(root), target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝越界路径')
  let cursor = path.parse(target).root
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const st = await fs.lstat(cursor).catch(e => { if (e.code !== 'ENOENT') throw e })
    if (st?.isFile() && st.nlink > 1) throw new Error('拒绝多重硬链接文件')
    if (st?.isSymbolicLink()) throw new Error('拒绝符号链接或 junction 路径')
  }
  return target
}

export async function assertTree(root) {
  await safePath(root)
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch(e => {
    if (e.code === 'ENOENT') return []
    throw e
  })) {
    const target = await safePath(root, e.name)
    if (e.isDirectory()) await assertTree(target)
  }
}

export async function validateRoot(root) {
  const resolved = path.resolve(root)
  const forbidden = [path.parse(resolved).root, os.homedir(), os.tmpdir(), process.cwd(),
    process.env.WINDIR, process.env.ProgramFiles, process.env.APPDATA, process.env.LOCALAPPDATA,
    '/etc', '/usr', '/var', '/bin', '/System', '/Library'].filter(Boolean).map(p => path.resolve(p))
  if (forbidden.some(p => p === resolved || path.relative(resolved, p) &&
      !path.relative(resolved, p).startsWith('..') && !path.isAbsolute(path.relative(resolved, p)))) {
    throw new Error('拒绝危险导出目录；请使用专用子目录')
  }
  const system = [process.env.WINDIR, process.env.ProgramFiles, '/etc', '/usr', '/bin', '/System', '/Library'].filter(Boolean)
  if (system.some(p => {
    const rel = path.relative(path.resolve(p), resolved)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }) || ['.git', 'node_modules'].includes(path.basename(resolved))) throw new Error('拒绝系统或项目内部危险目录')
  await safePath(resolved)
  return resolved
}

// Same-directory exclusive temporary file + fsync + rename: a failed/interrupted
// write leaves the old destination intact. Leftover temp files are never loaded.
export async function atomicJson(file, value, { privateFile = false } = {}) {
  await safePath(path.dirname(file), path.basename(file))
  if (privateFile && process.platform !== 'win32') {
    await fs.chmod(file, 0o600).catch(e => { if (e.code !== 'ENOENT') throw new Error('无法收紧配置权限') })
  }
  const temp = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temp, file)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

export async function readJson(file, fallback = null) {
  await safePath(path.dirname(file), path.basename(file))
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw new Error('状态或配置无法读取；保留旧文件，请先检查')
  }
}

export async function digest(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

export function syncMode(config = {}) {
  const mode = config.mode ?? (config.mirror === true ? 'mirror' : config.mirror === false ? 'retain' : 'legacy')
  if (!['retain', 'recycle', 'mirror', 'legacy'].includes(mode)) throw new Error('未知同步模式')
  return mode
}

// Only unchanged files recorded in a prior successful export are eligible.
export async function cleanOwned(root, owned, keep, { mode = 'retain', preview = false, recycleDir, report = value => console.log(redact(value)) } = {}) {
  const remaining = { ...owned }
  for (const [rel, hash] of Object.entries(owned || {})) {
    if (keep.has(rel)) continue
    const target = await safePath(root, rel)
    const st = await fs.lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e })
    if (!st) { delete remaining[rel]; continue }
    if (!st.isFile() || await digest(target) !== hash) {
      report(`保留本地修改或非文件: ${rel}`)
      continue
    }
    if (mode === 'retain' || mode === 'legacy') continue
    report(`${preview ? '预览' : '清理'} ${mode === 'mirror' ? '删除' : '回收'}: ${rel}`)
    if (preview) continue
    if (mode === 'mirror') await fs.unlink(target)
    else {
      const dest = await safePath(recycleDir || path.join(root, '.yuque-export-trash'), `${randomUUID()}/${rel}`)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.rename(target, dest)
    }
    delete remaining[rel]
    // Only remove empty ancestors of an owned file; never sweep user directories.
    let parent = path.dirname(target)
    while (parent !== path.resolve(root)) {
      try { await fs.rmdir(parent) } catch { break }
      parent = path.dirname(parent)
    }
  }
  return remaining
}
