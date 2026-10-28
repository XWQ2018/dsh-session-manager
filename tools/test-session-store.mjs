#!/usr/bin/env node
/**
 * lib/session-store.js 数据层测试。
 *
 * 用法：
 *   node tools/test-session-store.mjs              # 全隔离测试（默认）
 *   DSH_REAL_SMOKE=1 node tools/test-session-store.mjs   # 额外执行“只读”真实数据冒烟
 *
 * 安全边界：
 * - 所有写入、删除、读取都发生在 os.tmpdir() 下 mkdtemp 出来的假 DSH_HOME 内，结束时清理。
 * - 绝不向真实 C:\Users\Administrator\.dsh 做任何写/删操作；真实冒烟默认关闭且仅调用只读函数。
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolvePaths,
  scanSessionDirectories,
  readRegistry,
  readProjectionMeta,
  deleteSessionDirectory,
  purgeWorkspaceRegistry,
  purgeProjectionCache,
  verifyGone,
} from '../lib/session-store.js'

const STORE_SOURCE_PATH = fileURLToPath(new URL('../lib/session-store.js', import.meta.url))
const REAL_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const summary = { pass: 0, fail: 0, skip: 0 }
const failures = []

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------

async function test(name, fn) {
  try {
    await fn()
    summary.pass += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    summary.fail += 1
    failures.push({ name, error })
    const detail = String((error && error.stack) || error)
      .split('\n')
      .slice(0, 6)
      .join('\n      ')
    console.log(`FAIL  ${name}\n      ${detail}`)
  }
}

function skip(name, reason) {
  summary.skip += 1
  console.log(`SKIP  ${name}（${reason}）`)
}

// ---------------------------------------------------------------------------
// 隔离环境辅助
// ---------------------------------------------------------------------------

/** 建立完全隔离的假 DSH_HOME，返回 home/paths。 */
async function makeHome({ sessionsDir = true } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-store-test-'))
  assert.ok(home.startsWith(os.tmpdir()), '临时 home 必须位于 os.tmpdir() 下')
  await fsp.mkdir(path.join(home, 'storages'), { recursive: true })
  if (sessionsDir) await fsp.mkdir(path.join(home, 'sessions'), { recursive: true })
  const paths = resolvePaths({ DSH_HOME: home })
  // 硬隔离断言：任一推导路径都不得落在真实 home 内
  for (const [key, value] of Object.entries(paths)) {
    if (typeof value !== 'string') continue
    assert.ok(path.resolve(value).startsWith(home), `路径未隔离: ${key}=${value}`)
    assert.ok(!path.resolve(value).startsWith(path.resolve(REAL_HOME)), `路径越界到真实 home: ${key}=${value}`)
  }
  return { home, paths }
}

/** 递归恢复可写后删除整棵临时目录。 */
async function cleanup(home) {
  const stack = [home]
  while (stack.length > 0) {
    const current = stack.pop()
    let info = null
    try {
      info = await fsp.lstat(current)
    } catch {
      continue
    }
    try {
      await fsp.chmod(current, info.isDirectory() ? 0o777 : 0o666)
    } catch {
      /* 忽略 */
    }
    if (!info.isDirectory()) continue
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) stack.push(path.join(current, entry.name))
  }
  try {
    await fsp.rm(home, { recursive: true, force: true })
  } catch {
    /* 尽力清理；失败不影响断言结论 */
  }
}

/** 以隔离环境执行一个用例主体，结束后必定清理。 */
async function withHome(options, body) {
  const ctx = await makeHome(options)
  try {
    return await body(ctx)
  } finally {
    await cleanup(ctx.home)
  }
}

/** 写入 JSON（与真实存储一致的 2 空格 + LF + 末尾换行）。 */
async function writeJson(file, value) {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 创建会话目录与文件，files 为 { 文件名: 内容 }。 */
async function putSession(paths, group, sessionId, files = { 'session.v4.jsonl.zstd': 'payload' }, extraDirs = {}) {
  const dir = path.join(paths.sessionsRoot, group, sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const written = {}
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, content, 'utf8')
    written[name] = file
  }
  for (const [name, content] of Object.entries(extraDirs)) {
    const file = path.join(dir, name)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, content, 'utf8')
  }
  return { dir, files: written }
}

/** 文件快照：大小 + mtime + 文本内容。 */
async function snapshot(file) {
  const info = await fsp.stat(file)
  return { size: info.size, mtimeMs: info.mtimeMs, content: await fsp.readFile(file, 'utf8') }
}

function sameSnapshot(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.content === b.content
}

/** 列出 storages 目录里的备份与临时文件。 */
async function listArtifacts(dir) {
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    names = []
  }
  return {
    backups: names.filter((name) => /\.bak-\d+$/.test(name)),
    temps: names.filter((name) => /\.tmp-\d+-\d+$/.test(name)),
  }
}

// ---------------------------------------------------------------------------
// 数据构造辅助
// ---------------------------------------------------------------------------

function registryFixture({
  workspaceIds = ['w1'],
  archived = [],
  pinned = [],
  workspaces = {},
  includeTables = true,
} = {}) {
  const raw = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: archived, pinnedSessionIds: pinned },
  }
  if (includeTables) raw.tables = { workspaces }
  return raw
}

function projCacheFixture(sessions = {}) {
  return { unit: { name: 'session_projcache', version: 3 }, tables: { sessions } }
}

function sessionEntry(sessionId, { createdAt = 1787119112946, cwd = 'C:\\dsHarness', title = `标题-${sessionId}` } = {}) {
  return title === null
    ? { identity: { createdAt, cwd }, rows: {} }
    : { identity: { createdAt, cwd }, rows: { title: { ver: 1, seq: 10399, val: title } } }
}

// ---------------------------------------------------------------------------
// 1.1 resolvePaths
// ---------------------------------------------------------------------------

await test('resolvePaths：从 env.DSH_HOME 推导五个路径', async () => {
  const home = path.join(os.tmpdir(), 'dsh-resolve-probe')
  const paths = resolvePaths({ DSH_HOME: home })
  assert.equal(paths.home, path.resolve(home))
  assert.equal(paths.storageDir, path.join(path.resolve(home), 'storages'))
  assert.equal(paths.workspaceJson, path.join(path.resolve(home), 'storages', 'workspace.json'))
  assert.equal(paths.sessionProjCacheJson, path.join(path.resolve(home), 'storages', 'session_projcache.json'))
  assert.equal(paths.sessionsRoot, path.join(path.resolve(home), 'sessions'))
})

