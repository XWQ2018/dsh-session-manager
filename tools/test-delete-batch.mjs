/**
 * 压力/耗时测试：删除 10 条会话在隔离环境里的真实耗时，定位"卡在正在处理中"是否服务端慢。
 * 运行 node tools/test-delete-batch.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/session-store.js'
import { createManager } from '../lib/host-api.js'

const home = await mkdtemp(path.join(tmpdir(), 'dshsm-batch-'))
const paths = store.resolvePaths({ DSH_HOME: home })
const group = '--C-dsHarness--'
const GROUP_DIR = path.join(paths.sessionsRoot, group)
await mkdir(GROUP_DIR, { recursive: true })
await mkdir(paths.storageDir, { recursive: true })

// 造 30 个会话，每个 200KB
const ids = []
for (let i = 0; i < 30; i += 1) {
  const id = 'session-batch' + String(i).padStart(4, '0')
  ids.push(id)
  const dir = path.join(GROUP_DIR, id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(200 * 1024, 1))
}

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
await writeFile(
  paths.workspaceJson,
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: ids.slice(0, 15), pinnedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: { path: 'C:\\dsHarness', title: 'dsHarness', sessionIds: ids } } },
  }),
)
await writeFile(
  paths.sessionProjCacheJson,
  JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: { sessions: Object.fromEntries(ids.map((id) => [id, { identity: { createdAt: 1700000000000, cwd: 'C:\\dsHarness' }, rows: {} }])) },
  }),
)

const manager = createManager({
  paths,
  store,
  liveIds: () => [],
  archive: async () => {},
  unarchive: async () => {},
})

// 1) 首屏快照耗时
let t0 = Date.now()
const snap = await manager.buildSnapshot({ issueToken: true })
console.log('首屏快照 ' + (Date.now() - t0) + 'ms，会话 ' + snap.items.length)

// 2) 删除 10 条（含归档与未归档两种，覆盖真实场景）
const targets = snap.items.slice(0, 10).map((item) => item.sessionId)
const archivedTargets = snap.items.filter((i) => i.archived).slice(0, 10).map((i) => i.sessionId)

t0 = Date.now()
const res = await manager.runAction({
  action: 'delete-sessions',
  ids: targets,
  confirmToken: snap.confirmToken,
  confirmPhrase: '删除',
})
const delMs = Date.now() - t0
console.log('删除 10 条耗时 ' + delMs + 'ms，done=' + res.done.length + ' blocked=' + res.blocked.length + ' skipped=' + res.skipped.length)

const snap2 = await manager.buildSnapshot({ issueToken: true })
t0 = Date.now()
const res2 = await manager.runAction({
  action: 'delete-sessions',
  ids: archivedTargets,
  confirmToken: snap2.confirmToken,
  confirmPhrase: '删除',
})
console.log('再删 10 条归档耗时 ' + (Date.now() - t0) + 'ms，done=' + res2.done.length)

const remaining = (await readdir(GROUP_DIR)).length
console.log('剩余目录 ' + remaining + '（应为 20）')

let pass = 0
let fail = 0
const check = (label, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : '')) }
}
check('单批删除在 5 秒内完成', delMs < 5000, delMs + 'ms')
check('删除 10 条全部成功', res.done.length === 10, String(res.done.length))
check('剩余数量正确', remaining === 20, String(remaining))

await rm(home, { recursive: true, force: true })
console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1