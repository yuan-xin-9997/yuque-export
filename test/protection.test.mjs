import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { saveConfig, loadConfig, initConfig } from '../src/config.js'
import { atomicJson, safePath, digest, syncMode } from '../src/safety.js'
import { redact, rememberSecret, publicConfig } from '../src/secrets.js'
import { getUserBooks, getBookTocUuids } from '../src/api.js'
import { sync, runYuqueDlBook } from '../src/sync.js'
import { postprocessBook } from '../src/postprocess.js'

const U1 = 'synthetic_doc_0001'
const U2 = 'synthetic_doc_0002'
const book = { id: 1, type: 'Book', name: 'Book', slug: 'book', user: { login: 'synthetic' }, items_count: 2 }
const doc = (uuid, title) => ({ uuid, title, type: 'DOC' })
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const html = (toc, count = toc.length, extra = {}) => new Response('decodeURIComponent("' + encodeURIComponent(JSON.stringify({ me: { id: 7 }, book: { id: 1, abilities: { read: true, read_private: true, manage: true }, toc, items_count: count, ...extra } })) + '"));')
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yuque-protect-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
function remote(t, handler) {
  const previous = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => { globalThis.fetch = previous })
}
function mockBook(t, toc) {
  remote(t, async url => String(url).includes('/api/mine/books') ? response({ data: [book] }) : html(toc))
}
async function seed(root, toc = [doc(U1, 'One'), doc(U2, 'Two')]) {
  const raw = path.join(root, '.yuque-export-raw', 'Book')
  const out = path.join(root, 'Book')
  await fs.mkdir(raw, { recursive: true })
  const progress = []
  for (const item of toc) {
    const rel = `${item.title}_${item.uuid}.md`
    await fs.writeFile(path.join(raw, rel), `# ${item.title}\n`)
    progress.push({ path: rel, toc: item, contentUpdatedAt: 'synthetic-v1' })
  }
  await atomicJson(path.join(raw, 'progress.json'), progress)
  await fs.writeFile(path.join(raw, 'index.md'), '# Book\n')
  await postprocessBook(raw, out, { mode: 'mirror', confirmed: true, cleanupScope: JSON.stringify({ principal: 7, book: 1 }) })
  return { raw, out }
}
const runBook = async () => {}
const cfg = (root, mode = 'mirror') => ({ distDir: root, mode })

// Credentials are generated in memory; no real or placeholder Cookie is stored in fixtures.
test('config: first/update writes, 0600, existing permissions tightened on load', async t => {
  const root = await fixture(t)
  const file = path.join(root, 'config.json')
  const token = randomBytes(32).toString('hex')
  await saveConfig({ token, n: 1 }, file)
  assert.equal((await loadConfig(file)).token, token)
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    await fs.chmod(file, 0o644)
    await loadConfig(file)
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  }
  await saveConfig({ token, n: 2 }, file)
  assert.equal((await loadConfig(file)).n, 2)
  assert.deepEqual(await fs.readdir(root), ['config.json'])
})

test('config: failed write and abandoned interrupted temp preserve old bytes', async t => {
  const root = await fixture(t)
  const file = path.join(root, 'config.json')
  await saveConfig({ version: 1 }, file)
  const old = await fs.readFile(file, 'utf8')
  const circular = {}; circular.self = circular
  await assert.rejects(saveConfig(circular, file), /旧配置已保留/)
  assert.equal(await fs.readFile(file, 'utf8'), old)
  await fs.writeFile(file + '.interrupted.tmp', '{')
  assert.deepEqual(await loadConfig(file), { version: 1 })
  await saveConfig({ version: 2 }, file)
  assert.deepEqual(await loadConfig(file), { version: 2 })
  await fs.writeFile(file, '{bad')
  await assert.rejects(loadConfig(file), /无法读取/)
})