await test('resolvePaths：env 缺失时回退 process.env.DSH_HOME', async () => {
  const home = path.join(os.tmpdir(), 'dsh-resolve-env')
  const original = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(resolvePaths().home, path.resolve(home))
    assert.equal(resolvePaths({}).home, path.resolve(home))
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

await test('resolvePaths：都缺失时回退 <homedir>/.dsh（无写死绝对路径）', async () => {
  const original = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    const paths = resolvePaths({})
    assert.equal(paths.home, path.join(os.homedir(), '.dsh'))
    assert.ok(path.isAbsolute(paths.home))
  } finally {
    if (original !== undefined) process.env.DSH_HOME = original
  }
})

// ---------------------------------------------------------------------------
// 1.2 scanSessionDirectories
// ---------------------------------------------------------------------------

await test('scanSessionDirectories：sessionsRoot 缺失返回空且不抛错', async () => {
  await withHome({ sessionsDir: false }, async ({ paths }) => {
    const result = await scanSessionDirectories(paths)
    assert.deepEqual(result, { entries: [], skipped: [] })
  })
})

await test('scanSessionDirectories：空 sessionsRoot 返回空', async () => {
  await withHome({}, async ({ paths }) => {
    assert.deepEqual(await scanSessionDirectories(paths), { entries: [], skipped: [] })
  })
})

await test('scanSessionDirectories：多分组 + 带前缀/裸 UUID 两种目录名形态', async () => {
  await withHome({}, async ({ paths }) => {
    const bareUuid = '0af86f08-07e3-41f0-b52b-90f6ba13e07b'
    await putSession(paths, '--C-dsHarness--', 'session-105c4986-1055-4abe-b759-fa6f501f044e')
    await putSession(paths, '--C-dsHarness--', bareUuid)
    await putSession(paths, '--F-git-uniapp-testOcr--', 'session-7b813298-cf51-4c51-8a07-683bf3362aea')

    const { entries } = await scanSessionDirectories(paths)
    assert.equal(entries.length, 3)

    const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
    // 带前缀形态
    const prefixed = byId.get('session-105c4986-1055-4abe-b759-fa6f501f044e')
    assert.ok(prefixed, '缺少带前缀的会话目录')
    assert.equal(prefixed.group, '--C-dsHarness--')
    assert.equal(prefixed.dir, path.join(paths.sessionsRoot, '--C-dsHarness--', 'session-105c4986-1055-4abe-b759-fa6f501f044e'))
    assert.ok(path.isAbsolute(prefixed.dir))
    assert.equal(prefixed.logPath, path.join(prefixed.dir, 'session.v4.jsonl.zstd'))
    // 裸 UUID 形态：目录名本身就是 sessionId
    const bare = byId.get(bareUuid)
    assert.ok(bare, '缺少裸 UUID 会话目录')
    assert.equal(bare.sessionId, bareUuid)
    assert.equal(bare.dir, path.join(paths.sessionsRoot, '--C-dsHarness--', bareUuid))
  })
})

await test('scanSessionDirectories：logPath 取最高版本（无版本视为最低）', async () => {
  await withHome({}, async ({ paths }) => {
    await putSession(paths, 'g', 'session-unversioned', { 'session.jsonl.zstd': 'aaa', 'extra.txt': 'zz' })
    await putSession(paths, 'g', 'session-v3only', { 'session.v3.jsonl.zstd': 'bbbb' })
    const mixed = await putSession(paths, 'g', 'session-v4win', {
      'session.jsonl.zstd': 'c',
      'session.v3.jsonl.zstd': 'cc',
      'session.v4.jsonl.zstd': 'ccc',
    })

    const { entries } = await scanSessionDirectories(paths)
    const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
    assert.equal(byId.get('session-unversioned').logPath, path.join(byId.get('session-unversioned').dir, 'session.jsonl.zstd'))
    assert.equal(byId.get('session-v3only').logPath, path.join(byId.get('session-v3only').dir, 'session.v3.jsonl.zstd'))
    assert.equal(byId.get('session-v4win').logPath, path.join(mixed.dir, 'session.v4.jsonl.zstd'))
  })
})

await test('scanSessionDirectories：logFiles 排序且 sizeBytes 为文件字节总和', async () => {
  await withHome({}, async ({ paths }) => {
    const { dir } = await putSession(paths, 'g', 'session-size', {
      'session.v4.jsonl.zstd': 'AAAA', // 4
      'a-note.txt': 'BB', // 2
      'z-extra.bin': 'CCCCC', // 5
    })
    const { entries } = await scanSessionDirectories(paths)
    const entry = entries[0]
    const expectedFiles = [path.join(dir, 'a-note.txt'), path.join(dir, 'session.v4.jsonl.zstd'), path.join(dir, 'z-extra.bin')]
    assert.deepEqual(entry.logFiles, expectedFiles)
    assert.deepEqual(entry.logFiles, entry.logFiles.slice().sort())
    assert.equal(entry.sizeBytes, 4 + 2 + 5)
  })
})

await test('scanSessionDirectories：无日志目录进 skipped，分组下散落文件被忽略', async () => {
  await withHome({}, async ({ paths }) => {
    await putSession(paths, 'g1', 'session-ok', { 'session.v4.jsonl.zstd': 'x' })
    // 有目录、无 session.*.jsonl.* → skipped
    const noLogDir = path.join(paths.sessionsRoot, 'g1', 'session-nolog')
    await fsp.mkdir(noLogDir, { recursive: true })
    await fsp.writeFile(path.join(noLogDir, 'readme.txt'), 'no log here', 'utf8')
    // 分组下的散落文件 → 既不进 entries 也不进 skipped
    await fsp.writeFile(path.join(paths.sessionsRoot, 'g1', 'stray.txt'), 'stray', 'utf8')
    // 一级散落文件同样忽略
    await fsp.writeFile(path.join(paths.sessionsRoot, 'stray-root.txt'), 'stray', 'utf8')

    const { entries, skipped } = await scanSessionDirectories(paths)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sessionId, 'session-ok')
    assert.deepEqual(skipped, [noLogDir])
  })
})

await test('scanSessionDirectories：结果按 sessionId 升序稳定排序', async () => {
  await withHome({}, async ({ paths }) => {
    const ids = ['session-b', '0af86f08-07e3-41f0-b52b-90f6ba13e07b', 'session-105c4986-1055-4abe-b759-fa6f501f044e', 'session-a']
    for (const id of ids) await putSession(paths, 'g', id)
    const { entries } = await scanSessionDirectories(paths)
    assert.deepEqual(
      entries.map((entry) => entry.sessionId),
      ids.slice().sort(),
    )
  })
})

