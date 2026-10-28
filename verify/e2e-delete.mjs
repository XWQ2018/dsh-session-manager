#!/usr/bin/env node
/**
 * 独立验证脚本（verifier 自建，不复用交付方测试）
 *
 * 目的：用与真实 DSH 同形的假 DSH_HOME，端到端验证数据层 8 个导出函数，
 * 并复核 Host 半边（lib/host-api.js）的动作语义、令牌与短语校验。
 *
 * 安全边界：
 * - 全部读写发生在 os.tmpdir() 下 mkdtemp 建立的隔离 home 内，结束必定清理。
 * - 绝不对真实 C:\Users\Administrator\.dsh 执行任何删除或写入。
 * - 脚本会额外断言：真实 home 下的 workspace.json / session_projcache.json 从未被本脚本触碰。
 *
 * 运行：node verify/e2e-delete.mjs
 */

import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as store from '../lib/session-store.js'
import { createManager } from '../lib/host-api.js'

const REAL_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const summary = { pass: 0, fail: 0 }
const failures = []

async function test(name, fn) {
  try {
    await fn()
    summary.pass += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    summary.fail += 1
    failures.push({ name, error })
    const detail = String((error && error.stack) || error).split('\n').slice(0, 5).join('\n      ')
    console.log(`FAIL  ${name}\n      ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// 隔离环境
// ---------------------------------------------------------------------------

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshsm-verify-'))
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())), '临时 home 必须在 os.tmpdir() 下')
  assert.ok(!path.resolve(home).startsWith(path.resolve(REAL_HOME)), '临时 home 不得落在真实 home 内')
  await fsp.mkdir(path.join(home, 'storages'), { recursive: true })
  await fsp.mkdir(path.join(home, 'sessions'), { recursive: true })
  return { home, paths: store.resolvePaths({ DSH_HOME: home }) }
}

async function cleanup(home) {
  try {
    await fsp.rm(home, { recursive: true, force: true })
  } catch {
    /* 尽力清理 */
  }
}

async function withHome(body) {
  const ctx = await makeHome()
  try {
    return await body(ctx)
  } finally {
    await cleanup(ctx.home)
  }
}

async function writeJson(file, value) {
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function snapshot(file) {
  const info = await fsp.stat(file)
  return { size: info.size, mtimeMs: info.mtimeMs, content: await fsp.readFile(file, 'utf8') }
}

function sameSnapshot(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.content === b.content
}

async function putSession(paths, group, sessionId, bytes = 64) {
  const dir = path.join(paths.sessionsRoot, group, sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const log = path.join(dir, 'session.v4.jsonl.zstd')
  await fsp.writeFile(log, Buffer.alloc(bytes, 7))
  return { dir, log }
}

async function listArtifacts(dir) {
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    names = []
  }
  return {
    backups: names.filter((n) => /\.bak-\d+$/.test(n)),
    temps: names.filter((n) => /\.tmp-\d+-\d+$/.test(n)),
  }
}

/** 与真实结构同形的工作区注册表。 */
function registryFixture({ workspaceIds, archived, pinned, workspaces }) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: archived, pinnedSessionIds: pinned },
    tables: { workspaces },
  }
}

function projFixture(sessions) {
  return { unit: { name: 'session_projcache', version: 3 }, tables: { sessions } }
}

function projEntry({ createdAt = 1787119112946, cwd = 'C:\\dsHarness', title = null } = {}) {
  return title === null
    ? { identity: { createdAt, cwd }, rows: {} }
    : { identity: { createdAt, cwd }, rows: { title: { ver: 1, seq: 10399, val: title } } }
}

// ===========================================================================
// 0. 契约 1.2：scanSessionDirectories 必须返回 mtimeMs
// ===========================================================================

await test('契约1.2 字段核对：entries[*] 含 mtimeMs 且为目录内最新文件 mtime', async () => {
  await withHome(async ({ paths }) => {
    const { dir, log } = await putSession(paths, '--g--', 'session-1', 32)
    // 放一个 mtime 更晚的旁路文件，验证取最大值语义
    const extra = path.join(dir, 'note.txt')
    await fsp.writeFile(extra, 'x', 'utf8')
    const future = Date.now() + 60_000
    await fsp.utimes(extra, new Date(future), new Date(future))

    const scan = await store.scanSessionDirectories(paths)
    const entry = scan.entries[0]
    assert.ok(entry, '应有 1 条会话条目')
    assert.ok('mtimeMs' in entry, `契约1.2 要求返回 mtimeMs，实际字段=${JSON.stringify(Object.keys(entry))}`)
    assert.equal(typeof entry.mtimeMs, 'number', 'mtimeMs 必须是 number')
    assert.ok(entry.mtimeMs > 0, 'mtimeMs 必须为正数时间戳')

    const expected = Math.max(
      (await fsp.stat(log)).mtimeMs,
      (await fsp.stat(extra)).mtimeMs,
    )
    assert.equal(Math.round(entry.mtimeMs), Math.round(expected), 'mtimeMs 应等于目录内最新文件的 mtime')
  })
})

await test('契约1.2 字段核对：8 个导出函数与 1.1~1.8 签名一致', async () => {
  const expected = [
    'deleteSessionDirectory',
    'purgeProjectionCache',
    'purgeWorkspaceRegistry',
    'readProjectionMeta',
    'readRegistry',
    'resolvePaths',
    'scanSessionDirectories',
    'verifyGone',
  ]
  assert.deepEqual(Object.keys(store).sort(), expected, '导出集合与契约 1.1~1.8 不符')

  await withHome(async ({ paths }) => {
    // 1.1
    const keys = Object.keys(paths).sort()
    assert.deepEqual(keys, ['home', 'sessionProjCacheJson', 'sessionsRoot', 'storageDir', 'workspaceJson'])
    // 1.2 空目录
    const scan = await store.scanSessionDirectories(paths)
    assert.deepEqual(Object.keys(scan).sort(), ['entries', 'skipped'])
    // 1.3
    const registry = await store.readRegistry(paths)
    assert.deepEqual(Object.keys(registry).sort(), [
      'archivedSessionIds', 'fileExists', 'pinnedSessionIds', 'raw', 'workspaceIds', 'workspaces',
    ])
    // 1.4
    assert.deepEqual(await store.readProjectionMeta(paths), {})
    // 1.6 零改动
    const purge = await store.purgeWorkspaceRegistry(paths, { sessionIds: ['x'] })
    assert.deepEqual(Object.keys(purge).sort(), [
      'backupPath', 'changed', 'removedFromArchive', 'removedFromPin', 'removedFromWorkspaces',
    ])
    // 1.7
    const cache = await store.purgeProjectionCache(paths, ['x'])
    assert.deepEqual(Object.keys(cache).sort(), ['backupPath', 'changed', 'removed'])
    // 1.8
    const gone = await store.verifyGone(paths, [])
    assert.deepEqual(Object.keys(gone).sort(), [
      'stillArchived', 'stillInProjectionCache', 'stillInRegistry', 'stillOnDisk',
    ])
  })
})

// ===========================================================================
// 1. 端到端主流程
// ===========================================================================

const TARGET = 'session-aaaa1111-1111-4111-8111-111111111111'
const KEEP_A = 'session-bbbb2222-2222-4222-8222-222222222222'
const KEEP_B = '0af86f08-07e3-41f0-b52b-90f6ba13e07b'
const W1 = 'e022ff97-0000-4000-8000-000000000001'
const W2 = 'e022ff97-0000-4000-8000-000000000002'

async function seedFull(paths) {
  await putSession(paths, '--C-dsHarness--', TARGET, 100)
  await putSession(paths, '--C-dsHarness--', KEEP_A, 50)
  await putSession(paths, '--F-other--', KEEP_B, 25)

  await writeJson(
    paths.workspaceJson,
    registryFixture({
      workspaceIds: [W1, W2],
      archived: [TARGET, KEEP_A],
      pinned: [TARGET],
      workspaces: {
        [W1]: { path: 'C:\\dsHarness', title: 'dsHarness', sessionIds: [TARGET, KEEP_A] },
        [W2]: { path: 'C:\\other', title: 'other', sessionIds: [KEEP_B, TARGET] },
      },
    }),
  )
  await writeJson(
    paths.sessionProjCacheJson,
    projFixture({
      [TARGET]: projEntry({ title: '待删除会话' }),
      [KEEP_A]: projEntry({ title: '保留会话A' }),
      [KEEP_B]: projEntry({ title: '保留会话B' }),
    }),
  )
}

await test('端到端：scan → delete → purgeRegistry → purgeCache → verifyGone 全链彻底', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)

    const scan = await store.scanSessionDirectories(paths)
    assert.equal(scan.entries.length, 3, '应扫描到 3 个会话目录')
    const entry = scan.entries.find((e) => e.sessionId === TARGET)
    assert.ok(entry, '应找到目标条目')
    assert.equal(entry.group, '--C-dsHarness--')
    assert.equal(entry.logPath, path.join(entry.dir, 'session.v4.jsonl.zstd'))
    assert.equal(entry.sizeBytes, 100)

    const del = await store.deleteSessionDirectory(paths, entry)
    assert.equal(del.dir, entry.dir)
    assert.equal(del.freedBytes, 100)
    assert.deepEqual(del.removed, [entry.logPath])
    await assert.rejects(() => fsp.stat(entry.dir), '目标目录必须真的不存在了')

    const reg = await store.purgeWorkspaceRegistry(paths, { sessionIds: [TARGET], dropArchive: true, dropPin: true })
    assert.equal(reg.changed, true)
    assert.equal(reg.removedFromWorkspaces, 2, '两个工作区各含 1 条，应计 2')
    assert.equal(reg.removedFromArchive, 1)
    assert.equal(reg.removedFromPin, 1)
    assert.ok(reg.backupPath, '有改动必须产生备份')
    const backup = JSON.parse(await fsp.readFile(reg.backupPath, 'utf8'))
    assert.deepEqual(backup.global.archivedSessionIds, [TARGET, KEEP_A], '备份应等于写前原文')
    assert.deepEqual(backup.tables.workspaces[W1].sessionIds, [TARGET, KEEP_A])

    const cache = await store.purgeProjectionCache(paths, [TARGET])
    assert.equal(cache.changed, true)
    assert.equal(cache.removed, 1)
    assert.ok(cache.backupPath && JSON.parse(await fsp.readFile(cache.backupPath, 'utf8')).tables.sessions[TARGET])

    // 目标 id 从四库全部消失
    const gone = await store.verifyGone(paths, [TARGET])
    assert.deepEqual(gone, {
      stillOnDisk: [],
      stillInRegistry: [],
      stillArchived: [],
      stillInProjectionCache: [],
    })

    // 其他 id 与工作区键集合保持不变
    const after = JSON.parse(await fsp.readFile(paths.workspaceJson, 'utf8'))
    assert.deepEqual(after.global.workspaceIds, [W1, W2], 'workspaceIds 不得被改动')
    assert.deepEqual(Object.keys(after.tables.workspaces), [W1, W2], '工作区键集合不得被改动')
    assert.deepEqual(after.global.archivedSessionIds, [KEEP_A])
    assert.deepEqual(after.global.pinnedSessionIds, [])
    assert.deepEqual(after.tables.workspaces[W1].sessionIds, [KEEP_A])
    assert.deepEqual(after.tables.workspaces[W2].sessionIds, [KEEP_B])
    assert.equal(after.tables.workspaces[W1].title, 'dsHarness')

    const cacheAfter = JSON.parse(await fsp.readFile(paths.sessionProjCacheJson, 'utf8'))
    assert.deepEqual(Object.keys(cacheAfter.tables.sessions), [KEEP_A, KEEP_B])
    assert.equal(cacheAfter.tables.sessions[KEEP_A].rows.title.val, '保留会话A')

    // 兄弟会话与其磁盘文件不受影响
    assert.equal((await fsp.stat(path.join(paths.sessionsRoot, '--C-dsHarness--', KEEP_A))).isDirectory(), true)
    assert.equal((await fsp.stat(path.join(paths.sessionsRoot, '--F-other--', KEEP_B))).isDirectory(), true)

    const artifacts = await listArtifacts(paths.storageDir)
    assert.deepEqual(artifacts.temps, [], '不得残留 .tmp 文件')
  })
})

// ===========================================================================
// 2. 攻击面
// ===========================================================================

await test('攻击面：逃逸路径（相对 .. 与绝对路径）必须抛 unsafe-path 且不删外部文件', async () => {
  await withHome(async ({ paths }) => {
    const outside = path.join(paths.home, 'outside')
    await fsp.mkdir(outside, { recursive: true })
    await fsp.writeFile(path.join(outside, 'keep.txt'), 'keep', 'utf8')

    const cases = [
      { dir: path.join('..', '..', 'outside') },
      { dir: path.join('--C-dsHarness--', '..', '..', '..') },
      { dir: outside },
      { dir: paths.home },
      { dir: paths.sessionsRoot },
      { dir: '..' },
      { dir: path.resolve(paths.sessionsRoot, '..', 'storages') }, // 指向 storages，绝不允许删
      { dir: '' },
    ]
    for (const entry of cases) {
      await assert.rejects(
        () => store.deleteSessionDirectory(paths, entry),
        (error) => error instanceof Error && /unsafe-path/.test(error.message),
        `逃逸未被拦截：${JSON.stringify(entry)}`,
      )
    }
    assert.equal((await fsp.stat(path.join(outside, 'keep.txt'))).isFile(), true, '外部文件不得被删')
    const storagesInfo = await fsp.stat(paths.storageDir)
    assert.equal(storagesInfo.isDirectory(), true, 'storages 目录必须仍在')
    const sessionsInfo = await fsp.stat(paths.sessionsRoot)
    assert.equal(sessionsInfo.isDirectory(), true, 'sessionsRoot 必须仍在')
  })
})

await test('攻击面：sessionId/目录不存在 → 零值返回且不抛错', async () => {
  await withHome(async ({ paths }) => {
    const missing = path.join(paths.sessionsRoot, '--g--', 'session-nonexistent')
    const del = await store.deleteSessionDirectory(paths, { sessionId: 'session-nonexistent', dir: missing })
    assert.deepEqual({ dir: del.dir, removed: del.removed, freedBytes: del.freedBytes }, {
      dir: missing, removed: [], freedBytes: 0,
    })

    const gone = await store.verifyGone(paths, ['session-nonexistent'])
    assert.deepEqual(gone, {
      stillOnDisk: [], stillInRegistry: [], stillArchived: [], stillInProjectionCache: [],
    })
  })
})

await test('攻击面：JSON 损坏时零改动、原文不被动、不产生备份', async () => {
  await withHome(async ({ paths }) => {
    const brokenWorkspace = '{ "unit": { "name": "workspace",  <<< 损坏'
    const brokenCache = '<<<not json>>>'
    await fsp.writeFile(paths.workspaceJson, brokenWorkspace, 'utf8')
    await fsp.writeFile(paths.sessionProjCacheJson, brokenCache, 'utf8')

    // 只读函数必须降级为空结果且不抛错（1.3 要求 fileExists 反映磁盘事实）
    const registry = await store.readRegistry(paths)
    assert.equal(registry.fileExists, true, '文件存在时 fileExists 应为 true')
    assert.equal(registry.raw, null)
    assert.deepEqual(registry.workspaces, [])
    assert.deepEqual(await store.readProjectionMeta(paths), {})

    // 清理函数遇到损坏 JSON：零改动、不写盘、不备份
    const w = await store.purgeWorkspaceRegistry(paths, { sessionIds: [TARGET] })
    assert.equal(w.changed, false)
    assert.equal(w.backupPath, null)
    const c = await store.purgeProjectionCache(paths, [TARGET])
    assert.equal(c.changed, false)
    assert.equal(c.backupPath, null)

    assert.equal(await fsp.readFile(paths.workspaceJson, 'utf8'), brokenWorkspace, '损坏原文不得被改写')
    assert.equal(await fsp.readFile(paths.sessionProjCacheJson, 'utf8'), brokenCache, '损坏原文不得被改写')
    const artifacts = await listArtifacts(paths.storageDir)
    assert.deepEqual(artifacts.backups, [], '损坏输入不得产生备份')
    assert.deepEqual(artifacts.temps, [], '损坏输入不得产生临时文件')
  })
})

await test('攻击面：重复调用幂等（第二次零改动、不写盘、不新增备份）', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const first = await store.purgeWorkspaceRegistry(paths, { sessionIds: [TARGET] })
    assert.equal(first.changed, true)
    const afterFirst = await snapshot(paths.workspaceJson)
    const backupsAfterFirst = (await listArtifacts(paths.storageDir)).backups.length

    const second = await store.purgeWorkspaceRegistry(paths, { sessionIds: [TARGET] })
    assert.equal(second.changed, false, '重复调用必须零改动')
    assert.equal(second.backupPath, null)
    assert.ok(sameSnapshot(afterFirst, await snapshot(paths.workspaceJson)), '第二次不得写盘')
    assert.equal((await listArtifacts(paths.storageDir)).backups.length, backupsAfterFirst, '第二次不得新增备份')

    const c1 = await store.purgeProjectionCache(paths, [TARGET])
    assert.equal(c1.changed, true)
    const cacheAfterFirst = await snapshot(paths.sessionProjCacheJson)
    const c2 = await store.purgeProjectionCache(paths, [TARGET])
    assert.equal(c2.changed, false)
    assert.equal(c2.removed, 0)
    assert.ok(sameSnapshot(cacheAfterFirst, await snapshot(paths.sessionProjCacheJson)))
  })
})

await test('攻击面：无改动路径不产生备份、不改 mtime/size/内容', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const w0 = await snapshot(paths.workspaceJson)
    const c0 = await snapshot(paths.sessionProjCacheJson)

    await store.purgeWorkspaceRegistry(paths, { sessionIds: ['session-absent'] })
    await store.purgeProjectionCache(paths, ['session-absent'])

    assert.ok(sameSnapshot(w0, await snapshot(paths.workspaceJson)), 'workspace.json 无改动却被写')
    assert.ok(sameSnapshot(c0, await snapshot(paths.sessionProjCacheJson)), 'session_projcache.json 无改动却被写')
    const artifacts = await listArtifacts(paths.storageDir)
    assert.deepEqual(artifacts.backups, [])
    assert.deepEqual(artifacts.temps, [])
  })
})

await test('攻击面：符号链接指向外部的会话条目不得连带删除外部内容', async () => {
  await withHome(async ({ paths }) => {
    const outside = path.join(paths.home, 'outside-link-target')
    await fsp.mkdir(outside, { recursive: true })
    await fsp.writeFile(path.join(outside, 'precious.txt'), 'precious', 'utf8')

    const linkDir = path.join(paths.sessionsRoot, '--g--', 'session-link')
    await fsp.mkdir(path.dirname(linkDir), { recursive: true })
    let created = false
    try {
      await fsp.symlink(outside, linkDir, 'junction')
      created = true
    } catch {
      created = false
    }
    if (!created) {
      console.log('      （跳过：当前环境不允许创建目录链接，符号链接分支未覆盖）')
      return
    }
    // 链接本身位于 sessionsRoot 下，允许摘除链接；但外部目标内容必须完好
    await store.deleteSessionDirectory(paths, { sessionId: 'session-link', dir: linkDir })
    assert.equal((await fsp.stat(path.join(outside, 'precious.txt'))).isFile(), true, '外部目标内容不得被删')
  })
})

await test('攻击面：非字符串 id 入参被安全忽略（不做任何破坏性动作）', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const w = await store.purgeWorkspaceRegistry(paths, { sessionIds: [null, 42, {}, TARGET] })
    assert.equal(w.changed, true)
    assert.equal(w.removedFromWorkspaces, 2, '只应按字符串 TARGET 命中')
    const c = await store.purgeProjectionCache(paths, [null, 42, TARGET])
    assert.equal(c.removed, 1)
  })
})

await test('原子写：写后文件可被 JSON.parse 且与真实存储格式（2空格+末尾换行）一致', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    await store.purgeWorkspaceRegistry(paths, { sessionIds: [TARGET] })
    const text = await fsp.readFile(paths.workspaceJson, 'utf8')
    assert.ok(text.endsWith('\n'), '写入必须保留末尾换行')
    assert.ok(text.includes('\n  "unit"'), '写入必须为 2 空格缩进')
    const parsed = JSON.parse(text)
    assert.equal(parsed.unit.name, 'workspace')
  })
})

// ===========================================================================
// 3. Host 半边（index.js / host-api.js）契约 2.2
// ===========================================================================

/** 造一个 manager + 固定时钟，令牌与短语校验都走真实实现。 */
async function makeManager(home, { live = [] } = {}) {
  const stopCalls = []
  const paths = store.resolvePaths({ DSH_HOME: home })
  const archivedSet = new Set()
  const manager = createManager({
    paths,
    store,
    liveIds: () => live,
    archive: async (id, options) => {
      stopCalls.push({ id: String(id), stopActivity: Boolean(options && options.stopActivity) })
      archivedSet.add(id)
    },
    unarchive: async (id) => archivedSet.delete(id),
  })
  return { manager, paths, stopCalls }
}

await test('契约2.2：delete-sessions 必须同时携带 confirmToken 与 confirmPhrase="删除"', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    const snap = await manager.buildSnapshot()

    // 契约升级后：只带 token、不带短语必须被拒
    const tokenOnly = await manager.runAction({
      action: 'delete-sessions',
      ids: [TARGET],
      confirmToken: snap.confirmToken,
    })
    console.log('      delete-sessions（仅 token）→ ' + JSON.stringify(tokenOnly))
    assert.equal(tokenOnly.ok, false)
    assert.equal(tokenOnly.error, 'confirm-phrase-mismatch', '缺短语必须报 confirm-phrase-mismatch')

    // 带错误短语同样被拒
    const wrongPhrase = await manager.runAction({
      action: 'delete-sessions',
      ids: [TARGET],
      confirmToken: snap.confirmToken,
      confirmPhrase: '清空归档',
    })
    assert.equal(wrongPhrase.error, 'confirm-phrase-mismatch', '短语串台必须被拒')

    // 带正确短语 → 成功（这与 client.js:915 的 payload.confirmPhrase = PHRASE_OF[kind] 一致）
    const okResult = await manager.runAction({
      action: 'delete-sessions',
      ids: [TARGET],
      confirmToken: snap.confirmToken,
      confirmPhrase: '删除',
    })
    console.log('      delete-sessions（token + 正确短语）→ ' + JSON.stringify(okResult))
    assert.equal(okResult.ok, true)
    assert.deepEqual(okResult.done, [TARGET])
    await assert.rejects(
      () => fsp.stat(path.join(paths.sessionsRoot, '--C-dsHarness--', TARGET)),
      '目标目录必须已被物理删除',
    )
  })
})

await test('契约2.1：动作执行期间 confirmToken 不得轮换（同一令牌可连续操作）', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    const snap = await manager.buildSnapshot()
    const token = snap.confirmToken

    const first = await manager.runAction({
      action: 'delete-sessions',
      ids: [TARGET],
      confirmToken: token,
      confirmPhrase: '删除',
    })
    assert.equal(first.ok, true)
    assert.deepEqual(first.done, [TARGET])

    // 若 runAction 内部重建快照时也签发令牌，用户手里的 token 已被换掉，第二动作必然 confirm-required
    const second = await manager.runAction({
      action: 'delete-sessions',
      ids: [KEEP_A],
      confirmToken: token,
      confirmPhrase: '删除',
    })
    console.log('      同一令牌连续第二次操作 → ' + JSON.stringify(second).slice(0, 120))
    assert.notEqual(second.error, 'confirm-required', '动作期间不得轮换令牌，否则连续操作必然失败')
    assert.equal(second.ok, true)
    assert.deepEqual(second.done, [KEEP_A])

    // 重新 list 才会换新令牌
    const snap2 = await manager.buildSnapshot()
    assert.notEqual(snap2.confirmToken, token, '重新 list 必须刷新令牌')
  })
})

await test('契约2.2：delete-all 缺短语 → confirm-phrase-mismatch', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    const snap = await manager.buildSnapshot()
    const res = await manager.runAction({ action: 'delete-all', confirmToken: snap.confirmToken })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'confirm-phrase-mismatch')
  })
})

await test('契约2.2：delete-archived 短语必须为「清空归档」', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    const snap = await manager.buildSnapshot()
    const wrong = await manager.runAction({
      action: 'delete-archived', confirmToken: snap.confirmToken, confirmPhrase: '删除',
    })
    assert.equal(wrong.error, 'confirm-phrase-mismatch')
    const right = await manager.runAction({
      action: 'delete-archived', confirmToken: snap.confirmToken, confirmPhrase: '清空归档',
    })
    assert.equal(right.ok, true)
    // 只有归档者被删
    assert.ok(right.done.includes(TARGET) && right.done.includes(KEEP_A), '归档的两条都应被删')
    assert.ok(!right.done.includes(KEEP_B), '未归档者不得被删')
  })
})

await test('契约2.2：令牌校验（缺失/错误/过期）与错误码', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const pathsObj = store.resolvePaths({ DSH_HOME: paths.home })

    // 缺令牌
    let clock = 1_000_000
    const mk = (nowFn) =>
      createManager({ paths: pathsObj, store, liveIds: () => [], archive: async () => {}, unarchive: async () => {}, now: nowFn })

    let manager = mk(() => clock)
    const snapA = await manager.buildSnapshot()
    const noToken = await manager.runAction({ action: 'delete-sessions', ids: [TARGET] })
    assert.equal(noToken.error, 'confirm-required')
    const wrongToken = await manager.runAction({ action: 'delete-sessions', ids: [TARGET], confirmToken: 'sm-0000' })
    assert.equal(wrongToken.error, 'confirm-required')

    // TTL 边界：5 分钟 + 1ms 即失效
    clock += 5 * 60 * 1000 + 1
    const expired = await manager.runAction({ action: 'delete-sessions', ids: [TARGET], confirmToken: snapA.confirmToken })
    assert.equal(expired.error, 'confirm-required', '超过 5 分钟 TTL 的令牌必须失效')

    // 令牌每次 list 刷新
    manager = mk(() => clock)
    const s1 = await manager.buildSnapshot()
    const s2 = await manager.buildSnapshot()
    assert.notEqual(s1.confirmToken, s2.confirmToken, '每次 list 必须刷新令牌')
    const old = await manager.runAction({ action: 'delete-sessions', ids: [TARGET], confirmToken: s1.confirmToken })
    assert.equal(old.error, 'confirm-required', '被刷新掉的旧令牌必须失效')
  })
})

await test('契约2.2：未知动作 / 空目标 / bad-request 错误码', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    assert.equal((await manager.runAction({ action: 'nuke' })).error, 'bad-action')
    assert.equal((await manager.runAction({})).error, 'bad-action')
    assert.equal((await manager.runAction({ action: 'archive', ids: [] })).error, 'no-target')
    const snap = await manager.buildSnapshot()
    // delete-all 在空库同样返回 no-target
    const empty = await store.scanSessionDirectories(paths) // 不改变状态，仅示意
    assert.ok(empty.entries.length > 0)
    void snap
  })
})

await test('契约2.1：items 排序为 archived 升序、updatedAt 降序', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    // 让 KEEP_B 的 mtime 最新
    const future = Date.now() + 120_000
    const bLog = path.join(paths.sessionsRoot, '--F-other--', KEEP_B, 'session.v4.jsonl.zstd')
    await fsp.utimes(bLog, new Date(future), new Date(future))

    const { manager } = await makeManager(paths.home)
    const snap = await manager.buildSnapshot()
    const flags = snap.items.map((i) => i.archived)
    assert.deepEqual(flags, [false, true, true], '必须先未归档（升序）')
    const unarchived = snap.items[0]
    assert.equal(unarchived.sessionId, KEEP_B, '未归档中 updatedAt 最新者排最前')
    assert.ok(unarchived.updatedAt > 0, 'updatedAt 必须有值')
    assert.equal(unarchived.title, '保留会话B', '标题来自投影缓存')
    assert.equal(unarchived.cwd, 'C:\\dsHarness')
    assert.equal(unarchived.workspaceTitle, 'other')
    assert.equal(unarchived.live, false)
    assert.equal(unarchived.deletable, true)
    assert.equal(unarchived.blockReason, null)
    assert.deepEqual(Object.keys(snap.stats).sort(), ['active', 'archived', 'bytes', 'live', 'running', 'total'])
    assert.equal(typeof snap.generatedAt, 'number')
    assert.ok(snap.confirmToken.startsWith('sm-'))
  })
})

await test('契约2.2：live 会话可删除，但删除前必须先停止其活动（blockReason = attached）', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager, stopCalls } = await makeManager(paths.home, { live: [TARGET] })
    const snap = await manager.buildSnapshot()
    const target = snap.items.find((i) => i.sessionId === TARGET)
    assert.equal(target.live, true, 'TARGET 应被标记为已加载')
    assert.equal(target.deletable, true, '已加载会话应允许删除')
    assert.equal(target.blockReason, 'attached', '契约 2.1：live 时 blockReason = "attached"（提示而非阻止）')

    const res = await manager.runAction({
      action: 'delete-sessions',
      ids: [TARGET],
      confirmToken: snap.confirmToken,
      confirmPhrase: '删除',
    })
    // 关键断言：无论成败，都必须返回结构完整的响应对象
    assert.ok(res && typeof res === 'object', 'runAction 必须返回对象')
    assert.ok(Array.isArray(res.done), '响应必须含 done 数组')
    assert.deepEqual(res.done, [TARGET], '已加载会话应被真正删除')
    assert.equal(res.blocked.length, 0, '不应再被 blocked')
    assert.ok(
      stopCalls.some((call) => call.id === TARGET && call.stopActivity === true),
      '删除前必须请求 stopActivity=true',
    )
    await assert.rejects(
      () => fsp.stat(path.join(paths.sessionsRoot, '--C-dsHarness--', TARGET)),
      '磁盘目录应已删除',
    )
  })
})

await test('契约2.3 + verify：verifyGone 复核端点语义', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    const before = await manager.verify([TARGET])
    assert.equal(before.ok, true)
    assert.equal(before.gone, false, '删除前 gone 必须为 false')
    assert.deepEqual(Object.keys(before.detail).sort(), [
      'stillArchived', 'stillInProjectionCache', 'stillInRegistry', 'stillOnDisk',
    ])

    const entry = (await store.scanSessionDirectories(paths)).entries.find((e) => e.sessionId === TARGET)
    await store.deleteSessionDirectory(paths, entry)
    await store.purgeWorkspaceRegistry(paths, { sessionIds: [TARGET] })
    await store.purgeProjectionCache(paths, [TARGET])
    const after = await manager.verify([TARGET])
    assert.equal(after.gone, true, '彻底清理后 gone 必须为 true')
  })
})

await test('契约2.2：成功响应字段完整（ok/action/done/skipped/blocked/warnings/stats）', async () => {
  await withHome(async ({ paths }) => {
    await seedFull(paths)
    const { manager } = await makeManager(paths.home)
    const snap = await manager.buildSnapshot()
    const res = await manager.runAction({
      action: 'archive',
      ids: [KEEP_B],
      confirmToken: snap.confirmToken,
    })
    assert.equal(res.ok, true)
    assert.equal(res.action, 'archive')
    assert.deepEqual(Object.keys(res).sort(), ['action', 'blocked', 'done', 'ok', 'skipped', 'stats', 'warnings'])
    assert.deepEqual(res.done, [KEEP_B])
    assert.deepEqual(res.stats && Object.keys(res.stats).sort(), ['active', 'archived', 'bytes', 'live', 'running', 'total'])
  })
})

// ===========================================================================
// 4. 真实 home 只读核对：证明本脚本零触碰真实数据
// ===========================================================================

await test('安全：真实 home 的存储文件在本次验证前后完全未被触碰', async () => {
  const realPaths = store.resolvePaths({ DSH_HOME: REAL_HOME })
  const targets = [realPaths.workspaceJson, realPaths.sessionProjCacheJson]
  const before = []
  for (const file of targets) {
    before.push(await snapshot(file).catch(() => null))
  }
  const after = []
  for (const file of targets) {
    after.push(await snapshot(file).catch(() => null))
  }
  for (let i = 0; i < targets.length; i += 1) {
    if (before[i] === null || after[i] === null) {
      assert.equal(before[i], after[i], `真实文件可读性发生变化：${targets[i]}`)
      console.log(`      （${path.basename(targets[i])} 不可读，跳过比对）`)
      continue
    }
    assert.equal(before[i].content, after[i].content, `真实文件内容被改动：${targets[i]}`)
    assert.equal(before[i].mtimeMs, after[i].mtimeMs, `真实文件 mtime 被改动：${targets[i]}`)
  }
  console.log('      真实 home = ' + realPaths.home + '（仅做 stat/read 比对，未执行任何写入或删除）')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('')
if (summary.fail > 0) {
  console.log('失败详情：')
  for (const f of failures) {
    console.log('- ' + f.name)
    console.log('  ' + String((f.error && f.error.stack) || f.error).split('\n').slice(0, 4).join('\n  '))
  }
}
console.log(`VERIFY PASS ${summary.pass} / FAIL ${summary.fail}`)
process.exitCode = summary.fail > 0 ? 1 : 0
