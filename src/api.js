import { rememberSecret } from './secrets.js'

const DEFAULT_DOMAIN = 'https://www.yuque.com'

/**
 * 枚举当前账号的所有知识库（与 yuque-dl 内部使用的接口一致）
 * @returns {Promise<Array<{id:number,name:string,slug:string,userLogin:string,itemsCount:number,visibility:number}>>}
 */
export async function getUserBooks({ token, key = '_yuque_session' }) {
  rememberSecret(token)
  const books = []
  const seen = new Set()
  const limit = 50
  let offset = 0
  while (true) {
    const url = `${DEFAULT_DOMAIN}/api/mine/books?limit=${limit}&offset=${offset}`
    let res
    try {
      res = await fetch(url, {
        headers: { cookie: `${key}=${token}` },
      })
    } catch (e) {
      throw new Error(`网络请求失败；未确认远端清单`)
    }
    if (res.redirected) throw new Error('登录重定向；禁止清理')
    if (!res.ok) {
      if (res.status === 401) throw new Error('token 无效或已过期，请重新获取 _yuque_session（运行 yuque-export init）')
      throw new Error(`获取知识库列表失败: HTTP ${res.status}`)
    }
    const body = await res.json().catch(() => null)
    if (!body || !Array.isArray(body.data) || body.error || body.errors || body.success === false) {
      throw new Error('知识库接口格式变化或返回异常；禁止清理')
    }
    const items = body.data
    for (const item of items) {
      if (!item || typeof item.type !== 'string' || !Number.isSafeInteger(item.id) ||
          seen.has(item.id) || item.type === 'Book' &&
          (typeof item.name !== 'string' || !item.name || typeof item.slug !== 'string' ||
           !item.slug || typeof item.user?.login !== 'string' || !item.user.login)) {
        throw new Error('知识库分页重复、条目缺失或格式变化；禁止清理')
      }
      seen.add(item.id)
    }
    if (Number.isInteger(body.total) && items.length < limit && books.length + items.length !== body.total) {
      throw new Error('知识库清单不完整；禁止清理')
    }
    if (offset > 50000) throw new Error('知识库分页异常；禁止清理')
    books.push(...items)
    if (items.length < limit) break
    offset += limit
  }
  return books
    .filter((b) => b.type === 'Book')
    .map((b) => ({
      id: b.id,
      name: b.name,
      slug: b.slug,
      userLogin: b.user?.login || '',
      itemsCount: b.items_count || 0,
      visibility: b.public ? 1 : 0,
    }))
    .filter((b) => b.userLogin)
}

/**
 * 获取知识库当前的目录树（TOC）uuid 集合。
 * 与 yuque-dl 内部方式一致：请求知识库页面，从内嵌的
 * `decodeURIComponent("...")` JSON 中解析 book.toc。
 * @returns {Promise<Set<string>>} TOC 中全部条目的 uuid
 */
export async function getBookTocUuids(bookUrl, { token, key = '_yuque_session', bookId } = {}) {
  rememberSecret(token)
  let res
  try {
    res = await fetch(bookUrl, { headers: { cookie: `${key}=${token}` } })
  } catch (e) {
    throw new Error('网络请求失败；未确认远端清单')
  }
  if (res.status === 401) throw new Error('认证过期；禁止清理')
  if (res.status === 403 || res.status === 404) throw new Error('知识库不可见或权限变化；不能确认为删除')
  if (!res.ok || res.redirected) throw new Error('知识库请求异常或登录重定向；禁止清理')
  const html = await res.text()
  const m = html.match(/decodeURIComponent\("(.+)"\)\);/m)
  if (!m) throw new Error('页面内嵌数据解析失败')
  let data
  try {
    data = JSON.parse(decodeURIComponent(m[1]))
  } catch {
    throw new Error('页面内嵌数据 JSON 解析失败')
  }
  const toc = data?.book?.toc
  if (!Array.isArray(toc)) throw new Error('页面数据中未找到目录树')
  if (bookId !== undefined && data.book.id !== bookId) throw new Error('知识库身份不匹配；禁止清理')
  const uuids = new Set()
  for (const item of toc) {
    if (typeof item?.uuid !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.uuid) ||
        !['DOC', 'TITLE', 'LINK'].includes(item.type) || uuids.has(item.uuid)) {
      throw new Error('目录条目缺失、重复或格式变化；禁止清理')
    }
    uuids.add(item.uuid)
  }
  // A syntactically valid short/empty TOC is insufficient evidence of deletion.
  const docCount = toc.filter(t => t.type === 'DOC').length
  if (!Number.isSafeInteger(data.book.items_count) || data.book.items_count !== docCount) {
    throw new Error('无法确认目录完整性（文档计数缺失或不符）；禁止清理')
  }
  // Cleanup needs a known logged-in principal with full book access. A readable
  // page can otherwise be a permission-filtered view with internally valid counts.
  const abilities = data.book.abilities
  uuids.cleanupScope = Number.isSafeInteger(data.me?.id) && abilities?.read === true &&
    abilities?.read_private === true && abilities?.manage === true
    ? JSON.stringify({ principal: data.me.id, book: data.book.id }) : null
  uuids.docs = new Set(toc.filter(t => t.type === 'DOC').map(t => t.uuid))
  return uuids
}

/** 按配置的 include/exclude 过滤知识库（匹配名称或 slug，忽略大小写） */
export function filterBooks(books, { include = [], exclude = [] } = {}) {
  const norm = (list) => list.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  const inc = norm(include)
  const exc = norm(exclude)
  return books.filter((b) => {
    const keys = [b.name.toLowerCase(), b.slug.toLowerCase()]
    if (inc.length && !keys.some((k) => inc.includes(k))) return false
    if (exc.length && keys.some((k) => exc.includes(k))) return false
    return true
  })
}