await test('scanSessionDirectories：entry.mtimeMs 为正数且等于最新文件的 mtime', async () => {
  await withHome({}, async ({ paths }) => {
    const { dir } = await putSession(paths, 'g', 'session-mtime', {
      'session.v3.jsonl.zstd': 'old',
      'session.v4.jsonl.zstd': 'new',
      'note.txt': 'note',
    })
    // 人为构造时间差：note.txt 最新
    const older = new Date(Date.now() - 60_000)
    await fsp.utimes(path.join(dir, 'session.v3.jsonl.zstd'), older, older)
    await fsp.utimes(path.join(dir, 'session.v4.jsonl.zstd'), older, older)
    const newest = await fsp.stat(path.join(dir, 'note.txt'))

    const { entries } = await scanSessionDirectories(paths)
    const entry = entries.find((item) => item.sessionId === 'session-mtime')
    assert.ok(typeof entry.mtimeMs === 'number', 'mtimeMs 必须是 number')
    assert.ok(entry.mtimeMs > 0, 'mtimeMs 必须是正数')
    assert.equal(entry.mtimeMs, newest.mtimeMs)

    // 与目录内所有文件逐一比较：mtimeMs 就是最大值
    const stamps = []
    for (const file of entry.logFiles) stamps.push((await fsp.stat(file)).mtimeMs)
    assert.equal(entry.mtimeMs, Math.max(...stamps))
  })
})

await test('scanSessionDirectories：多分组时 mtimeMs 取各自目录内的最大值', async () => {
  await withHome({}, async ({ paths }) => {
    const a = await putSession(paths, 'g1', 'session-mtime-a', { 'session.v4.jsonl.zstd': 'a' })
    const b = await putSession(paths, 'g2', 'session-mtime-b', { 'session.v4.jsonl.zstd': 'b' })
    const old = new Date(Date.now() - 120_000)
    await fsp.utimes(path.join(a.dir, 'session.v4.jsonl.zstd'), old, old)

    const { entries } = await scanSessionDirectories(paths)
    const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
    assert.equal(byId.get('session-mtime-a').mtimeMs, (await fsp.stat(path.join(a.dir, 'session.v4.jsonl.zstd'))).mtimeMs)
    assert.equal(byId.get('session-mtime-b').mtimeMs, (await fsp.stat(path.join(b.dir, 'session.v4.jsonl.zstd'))).mtimeMs)
    assert.ok(byId.get('session-mtime-b').mtimeMs > byId.get('session-mtime-a').mtimeMs, '较新的目录应有更大的 mtimeMs')
  })
})

await test('scanSessionDirectories：子目录不计入 logFiles/sizeBytes', async () => {
  await withHome({}, async ({ paths }) => {
    const { dir } = await putSession(
      paths,
      'g',
      'session-nested',
      { 'session.v4.jsonl.zstd': 'AAAA' },
      { 'nested/inner.bin': 'BBBBBB' },
    )
    const { entries } = await scanSessionDirectories(paths)
    assert.deepEqual(entries[0].logFiles, [path.join(dir, 'session.v4.jsonl.zstd')])
    assert.equal(entries[0].sizeBytes, 4)
  })
})

// ---------------------------------------------------------------------------
// 1.3 readRegistry
// ---------------------------------------------------------------------------

await test('readRegistry：正常解析全部字段', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.workspaceJson,
      registryFixture({
        workspaceIds: ['w1', 'w2'],
        archived: ['session-arch'],
        pinned: ['session-pin'],
        workspaces: {
          w1: { path: 'C:\\dsHarness', title: 'dsHarness', sessionIds: ['session-a', 'session-b'] },
          w2: { path: null, title: null, sessionIds: [] },
        },
      }),
    )
    const registry = await readRegistry(paths)
    assert.equal(registry.fileExists, true)
    assert.equal(registry.raw.unit.name, 'workspace')
    assert.deepEqual(registry.workspaceIds, ['w1', 'w2'])
    assert.deepEqual(registry.archivedSessionIds, ['session-arch'])
    assert.deepEqual(registry.pinnedSessionIds, ['session-pin'])
    assert.deepEqual(registry.workspaces, [
      { workspaceId: 'w1', title: 'dsHarness', path: 'C:\\dsHarness', sessionIds: ['session-a', 'session-b'] },
      { workspaceId: 'w2', title: null, path: null, sessionIds: [] },
    ])
  })
})

await test('readRegistry：文件缺失不抛错', async () => {
  await withHome({}, async ({ paths }) => {
    const registry = await readRegistry(paths)
    assert.equal(registry.fileExists, false)
    assert.equal(registry.raw, null)
    assert.deepEqual(registry.workspaceIds, [])
    assert.deepEqual(registry.archivedSessionIds, [])
    assert.deepEqual(registry.pinnedSessionIds, [])
    assert.deepEqual(registry.workspaces, [])
  })
})

await test('readRegistry：JSON 损坏不抛错，fileExists 反映磁盘事实', async () => {
  await withHome({}, async ({ paths }) => {
    await fsp.writeFile(paths.workspaceJson, '{ "unit": { "name": "workspace"  <<< 坏掉了', 'utf8')
    const registry = await readRegistry(paths)
    assert.equal(registry.fileExists, true)
    assert.equal(registry.raw, null)
    assert.deepEqual(registry.workspaceIds, [])
    assert.deepEqual(registry.workspaces, [])
  })
})

await test('readRegistry：v1 兼容 global.workspaces 与 raw.workspaces', async () => {
  await withHome({}, async ({ paths }) => {
    // 变体一：tables 为空对象，工作区表落在 global.workspaces
    await writeJson(paths.workspaceJson, {
      unit: { name: 'workspace', version: 1 },
      global: {
        initialized: true,
        workspaceIds: ['w1'],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        workspaces: { w1: { path: 'C:\\x', title: 'X', sessionIds: ['session-1'] } },
      },
      tables: {},
    })
    let registry = await readRegistry(paths)
    assert.deepEqual(registry.workspaces, [{ workspaceId: 'w1', title: 'X', path: 'C:\\x', sessionIds: ['session-1'] }])

    // 变体二：无 tables，工作区表落在 raw.workspaces
    await writeJson(paths.workspaceJson, {
      unit: { name: 'workspace', version: 1 },
      global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
      workspaces: { w1: { path: 'C:\\y', title: 'Y', sessionIds: ['session-2'] } },
    })
    registry = await readRegistry(paths)
    assert.deepEqual(registry.workspaces, [{ workspaceId: 'w1', title: 'Y', path: 'C:\\y', sessionIds: ['session-2'] }])
  })
})

