#!/usr/bin/env node
import { run } from '../src/cli.js'
import { redact, rememberSecret } from '../src/secrets.js'
const tokenIndex = process.argv.indexOf('--token')
if (tokenIndex >= 0) rememberSecret(process.argv[tokenIndex + 1])

run(process.argv.slice(2)).catch((e) => {
  console.error(redact(`失败: ${e.message || e}`))
  if (process.env.YUQUE_EXPORT_DEBUG) console.error(redact(e.stack))
  process.exitCode = 1
})
