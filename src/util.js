import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

/** Windows 下文件名非法字符，与 yuque-dl 的 fixPath 保持一致 */
const INVALID_CHARS = /[\\/:*?"<>|\n\r]/g

/** 清洗为合法文件名 */
export function sanitize(name) {
  return String(name).replace(INVALID_CHARS, '_').replace(/\s+$/, '').trim()
}

/** 去掉 yuque-dl 生成的 `标题_<uuid>` 中的 uuid 后缀（仅作 progress.json 缺失时的兜底启发式） */
export function stripUuidSuffix(name) {
  return name.replace(/_[A-Za-z0-9_-]{15,24}(\.[^.]+)?$/, '$1')
}

/** 终端交互提问 */
export async function ask(question, { secret = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let answer
  if (secret) {
    // 关闭回显输入 token
    const stdout = process.stdout
    answer = await new Promise((resolve) => {
      const stdin = process.stdin
      stdin.setRawMode?.(true)
      stdin.resume()
      let buf = ''
      const onData = (ch) => {
        ch = String(ch)
        // Ctrl+C
        if (ch === '') {
          stdin.removeListener('data', onData)
          rl.close()
          process.exit(1)
        }
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData)
          stdin.setRawMode?.(false)
          stdout.write('\n')
          resolve(buf)
        } else if (ch === '' || ch === '\b') {
          if (buf.length) buf = buf.slice(0, -1)
        } else {
          buf += ch
        }
      }
      stdin.on('data', onData)
    })
  } else {
    answer = await rl.question(question)
  }
  rl.close()
  return answer.trim()
}

export function exists(p) {
  return fs.existsSync(p)
}

export async function isFile(p) {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

export async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** 目录内条目按名称排序（目录在前无所谓，保证遍历顺序稳定） */
export async function readdirSorted(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return entries
}

/** 相对路径用于 markdown 链接（空格等转义） */
export function toMdLink(relPath) {
  return relPath.split(path.sep).join('/').replace(/\s/g, '%20')
}