await test('readRegistry：非字符串 id 被过滤、非对象工作区被跳过', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(paths.workspaceJson, {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: ['w1', 123, null, 'w1'],
        archivedSessionIds: ['session-a', 7],
        pinnedSessionIds: null,
      },
      tables: { workspaces: { w1: { path: 'p', title: 't', sessionIds: ['s1', 9] }, broken: 'not-an-object' } },
    })
    const registry = await readRegistry(paths)
    assert.deepEqual(registry.workspaceIds, ['w1', 'w1'])
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
    assert.deepEqual(registry.pinnedSessionIds, [])
    assert.deepEqual(registry.workspaces, [{ workspaceId: 'w1', title: 't', path: 'p', sessionIds: ['s1'] }])
  })
})

// ---------------------------------------------------------------------------
// 1.4 readProjectionMeta
// ---------------------------------------------------------------------------

await test('readProjectionMeta：正常解析 title/createdAt/cwd', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.sessionProjCacheJson,
      projCacheFixture({
        'session-a': sessionEntry('session-a', { createdAt: 1787119112946, cwd: 'C:\\dsHarness', title: '标题A' }),
        'session-b': sessionEntry('session-b', { createdAt: 1, cwd: null, title: '标题B' }),
      }),
    )
    const meta = await readProjectionMeta(paths)
    assert.deepEqual(Object.keys(meta).sort(), ['session-a', 'session-b'])
    assert.deepEqual(meta['session-a'], { title: '标题A', createdAt: 1787119112946, cwd: 'C:\\dsHarness' })
    assert.deepEqual(meta['session-b'], { title: '标题B', createdAt: 1, cwd: null })
  })
})

await test('readProjectionMeta：rows.title 为字符串时回退，缺失字段为 null', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.sessionProjCacheJson,
      projCacheFixture({
        'session-legacy': { identity: { createdAt: 'not-a-number' }, rows: { title: '裸字符串标题' } },
        'session-empty': { identity: {}, rows: {} },
      }),
    )
    const meta = await readProjectionMeta(paths)
    assert.deepEqual(meta['session-legacy'], { title: '裸字符串标题', createdAt: null, cwd: null })
    assert.deepEqual(meta['session-empty'], { title: null, createdAt: null, cwd: null })
  })
})

await test('readProjectionMeta：缺失/损坏/结构缺失均返回 {} 且不抛错', async () => {
  await withHome({}, async ({ paths }) => {
    assert.deepEqual(await readProjectionMeta(paths), {}) // 缺失
    await fsp.writeFile(paths.sessionProjCacheJson, 'not json at all', 'utf8')
    assert.deepEqual(await readProjectionMeta(paths), {}) // 损坏
    await writeJson(paths.sessionProjCacheJson, { unit: { name: 'session_projcache', version: 3 }, tables: {} })
    assert.deepEqual(await readProjectionMeta(paths), {}) // 结构缺失
    await writeJson(paths.sessionProjCacheJson, { unit: { name: 'session_projcache', version: 3 }, tables: { sessions: 'oops' } })
    assert.deepEqual(await readProjectionMeta(paths), {}) // 类型错误
  })
})

await test('readProjectionMeta：非对象条目被跳过', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(paths.sessionProjCacheJson, {
      unit: { name: 'session_projcache', version: 3 },
      tables: { sessions: { 'session-good': sessionEntry('session-good'), 'session-bad': 'broken-entry' } },
    })
    const meta = await readProjectionMeta(paths)
    assert.deepEqual(Object.keys(meta), ['session-good'])
  })
})

// ---------------------------------------------------------------------------
// 1.5 deleteSessionDirectory
// ---------------------------------------------------------------------------

await test('deleteSessionDirectory：删除子树并统计 removed/freedBytes', async () => {
  await withHome({}, async ({ paths }) => {
    const { dir } = await putSession(
      paths,
      'g',
      'session-del',
      { 'session.v4.jsonl.zstd': 'AAAA', 'note.txt': 'BB' },
      { 'nested/inner.bin': 'CCCCCC' },
    )
    const result = await deleteSessionDirectory(paths, { sessionId: 'session-del', dir })
    assert.equal(result.dir, dir)
    assert.equal(existsSync(dir), false)
    assert.deepEqual(result.removed, [
      path.join(dir, 'nested', 'inner.bin'),
      path.join(dir, 'note.txt'),
      path.join(dir, 'session.v4.jsonl.zstd'),
    ])
    assert.deepEqual(result.removed, result.removed.slice().sort())
    assert.equal(result.freedBytes, 4 + 2 + 6)
    assert.ok(
      result.removed.every((file) => !file.endsWith(path.sep)),
      'removed 不应包含目录路径',
    )
  })
})

await test('deleteSessionDirectory：目录不存在返回零值且不抛错', async () => {
  await withHome({}, async ({ paths }) => {
    const dir = path.join(paths.sessionsRoot, 'g', 'session-missing')
    const result = await deleteSessionDirectory(paths, { sessionId: 'session-missing', dir })
    assert.equal(result.dir, dir)
    assert.deepEqual(result.removed, [])
    assert.equal(result.freedBytes, 0)
  })
})

await test('deleteSessionDirectory：拒绝相对路径逃逸（unsafe-path）', async () => {
  await withHome({}, async ({ paths }) => {
    const outside = path.join(paths.home, 'outside')
    await fsp.mkdir(outside, { recursive: true })
    await fsp.writeFile(path.join(outside, 'keep.txt'), 'keep', 'utf8')

    await assert.rejects(() => deleteSessionDirectory(paths, { dir: path.join('..', '..', 'outside') }), /unsafe-path/)
    await assert.rejects(() => deleteSessionDirectory(paths, { dir: path.join('g', '..', '..', '..') }), /unsafe-path/)
    assert.ok(existsSync(path.join(outside, 'keep.txt')), '外部文件不得被删除')
  })
})

await test('deleteSessionDirectory：拒绝绝对路径逃逸与 sessionsRoot 本身', async () => {
  await withHome({}, async ({ paths }) => {
    const outsideDir = path.join(paths.home, 'outside-abs')
    await fsp.mkdir(outsideDir, { recursive: true })
    await fsp.writeFile(path.join(outsideDir, 'keep.txt'), 'keep', 'utf8')

    await assert.rejects(() => deleteSessionDirectory(paths, { dir: outsideDir }), /unsafe-path/)
    await assert.rejects(() => deleteSessionDirectory(paths, { dir: paths.sessionsRoot }), /unsafe-path/)
    await assert.rejects(() => deleteSessionDirectory(paths, { dir: paths.home }), /unsafe-path/)
    await assert.rejects(() => deleteSessionDirectory(paths, { dir: '' }), /unsafe-path/)
    assert.ok(existsSync(paths.sessionsRoot), 'sessionsRoot 不得被删除')
    assert.ok(existsSync(path.join(outsideDir, 'keep.txt')), '外部文件不得被删除')
  })
})

