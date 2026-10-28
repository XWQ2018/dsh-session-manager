/**
 * 真实环境快照验收（只读）：用真实 DSH_HOME 跑 buildSnapshot，
 * 验证标题、工作目录、来源与分页所需字段是否齐全。
 * 只读：不调用任何 runAction，缓存落在临时目录。
 * 运行 node tools/test-snapshot-real.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/session-store.js'
import { createManager, encodeGroupName } from '../lib/host-api.js'
import { createTitleResolver } from '../lib/title-resolver.js'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const tmpDir = mkdtempSync(path.join(tmpdir(), 'dshsm-snap-'))
const paths = store.resolvePaths({ DSH_HOME: home })
const resolver = createTitleResolver({ cacheFile: path.join(tmpDir, 'cache.json'), concurrency: 6 })
resolver.load()

const manager = createManager({
  paths,
  store,
  resolver,
  liveIds: () => [],
  archive: async () => {},
  unarchive: async () => {},
})

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

console.log('== 1. 首屏快照（后台解析尚未完成）==')
const t0 = Date.now()
const first = await manager.buildSnapshot({ issueToken: true })
const firstMs = Date.now() - t0
console.log(`  耗时 ${firstMs}ms，会话 ${first.items.length}，titlesPending=${first.titlesPending}`)
check('首屏在 1.5 秒内返回', firstMs < 1500, firstMs + 'ms')
check('有会话条目', first.items.length > 0)

const cwdFirst = first.items.filter((i) => i.cwd).length
console.log(`  首屏有 cwd 的 ${cwdFirst} / ${first.items.length}`)
check('首屏至少部分会话有工作目录', cwdFirst > 0)

console.log('== 2. 等待后台解析排空 ==')
const waitStart = Date.now()
while (resolver.pending() > 0 && Date.now() - waitStart < 60000) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
console.log(`  排空耗时 ${Date.now() - waitStart}ms`)

const second = await manager.buildSnapshot({ issueToken: true })
const withTitle = second.items.filter((i) => i.title).length
const withCwd = second.items.filter((i) => i.cwd).length
const mains = second.items.filter((i) => !i.origin)
const mainsWithTitle = mains.filter((i) => i.title).length
console.log(`  标题 ${withTitle} / ${second.items.length}；工作目录 ${withCwd} / ${second.items.length}`)
console.log(`  主会话 ${mains.length}，其中有标题 ${mainsWithTitle}`)

check('绝大多数会话有工作目录', withCwd >= second.items.length * 0.95, withCwd + '/' + second.items.length)
check('主会话基本都有标题', mainsWithTitle >= mains.length * 0.9, mainsWithTitle + '/' + mains.length)
check('titlesPending 已归零', second.titlesPending === 0, String(second.titlesPending))
check('子会话带 origin 标记', second.items.some((i) => i.origin === 'subagent'))

console.log('== 3. 字段完整性 ==')
const sample = second.items.find((i) => i.title && i.cwd)
console.log('  样本:', JSON.stringify({ title: sample.title, cwd: sample.cwd, origin: sample.origin, size: sample.sizeBytes, updated: sample.updatedAt }))
check('样本字段齐全', Boolean(sample && sample.title && sample.cwd && sample.sessionId))
check('每条都有体积与更新时间', second.items.every((i) => typeof i.sizeBytes === 'number' && typeof i.updatedAt === 'number'))

console.log('== 4. 二次快照命中缓存（应显著更快）==')
const t1 = Date.now()
await manager.buildSnapshot({ issueToken: true })
const secondMs = Date.now() - t1
console.log(`  耗时 ${secondMs}ms`)
check('缓存后快照更快', secondMs <= firstMs + 200, `first=${firstMs}ms second=${secondMs}ms`)

console.log('== 5. 工作区目录名编码 ==')
check('编码 C:\\dsHarness', encodeGroupName('C:\\dsHarness') === '--C-dsHarness--', encodeGroupName('C:\\dsHarness'))
check(
  '编码含下划线的路径',
  encodeGroupName('F:\\companyProject_2023\\JNS_PRONEW') === '--F-companyProject-2023-JNS-PRONEW--',
  encodeGroupName('F:\\companyProject_2023\\JNS_PRONEW'),
)

rmSync(tmpDir, { recursive: true, force: true })
console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1