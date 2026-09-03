import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { postprocessBook } from '../src/postprocess.js'
import { syncDeletions } from '../src/prune.js'

/** 构造模拟 yuque-dl 原始输出的夹具 */
async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuque-export-test-'))
  const raw = path.join(root, '知识库A')
  const out = path.join(root, 'out', '知识库A')

  const U1 = 'abcdefghij0123456' // 笔记一 uuid（16 位，与语雀实际一致）
  const U2 = 'klmnopqrst0123456' // 分组 uuid
  const U3 = 'efghijklmn0123456' // 子笔记 uuid
  const U4 = 'opqrstuvwx0123456' // 父文档 uuid
  const U5 = 'yzabcdefg01234567' // 子笔记2 uuid

  await fsp.mkdir(path.join(raw, 'img', U1), { recursive: true })
  await fsp.mkdir(path.join(raw, '分组_' + U2, 'img', U3), { recursive: true })
  await fsp.mkdir(path.join(raw, '父文档_' + U4, 'attachments', U4), { recursive: true })

  await fsp.writeFile(path.join(raw, `笔记一_${U1}.md`), [
    '# 笔记一',
    '',
    `![图片一](./img/${U1}/pic%20one.png)`,
    `![图片二](img/${U1}/pic2.png)`,
    '[外部链接](https://example.com/a.png)',
    '',
  ].join('\n'))
  await fsp.writeFile(path.join(raw, 'img', U1, 'pic one.png'), 'PNGDATA1')
  await fsp.writeFile(path.join(raw, 'img', U1, 'pic2.png'), 'PNGDATA2')

  await fsp.writeFile(path.join(raw, `分组_${U2}`, `子笔记_${U3}.md`), [
    '# 子笔记',
    '',
    `![子图](./img/${U3}/child.png)`,
    '',
  ].join('\n'))
  await fsp.writeFile(path.join(raw, '分组_' + U2, 'img', U3, 'child.png'), 'PNGDATA3')

  // 带子文档的父文档：index.md + 附件
  await fsp.writeFile(path.join(raw, '父文档_' + U4, 'index.md'), [
    '# 父文档正文',
    '',
    `[附件](./attachments/${U4}/手册.zip)`,
    '',
  ].join('\n'))
  await fsp.writeFile(path.join(raw, '父文档_' + U4, 'attachments', U4, '手册.zip'), 'ZIPDATA')
  await fsp.writeFile(path.join(raw, '父文档_' + U4, `子笔记2_${U5}.md`), '# 子笔记2\n')

  // 知识库目录 index.md（summary，链接为 raw 相对路径）
  await fsp.writeFile(path.join(raw, 'index.md'), [
    '# 知识库A',
    '',
    `- [笔记一](笔记一_${U1}.md)`,
    `- [分组](分组_${U2}/子笔记_${U3}.md)`,
    `- [父文档](父文档_${U4}/index.md)`,
    '',
  ].join('\n'))

  // progress.json 记录全部 toc uuid 及 md 路径（uuid 剥离、raw 资源清理的依据）
  const progress = [
    { path: `笔记一_${U1}.md`, toc: { uuid: U1, type: 'DOC', title: '笔记一' } },
    { path: `分组_${U2}`, toc: { uuid: U2, type: 'TITLE', title: '分组' } },
    { path: `分组_${U2}/子笔记_${U3}.md`, toc: { uuid: U3, type: 'DOC', title: '子笔记' } },
    { path: `父文档_${U4}/index.md`, toc: { uuid: U4, type: 'DOC', title: '父文档' } },
    { path: `父文档_${U4}/子笔记2_${U5}.md`, toc: { uuid: U5, type: 'DOC', title: '子笔记2' } },
  ]
  await fsp.writeFile(path.join(raw, 'progress.json'), JSON.stringify(progress))
  return { root, raw, out, U1, U2, U3, U4, U5 }
}