await test('deleteSessionDirectory：接受相对 sessionsRoot 的路径且不影响兄弟会话', async () => {
  await withHome({}, async ({ paths }) => {
    const target = await putSession(paths, 'g', 'session-target', { 'session.v4.jsonl.zstd': 'AA' })
    const sibling = await putSession(paths, 'g', 'session-sibling', { 'session.v4.jsonl.zstd': 'BB' })

    const relative = path.join('g', 'session-target')
    const result = await deleteSessionDirectory(paths, { dir: relative })
    assert.equal(result.dir, relative)
    assert.equal(existsSync(target.dir), false)
    assert.equal(existsSync(sibling.dir), true)
    assert.equal(result.freedBytes, 2)

    // 幂等：再次删除同一目录返回零值
    const again = await deleteSessionDirectory(paths, { dir: relative })
    assert.deepEqual(again.removed, [])
    assert.equal(again.freedBytes, 0)
  })
})

// ---------------------------------------------------------------------------
// 1.6 purgeWorkspaceRegistry
// ---------------------------------------------------------------------------

await test('purgeWorkspaceRegistry：清理三类引用并原子写 + 备份', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.workspaceJson,
      registryFixture({
        workspaceIds: ['w1', 'w2'],
        archived: ['session-del', 'session-arch-keep'],
        pinned: ['session-del'],
        workspaces: {
          w1: { path: 'C:\\dsHarness', title: 'dsHarness', sessionIds: ['session-del', 'session-keep'] },
          w2: { path: 'C:\\x', title: 'X', sessionIds: ['session-del'] },
        },
      }),
    )

    const result = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-del'] })
    assert.equal(result.changed, true)
    assert.equal(result.removedFromWorkspaces, 2)
    assert.equal(result.removedFromArchive, 1)
    assert.equal(result.removedFromPin, 1)
    assert.ok(result.backupPath, '有改动必须产生备份')
    assert.ok(result.backupPath.endsWith('.bak-' + result.backupPath.split('.bak-')[1]))
    assert.ok(existsSync(result.backupPath), '备份文件必须存在')

    // 备份内容 = 写前原文件
    const backup = JSON.parse(await fsp.readFile(result.backupPath, 'utf8'))
    assert.deepEqual(backup.global.archivedSessionIds, ['session-del', 'session-arch-keep'])

    // 写后自校验：重新 parse 且目标 id 全部消失，其余字段保留
    const after = JSON.parse(await fsp.readFile(paths.workspaceJson, 'utf8'))
    assert.equal(after.unit.name, 'workspace')
    assert.equal(after.unit.version, 2)
    assert.equal(after.global.initialized, true)
    assert.deepEqual(after.global.workspaceIds, ['w1', 'w2'])
    assert.deepEqual(after.global.archivedSessionIds, ['session-arch-keep'])
    assert.deepEqual(after.global.pinnedSessionIds, [])
    assert.deepEqual(after.tables.workspaces.w1.sessionIds, ['session-keep'])
    assert.deepEqual(after.tables.workspaces.w2.sessionIds, [])
    assert.deepEqual(Object.keys(after.tables.workspaces), ['w1', 'w2'])

    const artifacts = await listArtifacts(paths.storageDir)
    assert.equal(artifacts.temps.length, 0, '不得残留 .tmp 文件')
  })
})

await test('purgeWorkspaceRegistry：无改动不写盘、不产生备份、mtime 不变', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.workspaceJson,
      registryFixture({ workspaceIds: ['w1'], workspaces: { w1: { path: 'p', title: 't', sessionIds: ['session-keep'] } } }),
    )
    const before = await snapshot(paths.workspaceJson)
    const result = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-nonexistent'] })
    const after = await snapshot(paths.workspaceJson)

    assert.equal(result.changed, false)
    assert.equal(result.backupPath, null)
    assert.equal(result.removedFromWorkspaces, 0)
    assert.equal(result.removedFromArchive, 0)
    assert.equal(result.removedFromPin, 0)
    assert.ok(sameSnapshot(before, after), '无改动时不得写盘（size/mtime/内容均需一致）')
    const artifacts = await listArtifacts(paths.storageDir)
    assert.deepEqual(artifacts.backups, [], '无改动时不得产生备份')
    assert.deepEqual(artifacts.temps, [], '无改动时不得产生临时文件')
  })
})

await test('purgeWorkspaceRegistry：dropArchive/dropPin=false 时保留归档与置顶', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.workspaceJson,
      registryFixture({
        workspaceIds: ['w1'],
        archived: ['session-del'],
        pinned: ['session-del'],
        workspaces: { w1: { path: 'p', title: 't', sessionIds: ['session-del'] } },
      }),
    )
    const result = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-del'], dropArchive: false, dropPin: false })
    assert.equal(result.changed, true)
    assert.equal(result.removedFromWorkspaces, 1)
    assert.equal(result.removedFromArchive, 0)
    assert.equal(result.removedFromPin, 0)

    const after = JSON.parse(await fsp.readFile(paths.workspaceJson, 'utf8'))
    assert.deepEqual(after.global.archivedSessionIds, ['session-del'])
    assert.deepEqual(after.global.pinnedSessionIds, ['session-del'])
    assert.deepEqual(after.tables.workspaces.w1.sessionIds, [])
  })
})

await test('purgeWorkspaceRegistry：空入参 / 缺失 JSON / 损坏 JSON 均零改动不抛错', async () => {
  await withHome({}, async ({ paths }) => {
    assert.deepEqual(await purgeWorkspaceRegistry(paths, { sessionIds: [] }), {
      changed: false,
      backupPath: null,
      removedFromWorkspaces: 0,
      removedFromArchive: 0,
      removedFromPin: 0,
    })
    assert.deepEqual(await purgeWorkspaceRegistry(paths, { sessionIds: [null, 42] }), {
      changed: false,
      backupPath: null,
      removedFromWorkspaces: 0,
      removedFromArchive: 0,
      removedFromPin: 0,
    })
    // 缺失
    const missing = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-x'] })
    assert.equal(missing.changed, false)
    // 损坏
    await fsp.writeFile(paths.workspaceJson, '{ 坏掉的 JSON', 'utf8')
    const broken = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-x'] })
    assert.equal(broken.changed, false)
    assert.equal(await fsp.readFile(paths.workspaceJson, 'utf8'), '{ 坏掉的 JSON')
    const artifacts = await listArtifacts(paths.storageDir)
    assert.deepEqual(artifacts.backups, [])
    assert.deepEqual(artifacts.temps, [])
  })
})

