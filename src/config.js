import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ask } from './util.js'

const CONFIG_PATH = path.join(os.homedir(), '.yuque-export.json')

export async function loadConfig() {
  try {
    const str = await fsp.readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(str)
  } catch {
    return null
  }
}

export async function saveConfig(config) {
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  console.log(`配置已保存: ${CONFIG_PATH}`)
}

export function configPath() {
  return CONFIG_PATH
}

/**
 * 配置结构:
 * {
 *   token: '_yuque_session 的值',
 *   key: '_yuque_session',              // 可选，企业版需要
 *   distDir: 'D:/yuque-backup',         // 导出根目录
 *   include: [],                        // 可选，知识库名/slug 白名单
 *   exclude: [],                        // 可选，知识库名/slug 黑名单
 *   toc: false,                         // 透传 yuque-dl 选项
 *   hideFooter: false,
 *   ignoreAttachments: false
 * }
 */
export async function initConfig({ nonInteractive = false, token, distDir } = {}) {
  const existing = await loadConfig()
  let cfgToken = token ?? existing?.token
  let cfgDir = distDir ?? existing?.distDir

  if (!nonInteractive) {
    if (!cfgToken) {
      console.log('\n获取 token：浏览器登录语雀 → F12 打开开发者工具 → Application(应用) → Cookies')
      console.log('→ 找到 www.yuque.com 下的 `_yuque_session`，复制它的值。\n')
      cfgToken = await ask('请粘贴 _yuque_session 的值: ', { secret: true })
    }
    if (!cfgDir) {
      cfgDir = await ask('导出到哪个目录（如 D:\\yuque-backup）: ')
    }
  }

  if (!cfgToken) throw new Error('缺少 token，无法初始化。请运行 yuque-export init 按提示输入，或使用 --token 参数')
  if (!cfgDir) throw new Error('缺少导出目录。请运行 yuque-export init 按提示输入，或使用 --dir 参数')

  const config = {
    ...(existing || {}),
    token: cfgToken,
    distDir: path.resolve(cfgDir),
  }
  await saveConfig(config)
  return config
}