test('后处理：命名清理 + assets 重组 + 链接改写', async () => {
  const { raw, out } = await makeFixture()
  const n = await postprocessBook(raw, out)
  assert.equal(n, 5) // 笔记一、子笔记、父文档 index、子笔记2、知识库 index

  // 命名清理
  assert.ok(fs.existsSync(path.join(out, '笔记一.md')))
  assert.ok(fs.existsSync(path.join(out, '分组', '子笔记.md')))
  assert.ok(fs.existsSync(path.join(out, '父文档', 'index.md')))
  assert.ok(fs.existsSync(path.join(out, '父文档', '子笔记2.md')))
  assert.ok(!fs.existsSync(path.join(out, 'progress.json')))

  // assets 重组
  assert.ok(fs.existsSync(path.join(out, '笔记一.assets', 'pic one.png')))
  assert.ok(fs.existsSync(path.join(out, '笔记一.assets', 'pic2.png')))
  assert.ok(fs.existsSync(path.join(out, '分组', '子笔记.assets', 'child.png')))
  assert.ok(fs.existsSync(path.join(out, '父文档', '父文档.assets', '手册.zip')))
  // 原始 img/attachments 不进入输出
  assert.ok(!fs.existsSync(path.join(out, 'img')))

  // 链接改写
  const md1 = await fsp.readFile(path.join(out, '笔记一.md'), 'utf-8')
  assert.match(md1, /\[图片一\]\(笔记一\.assets\/pic%20one\.png\)/)
  assert.match(md1, /\[图片二\]\(笔记一\.assets\/pic2\.png\)/)
  assert.match(md1, /\[外部链接\]\(https:\/\/example\.com\/a\.png\)/)

  const mdIdx = await fsp.readFile(path.join(out, '父文档', 'index.md'), 'utf-8')
  assert.match(mdIdx, /\[附件\]\(父文档\.assets\/手册\.zip\)/)

  // summary 链接改写
  const summary = await fsp.readFile(path.join(out, 'index.md'), 'utf-8')
  assert.match(summary, /\[笔记一\]\(笔记一\.md\)/)
  assert.match(summary, /\[分组\]\(分组\/子笔记\.md\)/)
  assert.match(summary, /\[父文档\]\(父文档\/index\.md\)/)
})

test('后处理：幂等（重复运行结果一致）', async () => {
  const { raw, out } = await makeFixture()
  await postprocessBook(raw, out)
  const before = await fsp.readFile(path.join(out, '笔记一.md'), 'utf-8')
  const statBefore = (await fsp.stat(path.join(out, '笔记一.assets', 'pic one.png'))).mtimeMs
  await new Promise((r) => setTimeout(r, 20))
  await postprocessBook(raw, out)
  assert.equal(await fsp.readFile(path.join(out, '笔记一.md'), 'utf-8'), before)
  // 未变化的二进制不重写（mtime 保持）
  assert.equal((await fsp.stat(path.join(out, '笔记一.assets', 'pic one.png'))).mtimeMs, statBefore)
})

test('后处理：源删除后输出同步清理', async () => {
  const { raw, out, U1 } = await makeFixture()
  await postprocessBook(raw, out)
  assert.ok(fs.existsSync(path.join(out, '笔记一.md')))
  await fsp.rm(path.join(raw, `笔记一_${U1}.md`))
  await postprocessBook(raw, out)
  assert.ok(!fs.existsSync(path.join(out, '笔记一.md')))
  assert.ok(!fs.existsSync(path.join(out, '笔记一.assets')))
  // 其他笔记不受影响
  assert.ok(fs.existsSync(path.join(out, '分组', '子笔记.md')))
})

