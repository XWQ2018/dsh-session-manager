/**
 * 解析器验收：用真实会话日志（只读）测覆盖率与耗时，并验证缓存命中。
 * 运行 node tools/test-title-resolver.mjs
 */
import { readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTitleResolver } from '../lib/title-resolver.js'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')

let pass = 0
let fail = 0
function check(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : ''))
  }
}

// 收集真实会话（只读）
const entries = []
for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    const dir = path.join(sessionsRoot, group.name, child.name)
    const files = readdirSync(dir).filter((name) => name.includes('.jsonl.'))
    if (files.length === 0) continue
    entries.push({ sessionId: child.name, logPath: path.join(dir, files.sort().pop()) })
  }
}
console.log('真实会话数:', entries.length)

const tmpDir = mkdtempSync(path.join(tmpdir(), 'dshsm-titles-'))
const cacheFile = path.join(tmpDir, 'cache.json')

// 1) 抽样 20 个同步解析
const sample = entries.slice(0, 20)
const resolver = createTitleResolver({ cacheFile })
resolver.load()
const started = Date.now()
let withTitle = 0
let withCwd = 0
let origin = 0
for (const item of sample) {
  const meta = await resolver.resolveNow(item.sessionId, item.logPath)
  if (meta && meta.title) withTitle += 1
  if (meta && meta.cwd) withCwd += 1
  if (meta && meta.origin) origin += 1
}
const elapsed = Date.now() - started
console.log(`抽样 ${sample.length} 个：耗时 ${elapsed}ms（平均 ${Math.round(elapsed / sample.length)}ms/个）`)
console.log(`  有标题 ${withTitle} / ${sample.length}，有 cwd ${withCwd} / ${sample.length}，子会话 ${origin}`)
check('抽样中至少一半有标题', withTitle >= sample.length / 2, withTitle + '/' + sample.length)
check('全部能取到 cwd', withCwd === sample.length, withCwd + '/' + sample.length)

// 2) 抽查具体内容
const first = sample.find((item) => item.sessionId.startsWith('session-'))
const meta = resolver.get(first.sessionId)
console.log('  样本标题:', JSON.stringify(meta && meta.title), '| cwd:', JSON.stringify(meta && meta.cwd))
check('元信息字段齐全', Boolean(meta && typeof meta.mtimeMs === 'number' && 'title' in meta && 'cwd' in meta))

// 3) 缓存落盘与二次加载
resolver.flush()
const size = statSync(cacheFile).size
check('缓存文件已落盘', size > 100, 'bytes=' + size)
const again = createTitleResolver({ cacheFile })
again.load()
check('二次加载命中缓存', Boolean(again.get(first.sessionId) && again.get(first.sessionId).cwd === meta.cwd))

// 4) 后台队列：提交全部后等待完成
const background = createTitleResolver({ cacheFile: path.join(tmpDir, 'cache2.json'), concurrency: 6, limit: 200 })
background.load()
const bgStart = Date.now()
for (const item of entries) {
  const info = statSync(item.logPath)
  background.submit(item.sessionId, item.logPath, info.mtimeMs, info.size)
}
// 等待排空
let waited = 0
while (background.pending() > 0 && waited < 120000) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  waited += 50
}
const bgElapsed = Date.now() - bgStart
let covered = 0
for (const item of entries) {
  const got = background.get(item.sessionId)
  if (got && got.cwd) covered += 1
}
console.log(`后台队列：${entries.length} 个会话，耗时 ${bgElapsed}ms，覆盖 ${covered} 个`)
check('后台队列能覆盖绝大多数会话', covered >= entries.length * 0.95, covered + '/' + entries.length)
check('后台队列已排空', background.pending() === 0)

rmSync(tmpDir, { recursive: true, force: true })
console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1