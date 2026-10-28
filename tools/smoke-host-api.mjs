/**
 * Host 半边隔离冒烟测试：用真实的 lib/session-store.js 配一个假的 DSH_HOME，
 * 直接驱动 createManager 的动作与令牌校验。
 *
 * 运行：node tools/smoke-host-api.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/session-store.js'
import { createManager, formatBytes } from '../lib/host-api.js'

let pass = 0
let fail = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    failures.push(label + (detail ? ' :: ' + detail : ''))
    console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : ''))
  }
}

function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}

/** 造一个与真实结构同形的假 DSH_HOME。 */
async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dshsm-smoke-'))
  const sessionsRoot = path.join(home, 'sessions')
  const group = path.join(sessionsRoot, '--C-fake-workspace--')

  const main1 = 'session-11111111-1111-4111-8111-111111111111'
  const main2 = 'session-22222222-2222-4222-8222-222222222222'
  const sub1 = '33333333-3333-4333-8333-333333333333'
  const archived = 'session-44444444-4444-4444-8444-444444444444'

  for (const id of [main1, main2, sub1, archived]) {
    const dir = path.join(group, id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(id.length * 10, 1))
  }

  const storages = path.join(home, 'storages')
  await mkdir(storages, { recursive: true })

  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await writeFile(
    path.join(storages, 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [workspaceId],
        archivedSessionIds: [archived],
        pinnedSessionIds: [main2],
      },
      tables: {
        workspaces: {
          [workspaceId]: {
            path: 'C:\\fake-workspace',
            title: '假工作区',
            sessionIds: [main1, main2, sub1, archived],
          },
        },
      },
    }),
  )

  await writeFile(
    path.join(storages, 'session_projcache.json'),
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      tables: {
        sessions: {
          [main1]: { identity: { createdAt: 1700000000000, cwd: 'C:\\fake-workspace' }, rows: { title: { ver: 1, seq: 5, val: '第一个会话' } } },
          [main2]: { identity: { createdAt: 1700000100000, cwd: 'C:\\fake-workspace' }, rows: { title: { ver: 1, seq: 5, val: '第二个会话' } } },
          [sub1]: { identity: { createdAt: 1700000200000, cwd: 'C:\\fake-workspace' }, rows: {} },
          [archived]: { identity: { createdAt: 1700000300000, cwd: 'C:\\fake-workspace' }, rows: {} },
        },
      },
    }),
  )

  return { home, group, main1, main2, sub1, archived, workspaceId }
}

const fixture = await makeHome()
const paths = store.resolvePaths({ DSH_HOME: fixture.home })

// 归档状态用内存集合模拟，避免触碰真实 registry 之外的状态
const archivedSet = new Set([fixture.archived])
// 记录删除前是否请求了「停止活动」
const stopCalls = []
const liveSet = new Set([fixture.main1])

// 记录插件是否请求 DSH 服务侧解除工作区关联（这决定官方侧边栏能否同步刷新）
const detachCalls = []

const manager = createManager({
  paths,
  store,
  liveIds: () => Array.from(liveSet),
  detachSessions: async (ids) => {
    detachCalls.push(ids.map(String))
  },
  archive: async (sessionId, options) => {
    stopCalls.push({ sessionId: String(sessionId), stopActivity: Boolean(options && options.stopActivity) })
    archivedSet.add(sessionId)
    await store.purgeWorkspaceRegistry(paths, { sessionIds: [], dropArchive: false, dropPin: false })
  },
  unarchive: async (sessionId) => {
    archivedSet.delete(sessionId)
  },
})

console.log('== 1. 快照与统计')
const snap1 = await manager.buildSnapshot({ issueToken: true })
eq('会话总数 = 4', snap1.stats.total, 4)
eq('归档数 = 1', snap1.stats.archived, 1)
eq('未归档数 = 3', snap1.stats.active, 3)
eq('运行中数 = 1', snap1.stats.live, 1)
ok('confirmToken 已下发', typeof snap1.confirmToken === 'string' && snap1.confirmToken.startsWith('sm-'))
const byId = new Map(snap1.items.map((item) => [item.sessionId, item]))
eq('标题来自投影缓存', byId.get(fixture.main1).title, '第一个会话')
eq('归属工作区可解析', byId.get(fixture.sub1).workspaceTitle, '假工作区')
eq('已加载会话标记为可删', byId.get(fixture.main1).deletable, true)
eq('归档标记正确', byId.get(fixture.archived).archived, true)
ok('裸 UUID 子会话被收录', byId.has(fixture.sub1))

console.log('== 2. 删除必须过令牌与短语')
const noToken = await manager.runAction({ action: 'delete-sessions', ids: [fixture.main2] })
eq('缺令牌被拒', noToken.error, 'confirm-required')
const wrongToken = await manager.runAction({ action: 'delete-sessions', ids: [fixture.main2], confirmToken: 'sm-deadbeef' })
eq('错令牌被拒', wrongToken.error, 'confirm-required')
const noPhrase = await manager.runAction({
  action: 'delete-all',
  confirmToken: snap1.confirmToken,
})
eq('缺短语被拒', noPhrase.error, 'confirm-phrase-mismatch')
const noPhraseOne = await manager.runAction({
  action: 'delete-sessions',
  ids: [fixture.main2],
  confirmToken: snap1.confirmToken,
})
eq('单条删除缺短语被拒', noPhraseOne.error, 'confirm-phrase-mismatch')
const wrongPhrase = await manager.runAction({
  action: 'delete-archived',
  confirmToken: snap1.confirmToken,
  confirmPhrase: '删除',
})
eq('错短语被拒', wrongPhrase.error, 'confirm-phrase-mismatch')