test('后处理：同名笔记自动加序号', async () => {
  const { raw, out, U1 } = await makeFixture()
  const U1b = 'zzzzzzzzzz0123456'
  await fsp.writeFile(path.join(raw, `笔记一_${U1b}.md`), '# 另一篇笔记一\n')
  // 新 uuid 也要登记进 progress.json
  const progress = JSON.parse(await fsp.readFile(path.join(raw, 'progress.json'), 'utf-8'))
  progress.push({ toc: { uuid: U1b, type: 'DOC', title: U1b } })
  await fsp.writeFile(path.join(raw, 'progress.json'), JSON.stringify(progress))
  await postprocessBook(raw, out)
  // 排序后两篇同题笔记，一篇原名一篇加序号
  const files = await fsp.readdir(out)
  const ones = files.filter((f) => f.startsWith('笔记一') && f.endsWith('.md'))
  assert.equal(ones.length, 2)
  assert.ok(ones.includes('笔记一.md'))
  assert.ok(ones.includes('笔记一 (2).md') || ones.includes('笔记一 (3).md'))
  // 原 uuid 版本仍在 raw 中不受影响
  assert.ok(fs.existsSync(path.join(raw, `笔记一_${U1}.md`)))
})

test('后处理：导出成功后清理 raw 资源副本，未变化笔记跳过', async () => {
  const { raw, out, U1 } = await makeFixture()
  await postprocessBook(raw, out)

  // raw 中的资源副本已删除（输出是唯一拷贝）
  assert.ok(!fs.existsSync(path.join(raw, 'img', U1)))
  // raw 的 md 与 progress.json 保留（增量依据）
  assert.ok(fs.existsSync(path.join(raw, `笔记一_${U1}.md`)))
  assert.ok(fs.existsSync(path.join(raw, 'progress.json')))
  // 输出完好
  assert.ok(fs.existsSync(path.join(out, '笔记一.assets', 'pic one.png')))

  // 第二次运行：未变化笔记跳过（mtime 相同），输出不受 raw 资源已删的影响
  const mdStat = (await fsp.stat(path.join(out, '笔记一.md'))).mtimeMs
  const assetStat = (await fsp.stat(path.join(out, '笔记一.assets', 'pic one.png'))).mtimeMs
  await postprocessBook(raw, out)
  assert.equal((await fsp.stat(path.join(out, '笔记一.md'))).mtimeMs, mdStat)
  assert.equal((await fsp.stat(path.join(out, '笔记一.assets', 'pic one.png'))).mtimeMs, assetStat)
  assert.ok(fs.existsSync(path.join(out, '笔记一.assets', 'pic one.png')))
})

test('后处理：笔记更新但 raw 资源缺失时沿用输出既有引用', async () => {
  const { raw, out, U1 } = await makeFixture()
  await postprocessBook(raw, out)
  const before = await fsp.readFile(path.join(out, '笔记一.md'), 'utf-8')

  // 模拟：raw md 有新 mtime（如被重新下载）但资源副本已被清理
  const now = new Date()
  await fsp.utimes(path.join(raw, `笔记一_${U1}.md`), now, now)

  await postprocessBook(raw, out)
  // 输出内容保持既有引用，未因 raw 资源缺失而退化为 img/ 路径
  const after = await fsp.readFile(path.join(out, '笔记一.md'), 'utf-8')
  assert.equal(after, before)
  assert.ok(fs.existsSync(path.join(out, '笔记一.assets', 'pic one.png')))
})

test('后处理：笔记更新且资源重新下载后正常导出', async () => {
  const { raw, out, U1 } = await makeFixture()
  await postprocessBook(raw, out)

  // 模拟：笔记更新，yuque-dl 重新下载了 md 与新图片
  const mdPath = path.join(raw, `笔记一_${U1}.md`)
  await fsp.writeFile(mdPath, `# 笔记一\n\n![新图](./img/${U1}/new.png)\n`)
  await fsp.mkdir(path.join(raw, 'img', U1), { recursive: true })
  await fsp.writeFile(path.join(raw, 'img', U1, 'new.png'), 'NEWPNG')

  await postprocessBook(raw, out)
  const md = await fsp.readFile(path.join(out, '笔记一.md'), 'utf-8')
  assert.match(md, /\[新图\]\(笔记一\.assets\/new\.png\)/)
  assert.ok(fs.existsSync(path.join(out, '笔记一.assets', 'new.png')))
  // 旧图已不被引用，随镜像清理移除
  assert.ok(!fs.existsSync(path.join(out, '笔记一.assets', 'pic one.png')))
})