await test('purgeWorkspaceRegistry：重复调用幂等', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.workspaceJson,
      registryFixture({
        workspaceIds: ['w1'],
        archived: ['session-del'],
        pinned: ['session-del'],
        workspaces: { w1: { path: 'p', title: 't', sessionIds: ['session-del', 'session-keep'] } },
      }),
    )
    const first = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-del'] })
    assert.equal(first.changed, true)
    const snapshotAfterFirst = await snapshot(paths.workspaceJson)
    const backupsAfterFirst = (await listArtifacts(paths.storageDir)).backups.length

    const second = await purgeWorkspaceRegistry(paths, { sessionIds: ['session-del'] })
    assert.equal(second.changed, false)
    assert.equal(second.backupPath, null)
    assert.ok(sameSnapshot(snapshotAfterFirst, await snapshot(paths.workspaceJson)), '第二次调用不得写盘')
    assert.equal((await listArtifacts(paths.storageDir)).backups.length, backupsAfterFirst, '第二次调用不得新增备份')
  })
})

await test('purgeWorkspaceRegistry：不动 workspaceIds 与工作区键集合', async () => {
  await withHome({}, async ({ paths }) => {
    const fixture = registryFixture({
      workspaceIds: ['w1', 'w2', 'w3'],
      archived: ['session-del'],
      workspaces: {
        w1: { path: 'p1', title: 't1', sessionIds: ['session-del'] },
        w2: { path: 'p2', title: 't2', sessionIds: [] },
        w3: { path: 'p3', title: 't3', sessionIds: ['session-x'] },
      },
    })
    await writeJson(paths.workspaceJson, fixture)
    await purgeWorkspaceRegistry(paths, { sessionIds: ['session-del'] })
    const after = JSON.parse(await fsp.readFile(paths.workspaceJson, 'utf8'))
    assert.deepEqual(after.global.workspaceIds, ['w1', 'w2', 'w3'])
    assert.deepEqual(Object.keys(after.tables.workspaces), ['w1', 'w2', 'w3'])
    assert.equal(after.tables.workspaces.w2.title, 't2')
    assert.equal(after.tables.workspaces.w2.path, 'p2')
  })
})

// ---------------------------------------------------------------------------
// 1.7 purgeProjectionCache
// ---------------------------------------------------------------------------

await test('purgeProjectionCache：删除键并原子写 + 计数 + 备份', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.sessionProjCacheJson,
      projCacheFixture({
        'session-del-1': sessionEntry('session-del-1', { title: '删我1' }),
        'session-del-2': sessionEntry('session-del-2', { title: '删我2' }),
        'session-keep': sessionEntry('session-keep', { title: '保留' }),
      }),
    )
    const result = await purgeProjectionCache(paths, ['session-del-1', 'session-del-2', 'session-missing'])
    assert.equal(result.changed, true)
    assert.equal(result.removed, 2)
    assert.ok(result.backupPath && existsSync(result.backupPath))

    const after = JSON.parse(await fsp.readFile(paths.sessionProjCacheJson, 'utf8'))
    assert.equal(after.unit.name, 'session_projcache')
    assert.deepEqual(Object.keys(after.tables.sessions), ['session-keep'])
    assert.equal(after.tables.sessions['session-keep'].rows.title.val, '保留')
    assert.deepEqual((await listArtifacts(paths.storageDir)).temps, [])
  })
})

await test('purgeProjectionCache：无改动不写盘、无备份、mtime 不变', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(paths.sessionProjCacheJson, projCacheFixture({ 'session-keep': sessionEntry('session-keep') }))
    const before = await snapshot(paths.sessionProjCacheJson)
    const result = await purgeProjectionCache(paths, ['session-missing'])
    assert.equal(result.changed, false)
    assert.equal(result.removed, 0)
    assert.equal(result.backupPath, null)
    assert.ok(sameSnapshot(before, await snapshot(paths.sessionProjCacheJson)))
    assert.deepEqual((await listArtifacts(paths.storageDir)).backups, [])
  })
})

await test('purgeProjectionCache：缺失/损坏 JSON 与空入参均零改动不抛错', async () => {
  await withHome({}, async ({ paths }) => {
    assert.deepEqual(await purgeProjectionCache(paths, []), { changed: false, removed: 0, backupPath: null })
    const missing = await purgeProjectionCache(paths, ['session-x'])
    assert.equal(missing.changed, false)
    await fsp.writeFile(paths.sessionProjCacheJson, '<<<broken>>>', 'utf8')
    const broken = await purgeProjectionCache(paths, ['session-x'])
    assert.equal(broken.changed, false)
    assert.equal(broken.backupPath, null)
    assert.equal(await fsp.readFile(paths.sessionProjCacheJson, 'utf8'), '<<<broken>>>')
    assert.deepEqual((await listArtifacts(paths.storageDir)).backups, [])
  })
})

await test('purgeProjectionCache：重复调用幂等', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.sessionProjCacheJson,
      projCacheFixture({ 'session-del': sessionEntry('session-del'), 'session-keep': sessionEntry('session-keep') }),
    )
    const first = await purgeProjectionCache(paths, ['session-del'])
    assert.equal(first.changed, true)
    const snapshotAfterFirst = await snapshot(paths.sessionProjCacheJson)

    const second = await purgeProjectionCache(paths, ['session-del'])
    assert.equal(second.changed, false)
    assert.equal(second.removed, 0)
    assert.ok(sameSnapshot(snapshotAfterFirst, await snapshot(paths.sessionProjCacheJson)))
  })
})

// ---------------------------------------------------------------------------
// 1.8 verifyGone
// ---------------------------------------------------------------------------

/** 构造一个“四库全命中”的环境。 */
async function putFullSession(paths, sessionId) {
  const group = '--C-dsHarness--'
  const session = await putSession(paths, group, sessionId)
  await writeJson(
    paths.workspaceJson,
    registryFixture({
      workspaceIds: ['w1'],
      archived: [sessionId],
      pinned: [sessionId],
      workspaces: { w1: { path: 'C:\\dsHarness', title: 'dsHarness', sessionIds: [sessionId, 'session-keep'] } },
    }),
  )
  await writeJson(
    paths.sessionProjCacheJson,
    projCacheFixture({ [sessionId]: sessionEntry(sessionId), 'session-keep': sessionEntry('session-keep') }),
  )
  return session
}

