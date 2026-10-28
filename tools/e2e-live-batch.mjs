/**
 * 真实环境批量删除验收：自建 12 个一次性会话 → 经 HTTP 批量删除 10 个 → 复核。
 * 只操作本脚本自己造的 session-sm-batch-* 目录，结束清理残留。
 * 运行 node tools/e2e-live-batch.mjs
 */
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const ORIGIN = process.env.DSH_WEB_URL || 'http://127.0.0.1:50763'
const API = ORIGIN + '/api/dsh-session-manager'
const GROUP = '--C-dsHarness--'
const stamp = Date.now().toString(36)
const ids = Array.from({ length: 12 }, (_, index) => 'session-sm-batch-' + stamp + '-' + index)

let pass = 0
let fail = 0
const check = (label, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : '')) }
}

const list = async () => {
  const res = await fetch(API + '/list')
  return res.json()
}
const action = async (body) => {
  const res = await fetch(API + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

console.log('== 1. 造 12 个一次性会话 ==')
for (const id of ids) {
  const dir = path.join(HOME, 'sessions', GROUP, id)
  await mkdir(dir, { recursive: true })
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: 'C:\\dsHarness', isSeeded: false }
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')))
}
const before = await list()
const visible = before.items.filter((item) => item.sessionId.indexOf('session-sm-batch-' + stamp) === 0)
check('12 个测试会话都进了列表', visible.length === 12, String(visible.length))

console.log('== 2. HTTP 批量删除 10 个 ==')
const snap = await list()
const targets = ids.slice(0, 10)
const started = Date.now()
const res = await action({
  action: 'delete-sessions',
  ids: targets,
  confirmToken: snap.confirmToken,
  confirmPhrase: '删除',
})
const elapsed = Date.now() - started
console.log(`  耗时 ${elapsed}ms，ok=${res.ok}，done=${(res.done || []).length}`)
check('响应 ok', res.ok === true, JSON.stringify(res).slice(0, 200))
check('10 条全部删除', Array.isArray(res.done) && res.done.length === 10, String((res.done || []).length))
check('批量删除在 8 秒内完成', elapsed < 8000, elapsed + 'ms')

console.log('== 3. 删除后复核 ==')
const after = await list()
const stillThere = after.items.filter((item) => targets.indexOf(item.sessionId) >= 0)
check('目标已从列表消失', stillThere.length === 0, stillThere.map((i) => i.sessionId).join(','))
let onDisk = 0
for (const id of targets) if (existsSync(path.join(HOME, 'sessions', GROUP, id))) onDisk += 1
check('磁盘目录已清空', onDisk === 0, String(onDisk))

console.log('== 4. 清理剩余 2 个 ==')
for (const id of ids.slice(10)) {
  const dir = path.join(HOME, 'sessions', GROUP, id)
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
}
const leftovers = (await readdir(path.join(HOME, 'sessions', GROUP))).filter((name) => name.indexOf('session-sm-batch-' + stamp) === 0)
check('无残留', leftovers.length === 0, leftovers.join(','))

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1