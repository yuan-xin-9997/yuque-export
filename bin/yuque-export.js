#!/usr/bin/env node
import { run } from '../src/cli.js'

run(process.argv.slice(2)).catch((e) => {
  console.error(`✕ ${e.message || e}`)
  if (process.env.YUQUE_EXPORT_DEBUG) console.error(e.stack)
  process.exitCode = 1
})