test('config: interrupted child during temp write leaves old config intact', async t => {
  const root = await fixture(t)
  const file = path.join(root, 'config.json')
  await saveConfig({ n: 1 }, file)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    const actualOpen = fs.open;
    fs.open = async (...args) => {
      const handle = await actualOpen(...args);
      handle.sync = async () => { process.stdout.write('READY'); await new Promise(() => { setInterval(() => {}, 1000); }); };
      return handle;
    };
    const { saveConfig } = await import('./src/config.js');
    await saveConfig({ n: 2 }, process.argv[1]);
  `, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', code => { if (code && code !== 13) reject(new Error('child failed')) })
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  await exited
  assert.deepEqual(await loadConfig(file), { n: 1 })
  await saveConfig({ n: 3 }, file)
  assert.deepEqual(await loadConfig(file), { n: 3 })
})

test('migration: new recycle, legacy review, explicit mirror and state preserved', async t => {
  const root = await fixture(t)
  const file = path.join(root, 'config.json')
  const options = { nonInteractive: true, token: randomBytes(16).toString('hex'), distDir: path.join(root, 'out'), file }
  assert.equal((await initConfig(options)).mode, 'recycle')
  await saveConfig({ token: options.token, distDir: options.distDir, mirror: true, custom: 7 }, file)
  assert.equal((await initConfig({ ...options })).mode, 'mirror')
  assert.equal((await loadConfig(file)).custom, 7)
  await saveConfig({ token: options.token, distDir: options.distDir }, file)
  assert.equal((await initConfig(options)).mode, 'legacy')
  assert.equal(syncMode({ mirror: false }), 'retain')
  assert.throws(() => syncMode({ mode: 'typo' }))
})

test('redaction: full and encoded secrets, no token prefix', () => {
  const secret = randomBytes(20).toString('base64')
  rememberSecret(secret)
  const text = redact(secret + '\n' + encodeURIComponent(secret) + '\nCookie: a=b')
  assert.ok(!text.includes(secret))
  assert.ok(!text.includes(encodeURIComponent(secret)))
  assert.ok(!text.includes('a=b'))
})

test('API: missing/malformed data, 401, 403, HTML, network errors cannot masquerade as empty', async t => {
  const values = [() => response({}), () => response({ data: {} }), () => response({ data: [], error: 'bad' }),
    () => response({ data: [], total: 1 }), () => new Response('login'),
    () => new Response('', { status: 401 }), () => new Response('', { status: 403 }),
    () => { throw new Error('network') }]
  for (const value of values) {
    await t.test('reject abnormal listing', async sub => {
      remote(sub, async () => value())
      await assert.rejects(getUserBooks({}))
    })
  }
})

test('API: repeated/partial pages rejected; syntactically valid empty list allowed without deletion', async t => {
  remote(t, async () => response({ data: Array.from({ length: 50 }, (_, i) => ({ ...book, id: i + 1 })) }))
  await assert.rejects(getUserBooks({}), /分页重复/)
})

test('TOC: identity, missing uuid, duplicate, count mismatch, missing count, empty and HTTP distinctions', async t => {
  const invalid = [() => html([doc(U1, 'One')], 2), () => html([], 0, { items_count: undefined }),
    () => html([doc(U1, 'One'), doc(U1, 'Two')]), () => html([doc('', 'missing')]),
    () => html([], 0, { id: 2 }), () => new Response('', { status: 401 }),
    () => new Response('', { status: 403 }), () => new Response('', { status: 404 }), () => new Response('login')]
  for (const make of invalid) await t.test('unverifiable TOC', async sub => {
    remote(sub, async () => make())
    await assert.rejects(getBookTocUuids('https://synthetic.invalid/book', { bookId: 1 }))
  })
  remote(t, async () => html([], 0))
  assert.equal((await getBookTocUuids('https://synthetic.invalid/book', { bookId: 1 })).size, 0)
})

for (const mode of ['mirror', 'recycle', 'retain', 'legacy']) {
  test(`sync ${mode}: deletion and user-file protection with repeat sync`, async t => {
    const root = await fixture(t)
    const { out } = await seed(root)
    await fs.writeFile(path.join(out, 'personal.md'), 'USER')
    await fs.mkdir(path.join(out, 'empty-user-dir'))
    mockBook(t, [doc(U1, 'One')])
    await sync(cfg(root, mode), { runBook })
    assert.equal(await fs.readFile(path.join(out, 'One.md'), 'utf8'), '# One\n')
    assert.equal(await fs.readFile(path.join(out, 'personal.md'), 'utf8'), 'USER')
    assert.ok((await fs.stat(path.join(out, 'empty-user-dir'))).isDirectory())
    if (['retain', 'legacy'].includes(mode)) assert.equal(await fs.readFile(path.join(out, 'Two.md'), 'utf8'), '# Two\n')
    else await assert.rejects(fs.access(path.join(out, 'Two.md')))
    if (mode === 'recycle') {
      const bins = await fs.readdir(path.join(out, '.yuque-export-trash'))
      assert.equal(await fs.readFile(path.join(out, '.yuque-export-trash', bins[0], 'Two.md'), 'utf8'), '# Two\n')
    }
    await sync(cfg(root, mode), { runBook })
    assert.equal(await fs.readFile(path.join(out, 'personal.md'), 'utf8'), 'USER')
  })
}

test('sync: empty complete TOC removes owned documents, preserving user file', async t => {
  const root = await fixture(t)
  const { out } = await seed(root)
  await fs.writeFile(path.join(out, 'user.txt'), 'USER')
  mockBook(t, [])
  await sync(cfg(root), { runBook })
  await assert.rejects(fs.access(path.join(out, 'One.md')))
  await assert.rejects(fs.access(path.join(out, 'Two.md')))
  assert.equal(await fs.readFile(path.join(out, 'user.txt'), 'utf8'), 'USER')
})

test('sync: missing whole book and empty account list retain raw, output and user files', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root)
  await atomicJson(path.join(root, '.yuque-export-owner.json'), { version: 1, root, books: { 1: { name: 'Book' } } })
  await fs.writeFile(path.join(out, 'user.txt'), 'USER')
  remote(t, async () => response({ data: [] }))
  await sync(cfg(root), { runBook })
  assert.equal(await fs.readFile(path.join(out, 'One.md'), 'utf8'), '# One\n')
  assert.ok((await fs.stat(path.join(raw, 'progress.json'))).isFile())
  assert.equal(await fs.readFile(path.join(out, 'user.txt'), 'utf8'), 'USER')
})

test('sync: incomplete, expired or changed TOC cannot trigger downstream cleanup', async t => {
  for (const kind of ['partial', 'auth', 'format', 'changed-after-download', 'download-failed']) await t.test(kind, async sub => {
    const root = await fixture(sub)
    const { out } = await seed(root)
    let count = 0
    remote(sub, async url => {
      if (String(url).includes('/api/mine/books')) return response({ data: [book] })
      count++
      if (kind === 'auth') return new Response('', { status: 401 })
      if (kind === 'format') return new Response('html')
      if (kind === 'partial') return html([], 2)
      return html(count === 1 ? [doc(U1, 'One')] : [])
    })
    await sync(cfg(root), { runBook: kind === 'download-failed' ? async () => { throw new Error('failed') } : runBook })
    assert.equal(await fs.readFile(path.join(out, 'Two.md'), 'utf8'), '# Two\n')
  })
})

test('preview: lists owned deletions, no file or state changes', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root)
  const before = await fs.readFile(path.join(raw, '.export-state.json'), 'utf8')
  const progress = await fs.readFile(path.join(raw, 'progress.json'), 'utf8')
  mockBook(t, [doc(U1, 'One')])
  const messages = []; const log = console.log
  console.log = (...args) => messages.push(args.join(' '))
  try { await sync({ ...cfg(root), preview: true }, { runBook: () => { throw new Error('must not download') } }) }
  finally { console.log = log }
  assert.ok(messages.some(line => line.includes('预览 删除: Two.md')))
  assert.equal(await fs.readFile(path.join(raw, '.export-state.json'), 'utf8'), before)
  assert.equal(await fs.readFile(path.join(raw, 'progress.json'), 'utf8'), progress)
  assert.equal(await fs.readFile(path.join(out, 'Two.md'), 'utf8'), '# Two\n')
  await assert.rejects(fs.access(path.join(root, '.yuque-export-owner.json')))
})

test('ownership: modified notes/assets and unregistered legacy files survive mirror', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root)
  await fs.writeFile(path.join(out, 'Two.md'), 'LOCAL EDIT')
  await fs.writeFile(path.join(out, 'historical.md'), 'HISTORY')
  mockBook(t, [doc(U1, 'One')])
  await sync(cfg(root), { runBook })
  assert.equal(await fs.readFile(path.join(out, 'Two.md'), 'utf8'), 'LOCAL EDIT')
  assert.equal(await fs.readFile(path.join(out, 'historical.md'), 'utf8'), 'HISTORY')
  const state = JSON.parse(await fs.readFile(path.join(raw, '.export-state.json')))
  assert.notEqual(state.files['Two.md'], await digest(path.join(out, 'Two.md')))
})

test('legacy version-only state: no stale sweep; matching files adopted and custom files retained', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root)
  await atomicJson(path.join(raw, '.export-state.json'), { version: 2 })
  await fs.writeFile(path.join(out, 'old-user.md'), 'USER')
  mockBook(t, [doc(U1, 'One'), doc(U2, 'Two')])
  await sync(cfg(root), { runBook })
  assert.equal(await fs.readFile(path.join(out, 'old-user.md'), 'utf8'), 'USER')
  assert.equal(JSON.parse(await fs.readFile(path.join(raw, '.export-state.json'))).version, 3)
})

test('paths: traversal and foreign ownership rejected; external sentinel remains untouched', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root)
  const sentinel = path.join(root, 'sentinel.txt')
  await fs.writeFile(sentinel, 'EXTERNAL')
  for (const rel of ['../sentinel.txt', '/etc/passwd', 'C:\\sentinel.txt', 'x/../../sentinel.txt', 'x/../sentinel.txt']) {
    await assert.rejects(safePath(out, rel))
  }
  mockBook(t, [])
  await atomicJson(path.join(raw, 'progress.json'), [{ path: '../../../sentinel.txt', toc: doc(U1, 'bad') }])
  await assert.rejects(sync(cfg(root), { runBook }), /路径/)
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'EXTERNAL')
  await atomicJson(path.join(root, '.yuque-export-owner.json'), { version: 1, root: out, books: {} })
  await assert.rejects(sync(cfg(root), { runBook }), /归属/)
  await assert.rejects(sync(cfg(os.homedir()), { runBook }), /危险/)
})

test('links: directory junction/symlink rejects sync, preserving external sentinel', async t => {
  const root = await fixture(t)
  const outside = await fixture(t)
  const { out } = await seed(root)
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'EXTERNAL')
  const link = path.join(out, 'external-link')
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  mockBook(t, [])
  await assert.rejects(sync(cfg(root), { runBook }), /链接|junction/)
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'EXTERNAL')
  await fs.unlink(link)
})

test('resource repair: missing exported asset invalidates progress and downloader restores bytes', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root, [doc(U1, 'One')])
  const asset = path.join(raw, 'img', U1, 'one.png')
  await fs.mkdir(path.dirname(asset), { recursive: true })
  await fs.writeFile(asset, 'IMAGE')
  await fs.writeFile(path.join(raw, `One_${U1}.md`), `![one](img/${U1}/one.png)`)
  await postprocessBook(raw, out, { mode: 'mirror', confirmed: true })
  await fs.unlink(path.join(out, 'One.assets', 'one.png'))
  mockBook(t, [doc(U1, 'One')])
  await sync(cfg(root), { runBook: async () => {
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(raw, 'progress.json'))), [])
    await fs.mkdir(path.dirname(asset), { recursive: true })
    await fs.writeFile(asset, 'RESTORED')
    await atomicJson(path.join(raw, 'progress.json'), [{ path: `One_${U1}.md`, toc: doc(U1, 'One') }])
  } })
  assert.equal(await fs.readFile(path.join(out, 'One.assets', 'one.png'), 'utf8'), 'RESTORED')
})


test('upstream: ERROR with zero exit rejects; split/encoded diagnostics never echo credentials', async t => {
  const root = await fixture(t)
  const secret = randomBytes(24).toString('base64')
  rememberSecret(secret)
  const bin = path.join(root, 'fake.cjs')
  await fs.writeFile(bin, 'process.stdout.write(process.env.SYNTHETIC_LOG); process.stderr.write("[ERROR] synthetic failure\\n");')
  const logs = []
  const old = process.env.SYNTHETIC_LOG
  process.env.SYNTHETIC_LOG = secret + '\n' + encodeURIComponent(secret) + '\n'
  try { await assert.rejects(runYuqueDlBook('https://synthetic.invalid', [], { bin, onLine: line => logs.push(line) })) }
  finally { if (old === undefined) delete process.env.SYNTHETIC_LOG; else process.env.SYNTHETIC_LOG = old }
  assert.ok(logs.length)
  assert.ok(!logs.join('').includes(secret))
  assert.ok(!logs.join('').includes(encodeURIComponent(secret)))
  assert.deepEqual(publicConfig({ token: secret, headers: { Cookie: secret } }), { token: '[REDACTED]', headers: { Cookie: '[REDACTED]' } })
})

test('permission/identity changes preserve all documents and skip downloader', async t => {
  for (const variant of ['identity', 'permissions']) await t.test(variant, async sub => {
    const root = await fixture(sub)
    const { out } = await seed(root)
    remote(sub, async url => {
      if (String(url).includes('/api/mine/books')) return response({ data: [book] })
      if (variant === 'permissions') return html([], 0, { abilities: { read: true } })
      const text = await html([]).text()
      return new Response(text.replace(encodeURIComponent('"id":7'), encodeURIComponent('"id":8')))
    })
    await sync(cfg(root), { runBook: () => { throw new Error('must not download after scope change') } })
    assert.equal(await fs.readFile(path.join(out, 'Two.md'), 'utf8'), '# Two\n')
  })
})

test('download reports success but omits active document: no raw/output cleanup', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root)
  mockBook(t, [doc(U1, 'One')])
  await sync(cfg(root), { runBook: async () => {
    await atomicJson(path.join(raw, 'progress.json'), [])
  } })
  assert.equal(await fs.readFile(path.join(out, 'Two.md'), 'utf8'), '# Two\n')
  assert.ok((await fs.stat(path.join(raw, 'Two_' + U2 + '.md'))).isFile())
})

test('raw user markdown and unreferenced resource are preserved', async t => {
  const root = await fixture(t)
  const { raw } = await seed(root)
  await fs.writeFile(path.join(raw, 'personal.md'), 'RAW USER')
  await fs.mkdir(path.join(raw, 'img', U1), { recursive: true })
  await fs.writeFile(path.join(raw, 'img', U1, 'personal.bin'), 'USER ASSET')
  mockBook(t, [doc(U1, 'One')])
  await sync(cfg(root), { runBook })
  await sync(cfg(root), { runBook })
  assert.equal(await fs.readFile(path.join(raw, 'personal.md'), 'utf8'), 'RAW USER')
  assert.equal(await fs.readFile(path.join(raw, 'img', U1, 'personal.bin'), 'utf8'), 'USER ASSET')
})

test('note rename preserves asset bytes after raw cache reclamation', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root, [doc(U1, 'One')])
  const source = path.join(raw, 'img', U1, 'image.png')
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, 'IMAGE')
  await fs.writeFile(path.join(raw, 'One_' + U1 + '.md'), '![](img/' + U1 + '/image.png)')
  await postprocessBook(raw, out, { mode: 'mirror', confirmed: true })
  await assert.rejects(fs.access(source))
  mockBook(t, [doc(U1, 'Renamed')])
  await sync(cfg(root), { runBook: async () => {
    await fs.writeFile(path.join(raw, 'Renamed_' + U1 + '.md'), '![](img/' + U1 + '/image.png)')
    await atomicJson(path.join(raw, 'progress.json'), [{ path: 'Renamed_' + U1 + '.md', toc: doc(U1, 'Renamed') }])
  } })
  assert.equal(await fs.readFile(path.join(out, 'Renamed.assets', 'image.png'), 'utf8'), 'IMAGE')
  assert.match(await fs.readFile(path.join(out, 'Renamed.md'), 'utf8'), /Renamed.assets\/image.png/)
  await assert.rejects(fs.access(path.join(out, 'One.md')))
})

test('modified asset is not adopted on unchanged sync and survives later mirror removal', async t => {
  const root = await fixture(t)
  const { raw, out } = await seed(root, [doc(U1, 'One')])
  const source = path.join(raw, 'img', U1, 'image.png')
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, 'IMAGE')
  await fs.writeFile(path.join(raw, 'One_' + U1 + '.md'), '![](img/' + U1 + '/image.png)')
  await postprocessBook(raw, out, { mode: 'mirror', confirmed: true })
  await fs.writeFile(path.join(out, 'One.assets', 'image.png'), 'LOCAL ASSET')
  mockBook(t, [doc(U1, 'One')])
  await sync(cfg(root), { runBook })
  globalThis.fetch = async url => String(url).includes('/api/mine/books') ? response({ data: [book] }) : html([])
  await sync(cfg(root), { runBook })
  assert.equal(await fs.readFile(path.join(out, 'One.assets', 'image.png'), 'utf8'), 'LOCAL ASSET')
})

test('config write failure before rename never removes old destination', async t => {
  const root = await fixture(t)
  const file = path.join(root, 'config.json')
  await saveConfig({ n: 1 }, file)
  const rename = fs.rename
  fs.rename = async () => { throw new Error('synthetic disk failure') }
  try { await assert.rejects(saveConfig({ n: 2 }, file), /旧配置已保留/) }
  finally { fs.rename = rename }
  assert.deepEqual(await loadConfig(file), { n: 1 })
  assert.deepEqual(await fs.readdir(root), ['config.json'])
})

test('config hardlink is rejected without changing external bytes or permissions', async t => {
  const root = await fixture(t)
  const source = path.join(root, 'external.json')
  const file = path.join(root, 'config.json')
  await fs.writeFile(source, '{"n":1}')
  const mode = (await fs.stat(source)).mode
  await fs.link(source, file)
  await assert.rejects(saveConfig({ n: 2 }, file))
  assert.equal(await fs.readFile(source, 'utf8'), '{"n":1}')
  assert.equal((await fs.stat(source)).mode, mode)
})