await test('verifyGone：删除前四项全部命中', async () => {
  await withHome({}, async ({ paths }) => {
    const sessionId = 'session-del-1'
    await putFullSession(paths, sessionId)
    const detail = await verifyGone(paths, [sessionId])
    assert.deepEqual(detail, {
      stillOnDisk: [sessionId],
      stillInRegistry: [sessionId],
      stillArchived: [sessionId],
      stillInProjectionCache: [sessionId],
    })
    assert.deepEqual(Object.keys(detail), ['stillOnDisk', 'stillInRegistry', 'stillArchived', 'stillInProjectionCache'])
  })
})

await test('verifyGone：完整清理后四项全空', async () => {
  await withHome({}, async ({ paths }) => {
    const sessionId = 'session-del-2'
    const session = await putFullSession(paths, sessionId)

    const deleted = await deleteSessionDirectory(paths, { sessionId, dir: session.dir })
    assert.equal(deleted.freedBytes > 0, true)
    const registry = await purgeWorkspaceRegistry(paths, { sessionIds: [sessionId] })
    assert.equal(registry.changed, true)
    const projection = await purgeProjectionCache(paths, [sessionId])
    assert.equal(projection.removed, 1)

    const detail = await verifyGone(paths, [sessionId])
    assert.deepEqual(detail, {
      stillOnDisk: [],
      stillInRegistry: [],
      stillArchived: [],
      stillInProjectionCache: [],
    })
  })
})

await test('verifyGone：只删磁盘时其余三项仍残留', async () => {
  await withHome({}, async ({ paths }) => {
    const sessionId = 'session-del-3'
    const session = await putFullSession(paths, sessionId)
    await deleteSessionDirectory(paths, { sessionId, dir: session.dir })

    const detail = await verifyGone(paths, [sessionId])
    assert.deepEqual(detail.stillOnDisk, [])
    assert.deepEqual(detail.stillInRegistry, [sessionId])
    assert.deepEqual(detail.stillArchived, [sessionId])
    assert.deepEqual(detail.stillInProjectionCache, [sessionId])
    // 同批未处理的会话不受影响
    const keep = await verifyGone(paths, ['session-keep'])
    assert.deepEqual(keep.stillOnDisk, [])
    assert.deepEqual(keep.stillInRegistry, ['session-keep'])
  })
})

await test('verifyGone：空入参 / 未知 id 返回空结构', async () => {
  await withHome({}, async ({ paths }) => {
    const empty = await verifyGone(paths, [])
    assert.deepEqual(empty, { stillOnDisk: [], stillInRegistry: [], stillArchived: [], stillInProjectionCache: [] })
    const unknown = await verifyGone(paths, ['session-unknown', null, 5])
    assert.deepEqual(unknown, { stillOnDisk: [], stillInRegistry: [], stillArchived: [], stillInProjectionCache: [] })
  })
})

// ---------------------------------------------------------------------------
// 原子写安全网
// ---------------------------------------------------------------------------

/** 探测当前平台 “rename 覆盖只读文件” 是否会失败（Windows 为 EPERM）。 */
async function probeReadonlyRename() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-store-probe-'))
  try {
    const target = path.join(dir, 'probe.json')
    await fsp.writeFile(target, '{"a":1}', 'utf8')
    await fsp.writeFile(`${target}.tmp`, '{"a":2}', 'utf8')
    await fsp.chmod(target, 0o444)
    try {
      await fsp.rename(`${target}.tmp`, target)
      return false // 平台允许覆盖，无法构造失败场景
    } catch {
      return true
    } finally {
      await fsp.chmod(target, 0o666).catch(() => {})
    }
  } finally {
    await cleanup(dir)
  }
}

const readonlyRenameFails = await probeReadonlyRename()

if (readonlyRenameFails) {
  await test('原子写安全网：rename 失败时抛错、原文件未被篡改、无 tmp/bak 残留', async () => {
    await withHome({}, async ({ paths }) => {
      const sessionId = 'session-ro'
      const original = projCacheFixture({ [sessionId]: sessionEntry(sessionId), 'session-keep': sessionEntry('session-keep') })
      await writeJson(paths.sessionProjCacheJson, original)
      const before = await snapshot(paths.sessionProjCacheJson)
      await fsp.chmod(paths.sessionProjCacheJson, 0o444) // Windows：rename 覆盖只读文件将失败

      await assert.rejects(
        () => purgeProjectionCache(paths, [sessionId]),
        (error) => error && (error.code === 'EPERM' || error.code === 'EACCES'),
      )

      await fsp.chmod(paths.sessionProjCacheJson, 0o666)
      const after = await snapshot(paths.sessionProjCacheJson)
      assert.equal(after.content, before.content, '写失败时原文件内容必须保持原样')
      assert.ok(after.content.includes(sessionId), '目标键不得被删除')
      const artifacts = await listArtifacts(paths.storageDir)
      assert.deepEqual(artifacts.temps, [], '失败后不得残留 .tmp 文件')
      assert.deepEqual(artifacts.backups, [], '失败后不得残留 .bak 文件')
    })
  })
} else {
  skip('原子写安全网：rename 失败时抛错、原文件未被篡改、无 tmp/bak 残留', '当前平台允许 rename 覆盖只读文件，无法构造失败场景')
}

// ---------------------------------------------------------------------------
// 综合：绝不触碰无关文件
// ---------------------------------------------------------------------------

await test('综合：目标不存在时两个存储文件完全不被触碰', async () => {
  await withHome({}, async ({ paths }) => {
    await writeJson(
      paths.workspaceJson,
      registryFixture({ workspaceIds: ['w1'], archived: ['a'], workspaces: { w1: { path: 'p', title: 't', sessionIds: ['a'] } } }),
    )
    await writeJson(paths.sessionProjCacheJson, projCacheFixture({ a: sessionEntry('a') }))
    const workspaceBefore = await snapshot(paths.workspaceJson)
    const cacheBefore = await snapshot(paths.sessionProjCacheJson)

    await purgeWorkspaceRegistry(paths, { sessionIds: ['missing-1'] })
    await purgeProjectionCache(paths, ['missing-2'])

    assert.ok(sameSnapshot(workspaceBefore, await snapshot(paths.workspaceJson)), 'workspace.json 不应被写')
    assert.ok(sameSnapshot(cacheBefore, await snapshot(paths.sessionProjCacheJson)), 'session_projcache.json 不应被写')
    const artifacts = await listArtifacts(paths.storageDir)
    assert.deepEqual(artifacts.backups, [])
    assert.deepEqual(artifacts.temps, [])
    assert.deepEqual(Math.round((await fsp.stat(paths.workspaceJson)).mtimeMs), Math.round(workspaceBefore.mtimeMs))
  })
})

