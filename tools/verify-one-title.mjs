/**
 * 单点验证：指定会话的标题是否取到了最新一条（而不是早期的 fallback）。
 * 用法：node tools/verify-one-title.mjs 2a340f3751da
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createTitleResolver } from '../lib/title-resolver.js'

const needle = process.argv[2] || '2a340f3751da'
const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')

const compact = (v) => String(v).replace(/-/g, '').toLowerCase()
let found = null
for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    if (compact(child.name).indexOf(compact(needle)) >= 0) {
      const dir = path.join(sessionsRoot, group.name, child.name)
      const files = readdirSync(dir).filter((n) => n.includes('.jsonl.'))
      if (files.length > 0) found = { id: child.name, logPath: path.join(dir, files.sort().pop()) }
    }
  }
}

if (!found) {
  console.log('未找到会话:', needle)
  process.exit(1)
}

const resolver = createTitleResolver({})
resolver.load()
const meta = await resolver.resolveNow(found.id, found.logPath)

console.log('会话      :', found.id)
console.log('解析标题  :', JSON.stringify(meta.title))
console.log('工作目录  :', JSON.stringify(meta.cwd))
console.log('来源      :', JSON.stringify(meta.origin))
console.log('')
console.log(meta.title === 'Simple arithmetic question' ? 'PASS  已取到最新标题（provider 生成）' : 'CHECK 标题与预期不同，请人工确认')
if (meta.title === '1+1') {
  console.log('FAIL  仍然是 fallback 标题，取最新逻辑未生效')
  process.exitCode = 1
}
