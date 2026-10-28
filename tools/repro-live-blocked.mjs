/**
 * 最小复现：live 会话在 delete-sessions 时是否被正确 blocked（而非提前 no-target）。
 * 纯隔离环境；运行 node tools/repro-live-blocked.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/session-store.js'
import { createManager } from '../lib/host-api.js'

const TARGET = 'session-aaaa1111-1111-4111-8111-111111111111'
const KEEP_A = 'session-bbbb2222-2222-4222-8222-222222222222'
const KEEP_B = '0af86f08-07e3-41f0-b52b-90f6ba13e07b'
const W1 = 'e022ff97-0000-4000-8000-000000000001'
const W2 = 'e022ff97-0000-4000-8000-000000000002'

const home = await mkdtemp(path.join(tmpdir(), 'dshsm-repro-'))
const paths = store.resolvePaths({ DSH_HOME: home })

async function putSession(group, id, bytes) {
  const dir = path.join(paths.sessionsRoot, group, id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7))
}

await putSession('--C-dsHarness--', TARGET, 100)
await putSession('--C-dsHarness--', KEEP_A, 50)
await putSession('--F-other--', KEEP_B, 25)

await mkdir(paths.storageDir, { recursive: true })
await writeFile(
  paths.workspaceJson,
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [W1, W2], archivedSessionIds: [TARGET, KEEP_A], pinnedSessionIds: [TARGET] },
    tables: {
      workspaces: {
        [W1]: { path: 'C:\\dsHarness', title: 'dsHarness', sessionIds: [TARGET, KEEP_A] },
        [W2]: { path: 'C:\\other', title: 'other', sessionIds: [KEEP_B, TARGET] },
      },
    },
  }),
)
await writeFile(
  paths.sessionProjCacheJson,
  JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: {
      sessions: {
        [TARGET]: { identity: { createdAt: 1787119112946, cwd: 'C:\\dsHarness' }, rows: { title: { ver: 1, seq: 10399, val: '待删除会话' } } },
        [KEEP_A]: { identity: { createdAt: 1787119112946, cwd: 'C:\\dsHarness' }, rows: { title: { ver: 1, seq: 10399, val: '保留会话A' } } },
        [KEEP_B]: { identity: { createdAt: 1787119112946, cwd: 'C:\\dsHarness' }, rows: { title: { ver: 1, seq: 10399, val: '保留会话B' } } },
      },
    },
  }),
)

const manager = createManager({
  paths,
  store,
  liveIds: () => [TARGET],
  archive: async () => {},
  unarchive: async () => {},
})

const snap = await manager.buildSnapshot()
console.log('items:', snap.items.map((i) => ({ id: i.sessionId.slice(0, 24), live: i.live, deletable: i.deletable, archived: i.archived })))
console.log('token:', typeof snap.confirmToken, snap.confirmToken && snap.confirmToken.slice(0, 10))

const res = await manager.runAction({
  action: 'delete-sessions',
  ids: [TARGET],
  confirmToken: snap.confirmToken,
  confirmPhrase: '删除',
})
console.log('runAction 返回:', JSON.stringify(res, null, 2))

await rm(home, { recursive: true, force: true })