test('删除同步：TOC 不含的文档被清理，输出同步移除', async () => {
  const { raw, out, U1, U2, U3, U4, U5 } = await makeFixture()
  await postprocessBook(raw, out)
  assert.ok(fs.existsSync(path.join(out, '分组', '子笔记.md')))

  // 模拟：子笔记(U3)在语雀端被删除（TOC 不再包含其 uuid）
  const tocUuids = new Set([U1, U2, U4, U5])
  const removed = await syncDeletions(raw, tocUuids)
  assert.deepEqual(removed, ['子笔记'])

  // progress.json 已移除该条目
  const progress = JSON.parse(await fsp.readFile(path.join(raw, 'progress.json'), 'utf-8'))
  assert.ok(!progress.some((i) => i.toc.uuid === U3))
  // raw md 与资源副本已删除
  assert.ok(!fs.existsSync(path.join(raw, `分组_${U2}`, `子笔记_${U3}.md`)))
  assert.ok(!fs.existsSync(path.join(raw, `分组_${U2}`, 'img', U3)))
  // 其他文档完好
  assert.ok(fs.existsSync(path.join(raw, `笔记一_${U1}.md`)))

  // 后处理镜像清理：输出中的对应文件与资源被移除
  // （真实流程中 yuque-dl 每次 sync 会重新生成 index.md，这里 touch 模拟其 mtime 更新）
  const now = new Date()
  await fsp.utimes(path.join(raw, 'index.md'), now, now)
  await postprocessBook(raw, out)
  assert.ok(!fs.existsSync(path.join(out, '分组', '子笔记.md')))
  assert.ok(!fs.existsSync(path.join(out, '分组', '子笔记.assets')))
  assert.ok(fs.existsSync(path.join(out, '笔记一.md')))
  // index.md 中指向已删文档的死链降级为纯文本
  const summary = await fsp.readFile(path.join(out, 'index.md'), 'utf-8')
  assert.match(summary, /- 分组\n/)
  assert.ok(!summary.includes('子笔记.md'))
})

test('删除同步：孤儿 md（改名遗留）被清理', async () => {
  const { raw, out, U1 } = await makeFixture()
  await postprocessBook(raw, out)

  // 模拟：笔记一改名为「新标题」（uuid 不变），yuque-dl 下载新文件，旧文件残留
  await fsp.writeFile(path.join(raw, `新标题_${U1}.md`), '# 新标题\n')
  const progress = JSON.parse(await fsp.readFile(path.join(raw, 'progress.json'), 'utf-8'))
  const entry = progress.find((i) => i.toc.uuid === U1)
  entry.path = `新标题_${U1}.md`
  entry.toc.title = '新标题'
  await fsp.writeFile(path.join(raw, 'progress.json'), JSON.stringify(progress))

  const tocUuids = new Set(progress.map((i) => i.toc.uuid))
  await syncDeletions(raw, tocUuids)
  // 旧文件已清理，新文件保留
  assert.ok(!fs.existsSync(path.join(raw, `笔记一_${U1}.md`)))
  assert.ok(fs.existsSync(path.join(raw, `新标题_${U1}.md`)))

  await postprocessBook(raw, out)
  assert.ok(fs.existsSync(path.join(out, '新标题.md')))
  assert.ok(!fs.existsSync(path.join(out, '笔记一.md')))
})

test('删除同步：progress.json 缺失时安全返回', async () => {
  const { root, raw } = await makeFixture()
  await fsp.rm(path.join(raw, 'progress.json'))
  const removed = await syncDeletions(raw, new Set())
  assert.deepEqual(removed, [])
  // 文件未被误删
  assert.ok((await fsp.readdir(raw)).length > 0)
})
