const DEFAULT_DOMAIN = 'https://www.yuque.com'

/**
 * 枚举当前账号的所有知识库（与 yuque-dl 内部使用的接口一致）
 * @returns {Promise<Array<{id:number,name:string,slug:string,userLogin:string,itemsCount:number,visibility:number}>>}
 */
export async function getUserBooks({ token, key = '_yuque_session' }) {
  const books = []
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
      throw new Error(`网络请求失败: ${e.message}`)
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error('token 无效或已过期，请重新获取 _yuque_session（运行 yuque-export init）')
      throw new Error(`获取知识库列表失败: HTTP ${res.status}`)
    }
    const body = await res.json().catch(() => null)
    const items = body?.data || []
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
export async function getBookTocUuids(bookUrl, { token, key = '_yuque_session' }) {
  let res
  try {
    res = await fetch(bookUrl, { headers: { cookie: `${key}=${token}` } })
  } catch (e) {
    throw new Error(`网络请求失败: ${e.message}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
  return new Set(toc.map((t) => t?.uuid).filter(Boolean))
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