console.log('== 3. 已加载会话：删除前先停止其活动')
const delLive = await manager.runAction({
  action: 'delete-sessions',
  ids: [fixture.main1],
  confirmToken: snap1.confirmToken,
  confirmPhrase: '删除',
})
eq('已加载会话不再被 blocked', delLive.blocked.length, 0)
eq('已加载会话被删除', delLive.done, [fixture.main1])
ok(
  '删除前请求了停止活动',
  stopCalls.some((call) => call.sessionId === fixture.main1 && call.stopActivity === true),
  JSON.stringify(stopCalls),
)
let liveGone = true
try {
  await stat(path.join(fixture.group, fixture.main1))
  liveGone = false
} catch {
  liveGone = true
}
ok('磁盘目录已消失', liveGone)

console.log('== 4. 单条物理删除（含注册表与缓存清理）')
const del = await manager.runAction({
  action: 'delete-sessions',
  ids: [fixture.main2],
  confirmToken: snap1.confirmToken,
  confirmPhrase: '删除',
})
eq('删除成功 1 条', del.done, [fixture.main2])
let gone = true
try {
  await stat(path.join(fixture.group, fixture.main2))
  gone = false
} catch {
  gone = true
}
ok('磁盘目录已消失', gone)

ok('删除前请求了 DSH 解除工作区关联', detachCalls.length >= 1, 'calls=' + detachCalls.length)
const allDetached = detachCalls.flat()
ok('要删的会话都交给了 detach', allDetached.includes(fixture.main2), JSON.stringify(allDetached))
ok('运行中会话没被 detach', !allDetached.includes(fixture.main1), JSON.stringify(allDetached))

const regAfter = JSON.parse(await readFile(path.join(fixture.home, 'storages', 'workspace.json'), 'utf8'))
ok('已从 workspaces[*].sessionIds 移除', !regAfter.tables.workspaces[fixture.workspaceId].sessionIds.includes(fixture.main2))
ok('已从 pinnedSessionIds 移除', !regAfter.global.pinnedSessionIds.includes(fixture.main2))
ok('其他会话仍在注册表', regAfter.tables.workspaces[fixture.workspaceId].sessionIds.includes(fixture.sub1))
eq('工作区键集合不变', Object.keys(regAfter.tables.workspaces), [fixture.workspaceId])

const cacheAfter = JSON.parse(await readFile(path.join(fixture.home, 'storages', 'session_projcache.json'), 'utf8'))
ok('已从投影缓存移除', !(fixture.main2 in cacheAfter.tables.sessions))
ok('投影缓存保留其他会话', fixture.sub1 in cacheAfter.tables.sessions)

const verifyRes = await manager.verify([fixture.main2])
eq('复核确认已彻底删除', verifyRes.gone, true)

console.log('== 5. 清空归档')
const snap2 = await manager.buildSnapshot({ issueToken: true })
const purge = await manager.runAction({
  action: 'delete-archived',
  confirmToken: snap2.confirmToken,
  confirmPhrase: '清空归档',
})
eq('清空归档删除 1 条', purge.done, [fixture.archived])
ok('归档 id 已从归档集合移除', !JSON.parse(await readFile(path.join(fixture.home, 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds.includes(fixture.archived))

console.log('== 6. 全部删除')
const snap3 = await manager.buildSnapshot({ issueToken: true })
const delAll = await manager.runAction({
  action: 'delete-all',
  confirmToken: snap3.confirmToken,
  confirmPhrase: '全部删除',
})
// main1 已在第 3 步删除，此时只剩下 sub1
eq('全部删除清掉剩余 1 条', delAll.done.sort(), [fixture.sub1].sort())
eq('无会话被 blocked', delAll.blocked.length, 0)
// main1 是运行中会话，仍在磁盘上；只复核真正被删掉的三个 id
const final = await manager.verify([fixture.sub1, fixture.main2, fixture.archived])
eq('全部删除后复核干净', final.gone, true)
const liveStill = await manager.verify([fixture.main1])
eq('已加载会话也已被彻底删除', liveStill.gone, true)

console.log('== 7. 边界')
const badAction = await manager.runAction({ action: 'nuke-everything' })
eq('未知动作被拒', badAction.error, 'bad-action')
const emptyTarget = await manager.runAction({ action: 'unarchive', ids: [] })
eq('空目标被拒', emptyTarget.error, 'no-target')
eq('formatBytes(0)', formatBytes(0), '0 B')
eq('formatBytes(1536)', formatBytes(1536), '1.50 KB')
eq('formatBytes(1048576)', formatBytes(1048576), '1.00 MB')

await rm(fixture.home, { recursive: true, force: true })

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
  process.exitCode = 1
}