// ---------------------------------------------------------------------------
// 模块卫生
// ---------------------------------------------------------------------------

await test('模块卫生：导出 8 个函数，只读路径不产生异常', async () => {
  const mod = await import('../lib/session-store.js')
  const names = Object.keys(mod).sort()
  assert.deepEqual(names, [
    'deleteSessionDirectory',
    'purgeProjectionCache',
    'purgeWorkspaceRegistry',
    'readProjectionMeta',
    'readRegistry',
    'resolvePaths',
    'scanSessionDirectories',
    'verifyGone',
  ])
  for (const name of names) assert.equal(typeof mod[name], 'function', `${name} 必须是函数`)
  assert.equal(typeof resolvePaths({}), 'object')
  await withHome({ sessionsDir: false }, async ({ paths }) => {
    assert.deepEqual(await scanSessionDirectories(paths), { entries: [], skipped: [] })
    assert.equal((await readRegistry(paths)).fileExists, false)
    assert.deepEqual(await readProjectionMeta(paths), {})
    assert.deepEqual(await verifyGone(paths, ['x']), {
      stillOnDisk: [],
      stillInRegistry: [],
      stillArchived: [],
      stillInProjectionCache: [],
    })
  })
})

await test('模块卫生：仅 import 许可的 node: 内置模块，无 console 输出、无 CommonJS', async () => {
  const source = readFileSync(STORE_SOURCE_PATH, 'utf8')
  const specifiers = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  const allowed = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:os'])
  assert.ok(specifiers.length > 0, '必须存在 import 语句')
  for (const specifier of specifiers) {
    assert.ok(allowed.has(specifier), `不允许的 import：${specifier}`)
  }
  assert.ok(!/console\./.test(source), '模块不得向 stdout 输出')
  assert.ok(!/\brequire\s*\(/.test(source), '必须为纯 ESM')
  assert.ok(!/from\s+['"]cordis|from\s+['"]dsh|from\s+['"]react/.test(source), '不得引入 cordis/dsh/react')
})

// ---------------------------------------------------------------------------
// 真实数据只读冒烟（默认关闭）
// ---------------------------------------------------------------------------

if (process.env.DSH_REAL_SMOKE === '1') {
  await test('真实 home 只读冒烟：四个只读函数可解析真实数据且不写盘', async () => {
    const paths = resolvePaths({ DSH_HOME: REAL_HOME })
    if (!existsSync(paths.sessionsRoot)) {
      skip('真实 home 只读冒烟', `${paths.sessionsRoot} 不存在`)
      return
    }
    const workspaceBefore = existsSync(paths.workspaceJson) ? await snapshot(paths.workspaceJson) : null
    const cacheBefore = existsSync(paths.sessionProjCacheJson) ? await snapshot(paths.sessionProjCacheJson) : null

    const scan = await scanSessionDirectories(paths)
    const registry = await readRegistry(paths)
    const meta = await readProjectionMeta(paths)
    const gone = await verifyGone(paths, [])

    assert.ok(scan.entries.length > 0, '真实 sessions 下应当有会话目录')
    for (const entry of scan.entries) {
      assert.ok(path.resolve(entry.dir).startsWith(path.resolve(paths.sessionsRoot)), 'entry.dir 必须位于 sessionsRoot 下')
      assert.equal(entry.sessionId, path.basename(entry.dir))
      assert.ok(entry.logPath && path.basename(entry.logPath).startsWith('session.'), 'logPath 应为 session.*.jsonl.*')
      assert.ok(typeof entry.mtimeMs === 'number' && entry.mtimeMs > 0, 'mtimeMs 应为正数')
    }
    assert.equal(registry.fileExists, true)
    assert.ok(registry.workspaces.length > 0, '真实注册表应当有工作区')
    assert.ok(Object.keys(meta).length > 0, '真实投影缓存应当有会话')
    assert.deepEqual(gone, { stillOnDisk: [], stillInRegistry: [], stillArchived: [], stillInProjectionCache: [] })

    // 真实数据上的 verifyGone 语义：取一个真实存在的会话目录，未删除时应命中 stillOnDisk
    const sampleId = scan.entries[0].sessionId
    const sample = await verifyGone(paths, [sampleId])
    assert.ok(sample.stillOnDisk.includes(sampleId), '未删除的真实会话应命中 stillOnDisk')
    for (const key of ['stillOnDisk', 'stillInRegistry', 'stillArchived', 'stillInProjectionCache']) {
      assert.ok(Array.isArray(sample[key]), `${key} 必须是数组`)
      assert.ok(!sample[key].includes('__不存在的会话__'), '未知 id 不应误报')
    }
    const unknownReal = await verifyGone(paths, ['__不存在的会话__'])
    assert.deepEqual(unknownReal, { stillOnDisk: [], stillInRegistry: [], stillArchived: [], stillInProjectionCache: [] })

    const workspaceAfter = existsSync(paths.workspaceJson) ? await snapshot(paths.workspaceJson) : null
    const cacheAfter = existsSync(paths.sessionProjCacheJson) ? await snapshot(paths.sessionProjCacheJson) : null
    if (workspaceBefore && workspaceAfter && !sameSnapshot(workspaceBefore, workspaceAfter)) {
      console.log('      提示：workspace.json 在冒烟期间发生变化（可能被真实 DSH 进程改动，非本次测试写入）')
    }
    if (cacheBefore && cacheAfter && !sameSnapshot(cacheBefore, cacheAfter)) {
      console.log('      提示：session_projcache.json 在冒烟期间发生变化（可能被真实 DSH 进程改动，非本次测试写入）')
    }
    console.log(`      只读冒烟：${scan.entries.length} 个会话目录 / ${registry.workspaces.length} 个工作区 / ${Object.keys(meta).length} 条投影缓存`)
  })
} else {
  skip('真实 home 只读冒烟', '默认关闭，设 DSH_REAL_SMOKE=1 启用')
}

// ---------------------------------------------------------------------------
// 结果汇总
// ---------------------------------------------------------------------------

console.log('')
if (summary.fail > 0) {
  console.log('失败详情：')
  for (const failure of failures) {
    console.log(`- ${failure.name}`)
    console.log(`  ${String((failure.error && failure.error.stack) || failure.error).split('\n').slice(0, 4).join('\n  ')}`)
  }
}
console.log(`PASS ${summary.pass} / FAIL ${summary.fail}${summary.skip ? ` (SKIP ${summary.skip})` : ''}`)
process.exitCode = summary.fail > 0 ? 1 : 0
