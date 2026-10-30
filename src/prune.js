import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { safePath, assertTree, atomicJson, readJson, digest, cleanOwned } from './safety.js'

// Raw cleanup uses the previous export ledger and progress; never sweep arbitrary md.
export async function syncDeletions(bookRaw, tocUuids, options = {}) {
  const { mode = 'retain', preview = false, confirmed = false } = options
  if (!confirmed || !(tocUuids instanceof Set)) return []
  await assertTree(bookRaw)
  const progressPath = await safePath(bookRaw, 'progress.json')
  const progress = await readJson(progressPath)
  if (!Array.isArray(progress)) return []
  const state = await readJson(path.join(bookRaw, '.export-state.json'), {})
  const kept = progress.filter(i => !i?.toc?.uuid || tocUuids.has(i.toc.uuid))
  const removed = progress.filter(i => i?.toc?.uuid && !tocUuids.has(i.toc.uuid))
  const activePaths = new Set(['index.md', ...kept.map(i => i.path).filter(Boolean)])
  // TITLE paths are directories; their user files must never be recursively deleted.
  const candidates = { ...state.rawFiles }
  if (!state.rawFiles && removed.length) console.log('缺少历史 raw 文件归属清单；保留旧缓存')
  const rawFiles = await cleanOwned(bookRaw, candidates, activePaths, { ...options, mode: mode === 'retain' ? 'recycle' : mode, preview })
  // Retain keeps output notes, but stale raw entries must leave progress so that
  // a reappearing remote document is downloaded again. Raw bytes go to recovery.
  if (!preview && mode !== 'legacy') {
    await atomicJson(progressPath, kept)
    if (state.version) await atomicJson(path.join(bookRaw, '.export-state.json'), { ...state, rawFiles })
  }
  return preview || mode === 'retain' || mode === 'legacy' ? [] : removed
    .filter(i => i.toc.type === 'DOC').map(i => i.toc.title || i.path)
}

export async function repairMissingRawFiles(bookRaw, bookOut) {
  const removedUuids = new Set()
  await assertTree(bookRaw)
  const progressPath = await safePath(bookRaw, 'progress.json')
  const progress = await readJson(progressPath)
  if (!Array.isArray(progress)) return removedUuids
  const state = await readJson(path.join(bookRaw, '.export-state.json'), {})
  const kept = []
  for (const item of progress) {
    const target = item?.path ? await safePath(bookRaw, item.path) : null
    let missingOutput = false
    const clean = state.notePaths?.[item?.toc?.uuid]
    if (bookOut && clean) {
      const stem = path.posix.basename(clean) === 'index.md'
        ? path.posix.basename(path.posix.dirname(clean)) : path.posix.basename(clean, '.md')
      const prefix = path.posix.join(path.posix.dirname(clean), stem + '.assets') + '/'
      for (const rel of Object.keys(state.files || {})) {
        if ((rel === clean || rel.startsWith(prefix)) && !fs.existsSync(await safePath(bookOut, rel))) missingOutput = true
      }
    }
    if (target && (!fs.existsSync(target) || missingOutput)) {
      if (item.toc?.uuid) removedUuids.add(item.toc.uuid)
    } else kept.push(item)
  }
  if (removedUuids.size) await atomicJson(progressPath, kept)
  return removedUuids
}
