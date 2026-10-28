/**
 * 数据层：会话物理存储的扫描、注册表 / 投影缓存的清理，以及删除后的独立复核。
 *
 * 契约见同目录 CONTRACT.md 第 1 节（冻结版 v1），本文件严格按其签名与返回结构实现。
 *
 * 硬性约束：
 * - 纯 Node ESM，只依赖 node:fs / node:fs/promises / node:path / node:os；无顶层副作用、无 stdout 输出。
 * - 所有路径都从 resolvePaths() 或调用方传入的 paths 推导，不写死任何绝对路径。
 * - 只可能改写 <home>/storages/workspace.json、<home>/storages/session_projcache.json，
 *   只可能删除 sessionsRoot 之下的会话目录；其余文件一律不碰。
 * - 读-改-写一律原子：备份 <file>.bak-<ts> → 写 <file>.tmp-<pid>-<ts> → rename 覆盖 → 重新 parse 自校验；
 *   自校验失败时用备份还原并抛 Error。无实际改动时不写盘、不产生备份。
 *
 * 几处契约未明说、由本实现作出的判断（已在汇报中列明）：
 * - readRegistry 的 fileExists 表示“文件在磁盘上是否存在”：文件缺失 → fileExists:false, raw:null；
 *   文件存在但 JSON 损坏 → fileExists:true, raw:null（两者其余字段均为空数组，均不抛错）。
 * - logFiles 取会话目录“直接子级”的全部常规文件（不含子目录、不含符号链接），已排序。
 * - skipped 只收录“目录”，即不含任何 session.*.jsonl.* 文件的两层会话目录；分组目录下的散落文件直接忽略。
 * - deleteSessionDirectory 的 removed 只列出常规文件（含符号链接条目，不含任何目录路径）。
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

/** 兜底 home：仅当 env.DSH_HOME 与 process.env.DSH_HOME 都为空时使用，避免出现写死路径。 */
const FALLBACK_HOME_DIRNAME = '.dsh'

/** 与真实 DSH 存储一致的序列化格式：2 空格缩进 + LF + 末尾换行。 */
const JSON_INDENT = 2

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 稳定的字符串升序比较（按 UTF-16 码元，避免 locale 差异带来的不确定性）。 */
function compareStrings(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 过滤出非空字符串，并按出现顺序去重（用于 sessionIds 入参）。 */
function normalizeIds(sessionIds) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(sessionIds)) return out
  for (const item of sessionIds) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 只过滤字符串元素，保留重复。 */
function filterStrings(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

/** 有限数字才视为合法数值，其余返回 null。 */
function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 字符串或 null。 */
function toStringOrNull(value) {
  return typeof value === 'string' ? value : null
}

/** 目标集合中是否存在列表里的任一元素。 */
function containsAny(list, targetSet) {
  if (!Array.isArray(list)) return false
  for (const item of list) {
    if (typeof item === 'string' && targetSet.has(item)) return true
  }
  return false
}

/** readdir 的安全包装：任何失败都退化为空列表，绝不抛错。 */
async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 路径是否存在（不抛错）。 */
async function pathExists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

/** 读取并解析 JSON，返回结构化的三态结果，不抛错。 */
async function readJsonFile(file) {
  if (!file) return { exists: false, ok: false, value: null }
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return { exists: false, ok: false, value: null }
  }
  try {
    return { exists: true, ok: true, value: JSON.parse(text) }
  } catch {
    return { exists: true, ok: false, value: null }
  }
}

/** 静默删除临时文件 / 备份文件。 */
async function removeQuietly(target) {
  try {
    await fsp.rm(target, { force: true })
  } catch {
    /* 清理失败不掩盖主错误 */
  }
}

// ---------------------------------------------------------------------------
// 路径推导
// ---------------------------------------------------------------------------

/**
 * 推导 DSH 存储路径。env.DSH_HOME 优先，其次 process.env.DSH_HOME，
 * 两者都没有时退回 os.homedir()/.dsh（不写死绝对路径）。
 */
export function resolvePaths(env = {}) {
  const candidates = [isPlainObject(env) ? env.DSH_HOME : undefined, process.env.DSH_HOME]
  let home = ''
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      home = path.resolve(candidate.trim())
      break
    }
  }
  if (!home) home = path.join(os.homedir(), FALLBACK_HOME_DIRNAME)

  const storageDir = path.join(home, 'storages')
  return {
    home,
    storageDir,
    workspaceJson: path.join(storageDir, 'workspace.json'),
    sessionProjCacheJson: path.join(storageDir, 'session_projcache.json'),
    sessionsRoot: path.join(home, 'sessions'),
  }
}

/** 取 sessionsRoot 的绝对路径；无法推导时抛 invalid-paths（只在删除路径上使用）。 */
function requireSessionsRoot(paths) {
  if (!isPlainObject(paths)) throw new Error('invalid-paths')
  if (typeof paths.sessionsRoot === 'string' && paths.sessionsRoot.trim()) {
    return path.resolve(paths.sessionsRoot.trim())
  }
  if (typeof paths.home === 'string' && paths.home.trim()) {
    return path.join(path.resolve(paths.home.trim()), 'sessions')
  }
  throw new Error('invalid-paths')
}

/** 取 sessionsRoot 的绝对路径；无法推导时返回 null（读取类函数使用，保证不抛错）。 */
function trySessionsRoot(paths) {
  try {
    return requireSessionsRoot(paths)
  } catch {
    return null
  }
}

/** 取 storages 下某个 JSON 文件的绝对路径；无法推导时返回 null。 */
function storageFilePath(paths, key) {
  if (!isPlainObject(paths)) return null
  const direct = paths[key]
  if (typeof direct === 'string' && direct.trim()) return path.resolve(direct.trim())
  const home = typeof paths.home === 'string' && paths.home.trim() ? path.resolve(paths.home.trim()) : null
  if (!home) return null
  const fileName = key === 'workspaceJson' ? 'workspace.json' : 'session_projcache.json'
  return path.join(home, 'storages', fileName)
}

// ---------------------------------------------------------------------------
// 1.2 扫描会话目录
// ---------------------------------------------------------------------------

/** 是否为会话日志文件名：session.jsonl.zstd / session.v3.jsonl.zstd / session.v4.jsonl.zstd 等。 */
function isSessionLogName(name) {
  return name.startsWith('session.') && name.includes('.jsonl.')
}

/** 提取日志文件中的版本号；无版本号（session.jsonl.zstd）视为 0，即最低优先级。 */
function sessionLogVersion(name) {
  const match = /^session\.v(\d+)\.jsonl\./.exec(name)
  return match ? Number(match[1]) : 0
}

/** 收集目录的直接子级常规文件（不含目录、不含符号链接），带字节大小与 mtime。 */
async function collectRegularFiles(dir) {
  const out = []
  for (const dirent of await readdirSafe(dir)) {
    if (!dirent.isFile()) continue
    const filePath = path.join(dir, dirent.name)
    let size = 0
    let mtimeMs = 0
    try {
      const info = await fsp.stat(filePath) // 一次 stat 同时取大小与 mtime，避免额外 IO
      size = info.size
      mtimeMs = info.mtimeMs
    } catch {
      size = 0
      mtimeMs = 0
    }
    out.push({ name: dirent.name, path: filePath, size, mtimeMs })
  }
  return out
}

/**
 * 扫描 <sessionsRoot>/<group>/<sessionId>/ 两层结构。
 * sessionsRoot 不存在时返回空结果，不抛错；结果按 sessionId 升序稳定排序。
 */
export async function scanSessionDirectories(paths) {
  const sessionsRoot = trySessionsRoot(paths)
  if (!sessionsRoot) return { entries: [], skipped: [] }
  if (!(await pathExists(sessionsRoot))) return { entries: [], skipped: [] }

  const entries = []
  const skipped = []

  for (const group of await readdirSafe(sessionsRoot)) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(sessionsRoot, group.name)

    for (const child of await readdirSafe(groupDir)) {
      if (!child.isDirectory()) continue // 分组目录下的散落文件直接忽略
      const dir = path.join(groupDir, child.name)
      const files = await collectRegularFiles(dir)
      const sorted = files.slice().sort((a, b) => compareStrings(a.path, b.path))

      let logPath = null
      let bestVersion = -1
      for (const file of sorted) {
        if (!isSessionLogName(file.name)) continue
        const version = sessionLogVersion(file.name)
        if (version > bestVersion || (version === bestVersion && logPath !== null && compareStrings(file.path, logPath) > 0)) {
          bestVersion = version
          logPath = file.path
        }
      }

      // 不含 session.*.jsonl.* 文件的目录记入 skipped，不作为会话条目
      if (logPath === null) {
        skipped.push(dir)
        continue
      }

      entries.push({
        sessionId: child.name,
        group: group.name,
        dir,
        logPath,
        logFiles: sorted.map((file) => file.path),
        sizeBytes: sorted.reduce((sum, file) => sum + file.size, 0),
        // 目录内最新文件的 mtime；无文件时为 0（供 host-api 推导 updatedAt）
        mtimeMs: sorted.reduce((max, file) => (file.mtimeMs > max ? file.mtimeMs : max), 0),
      })
    }
  }

  entries.sort((a, b) => compareStrings(a.sessionId, b.sessionId) || compareStrings(a.dir, b.dir))
  skipped.sort(compareStrings)
  return { entries, skipped }
}

// ---------------------------------------------------------------------------
// 1.3 / 1.4 读取注册表与投影缓存
// ---------------------------------------------------------------------------

/** 定位工作区表：tables.workspaces 优先，兼容 v1 的 global.workspaces 与 raw.workspaces。 */
function locateWorkspaceTable(raw) {
  if (!isPlainObject(raw)) return null
  if (isPlainObject(raw.tables) && isPlainObject(raw.tables.workspaces)) return raw.tables.workspaces
  if (isPlainObject(raw.global) && isPlainObject(raw.global.workspaces)) return raw.global.workspaces
  if (isPlainObject(raw.workspaces)) return raw.workspaces
  return null
}

/** 空注册表结果。 */
function emptyRegistry() {
  return {
    fileExists: false,
    raw: null,
    workspaceIds: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    workspaces: [],
  }
}

/**
 * 读取 <home>/storages/workspace.json。文件缺失或解析失败均不抛错。
 */
export async function readRegistry(paths) {
  const result = emptyRegistry()
  const loaded = await readJsonFile(storageFilePath(paths, 'workspaceJson'))
  if (!loaded.exists) return result
  // 文件存在但内容无法解析：raw 置空、其余字段为空数组（fileExists 反映磁盘事实）
  if (!loaded.ok) {
    result.fileExists = true
    return result
  }

  const raw = loaded.value
  result.fileExists = true
  result.raw = isPlainObject(raw) ? raw : null
  if (!isPlainObject(raw)) return result

  const global = isPlainObject(raw.global) ? raw.global : {}
  result.workspaceIds = filterStrings(global.workspaceIds)
  result.archivedSessionIds = filterStrings(global.archivedSessionIds)
  result.pinnedSessionIds = filterStrings(global.pinnedSessionIds)

  const table = locateWorkspaceTable(raw)
  if (table) {
    const workspaces = []
    for (const [workspaceId, value] of Object.entries(table)) {
      if (!isPlainObject(value)) continue
      workspaces.push({
        workspaceId,
        title: toStringOrNull(value.title),
        path: toStringOrNull(value.path),
        sessionIds: filterStrings(value.sessionIds),
      })
    }
    result.workspaces = workspaces
  }

  return result
}

/** 从 rows 取标题：rows.title.val（字符串）优先，其次 rows.title 本身是字符串。 */
function pickTitle(rows) {
  if (!isPlainObject(rows)) return null
  const title = rows.title
  if (isPlainObject(title) && typeof title.val === 'string') return title.val
  if (typeof title === 'string') return title
  return null
}

/**
 * 读取 <home>/storages/session_projcache.json 的会话元信息。
 * 文件缺失 / 解析失败 / 结构缺失一律返回 {}，不抛错。
 */
export async function readProjectionMeta(paths) {
  const loaded = await readJsonFile(storageFilePath(paths, 'sessionProjCacheJson'))
  if (!loaded.exists || !loaded.ok) return {}
  const raw = loaded.value
  if (!isPlainObject(raw) || !isPlainObject(raw.tables) || !isPlainObject(raw.tables.sessions)) return {}

  const meta = {}
  for (const [sessionId, value] of Object.entries(raw.tables.sessions)) {
    if (!isPlainObject(value)) continue
    const identity = isPlainObject(value.identity) ? value.identity : {}
    meta[sessionId] = {
      title: pickTitle(value.rows),
      createdAt: toNumberOrNull(identity.createdAt),
      cwd: toStringOrNull(identity.cwd),
    }
  }
  return meta
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

/** 序列化为与真实 DSH 存储一致的文本。 */
function serializeJson(value) {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`
}

/** 自校验：必须仍是 JSON 对象，且业务校验函数返回 true。 */
function assertValid(parsed, validate) {
  if (!isPlainObject(parsed)) throw new Error('self-check-failed: not-a-json-object')
  if (typeof validate === 'function' && validate(parsed) !== true) {
    throw new Error('self-check-failed: validation-returned-false')
  }
}

/** 保留一个不与既有备份 / 临时文件冲突的时间戳（仍保持 <file>.bak-<ts> 命名）。 */
function reserveTimestamp(file) {
  let ts = Date.now()
  for (let guard = 0; guard < 1000; guard += 1) {
    const backup = `${file}.bak-${ts}`
    const temp = `${file}.tmp-${process.pid}-${ts}`
    if (!fs.existsSync(backup) && !fs.existsSync(temp)) return ts
    ts += 1
  }
  return ts
}

/**
 * 原子写 JSON：
 * 1) 备份 <file>.bak-<ts>；2) 写 <file>.tmp-<pid>-<ts>；3) rename 覆盖；
 * 4) 重新读回 JSON.parse 自校验，失败则用备份还原并抛 Error。
 * 返回实际产生的备份路径（原文件不存在时为 null）。
 */
async function writeJsonAtomic(file, value, validate) {
  const ts = reserveTimestamp(file)
  const backupPath = `${file}.bak-${ts}`
  const tmpPath = `${file}.tmp-${process.pid}-${ts}`

  let backedUp = false
  try {
    await fsp.copyFile(file, backupPath)
    backedUp = true
  } catch {
    backedUp = false
  }

  try {
    await fsp.writeFile(tmpPath, serializeJson(value), 'utf8')
    assertValid(JSON.parse(await fsp.readFile(tmpPath, 'utf8')), validate)
    await fsp.rename(tmpPath, file)
  } catch (error) {
    await removeQuietly(tmpPath)
    if (backedUp) await removeQuietly(backupPath) // 尚未覆盖目标文件，原文件完好，无需保留备份
    throw error
  }

  try {
    assertValid(JSON.parse(await fsp.readFile(file, 'utf8')), validate)
  } catch (error) {
    if (backedUp) {
      try {
        await fsp.copyFile(backupPath, file) // 用备份还原
      } catch {
        /* 还原失败时仍抛出原始校验错误 */
      }
    }
    throw new Error(`atomic-write-verify-failed: ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { backupPath: backedUp ? backupPath : null }
}

// ---------------------------------------------------------------------------
// 1.5 删除会话目录
// ---------------------------------------------------------------------------

/** 判断 target 是否严格位于 root 之下（等于 root 也算逃逸）。 */
function isStrictlyInside(root, target) {
  const relative = path.relative(root, target)
  if (relative === '') return false
  if (relative === '..') return false
  if (relative.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(relative)) return false
  return true
}

/** 递归枚举子树里的所有非目录条目（不跟随符号链接），用于统计删除量与释放空间。 */
async function collectSubtreeEntries(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const dirent of await readdirSafe(current)) {
      const entryPath = path.join(current, dirent.name)
      if (dirent.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      let size = 0
      try {
        size = (await fsp.lstat(entryPath)).size
      } catch {
        size = 0
      }
      found.push({ path: entryPath, size })
    }
  }
  return found
}

/**
 * 递归删除 entry.dir 整棵子树。仅允许 sessionsRoot 之下的目录，逃逸抛 Error('unsafe-path')。
 * 目录不存在时返回零值，不抛错。
 */
export async function deleteSessionDirectory(paths, entry) {
  const sessionsRoot = requireSessionsRoot(paths)
  const rawDir = isPlainObject(entry) && typeof entry.dir === 'string' ? entry.dir.trim() : ''
  if (!rawDir) throw new Error('unsafe-path')

  const target = path.isAbsolute(rawDir) ? path.resolve(rawDir) : path.resolve(sessionsRoot, rawDir)
  if (!isStrictlyInside(sessionsRoot, target)) throw new Error('unsafe-path')

  const result = { dir: entry.dir, removed: [], freedBytes: 0 }

  let info = null
  try {
    info = await fsp.lstat(target)
  } catch {
    return result // 目录不存在
  }

  // 非目录（含指向外部的符号链接）：不递归枚举，避免跟随链接误统计外部文件
  if (!info.isDirectory()) {
    await fsp.rm(target, { recursive: true, force: true })
    return result
  }

  const found = await collectSubtreeEntries(target)
  await fsp.rm(target, { recursive: true, force: true })

  return {
    dir: entry.dir,
    removed: found.map((item) => item.path).sort(compareStrings),
    freedBytes: found.reduce((sum, item) => sum + item.size, 0),
  }
}

// ---------------------------------------------------------------------------
// 1.6 清理工作区注册表
// ---------------------------------------------------------------------------

/**
 * 清理 workspace.json 中的会话引用：
 * 1) 从各 workspace 的 sessionIds 移除目标 id；2) 可选从 archivedSessionIds 移除；
 * 3) 可选从 pinnedSessionIds 移除。不动 global.workspaceIds 与工作区键集合。
 * 无实际改动时不写盘、不产生备份。
 */
export async function purgeWorkspaceRegistry(paths, options) {
  const { sessionIds = [], dropArchive = true, dropPin = true } = options || {}
  const targets = new Set(normalizeIds(sessionIds))
  const result = {
    changed: false,
    backupPath: null,
    removedFromWorkspaces: 0,
    removedFromArchive: 0,
    removedFromPin: 0,
  }

  if (targets.size === 0) return result

  const file = storageFilePath(paths, 'workspaceJson')
  const loaded = await readJsonFile(file)
  if (!loaded.exists || !loaded.ok || !isPlainObject(loaded.value)) return result // 不可读 → 无可清理，保守返回

  const raw = loaded.value
  const global = isPlainObject(raw.global) ? raw.global : null

  const table = locateWorkspaceTable(raw)
  if (table) {
    for (const value of Object.values(table)) {
      if (!isPlainObject(value) || !Array.isArray(value.sessionIds)) continue
      const kept = value.sessionIds.filter((id) => !(typeof id === 'string' && targets.has(id)))
      const removedCount = value.sessionIds.length - kept.length
      if (removedCount > 0) {
        value.sessionIds = kept
        result.removedFromWorkspaces += removedCount
      }
    }
  }

  if (global) {
    if (dropArchive && Array.isArray(global.archivedSessionIds)) {
      const kept = global.archivedSessionIds.filter((id) => !(typeof id === 'string' && targets.has(id)))
      result.removedFromArchive = global.archivedSessionIds.length - kept.length
      if (result.removedFromArchive > 0) global.archivedSessionIds = kept
    }
    if (dropPin && Array.isArray(global.pinnedSessionIds)) {
      const kept = global.pinnedSessionIds.filter((id) => !(typeof id === 'string' && targets.has(id)))
      result.removedFromPin = global.pinnedSessionIds.length - kept.length
      if (result.removedFromPin > 0) global.pinnedSessionIds = kept
    }
  }

  const totalRemoved = result.removedFromWorkspaces + result.removedFromArchive + result.removedFromPin
  if (totalRemoved === 0) return result // 无实际改动 → 不写盘

  const written = await writeJsonAtomic(file, raw, (parsed) => {
    const parsedTable = locateWorkspaceTable(parsed)
    if (parsedTable) {
      for (const value of Object.values(parsedTable)) {
        if (isPlainObject(value) && containsAny(value.sessionIds, targets)) return false
      }
    }
    const parsedGlobal = isPlainObject(parsed.global) ? parsed.global : null
    if (parsedGlobal) {
      if (dropArchive && containsAny(parsedGlobal.archivedSessionIds, targets)) return false
      if (dropPin && containsAny(parsedGlobal.pinnedSessionIds, targets)) return false
    }
    return true
  })

  result.changed = true
  result.backupPath = written.backupPath
  return result
}

// ---------------------------------------------------------------------------
// 1.7 清理投影缓存
// ---------------------------------------------------------------------------

/**
 * 清理会话的投影缓存，两个位置都要清：
 *
 *  1. **目录版**（DSH 实际使用的）：`<storageDir>/session_projcache/sessions/<sessionId>.json`
 *     每个会话一个文件。漏掉它的后果很具体：DSH 侧边栏会继续显示已删除的会话
 *     （出现在「未分组」里），而且重启也不消失——因为缓存文件还在。
 *  2. **单文件版**（旧格式）：`<storageDir>/session_projcache.json` 的 tables.sessions。
 *
 * 无实际改动时不写盘。
 */
export async function purgeProjectionCache(paths, sessionIds = []) {
  const targets = new Set(normalizeIds(sessionIds))
  const result = { changed: false, removed: 0, backupPath: null }
  if (targets.size === 0) return result

  // ---- 1) 目录版：每个会话一个 json ----
  const cacheDir = path.join(paths.storageDir || path.join(paths.home, 'storages'), 'session_projcache', 'sessions')
  for (const sessionId of targets) {
    const cacheFile = path.join(cacheDir, sessionId + '.json')
    try {
      if (await pathExists(cacheFile)) {
        await fsp.rm(cacheFile, { force: true })
        result.removed += 1
        result.changed = true
      }
    } catch (error) {
      /* 单个缓存文件删不掉不影响主流程 */
    }
  }

  // ---- 2) 单文件版 ----
  const file = storageFilePath(paths, 'sessionProjCacheJson')
  const loaded = await readJsonFile(file)
  if (!loaded.exists || !loaded.ok || !isPlainObject(loaded.value)) return result

  const raw = loaded.value
  if (!isPlainObject(raw.tables) || !isPlainObject(raw.tables.sessions)) return result
  const sessions = raw.tables.sessions

  let removedFromSingleFile = 0
  for (const sessionId of targets) {
    if (Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
      delete sessions[sessionId]
      removedFromSingleFile += 1
    }
  }
  // 单文件版没有对应键时不写盘（目录版可能已经清过了）
  if (removedFromSingleFile === 0) return result

  const written = await writeJsonAtomic(file, raw, (parsed) => {
    const parsedSessions =
      isPlainObject(parsed.tables) && isPlainObject(parsed.tables.sessions) ? parsed.tables.sessions : null
    if (!parsedSessions) return true
    for (const sessionId of targets) {
      if (Object.prototype.hasOwnProperty.call(parsedSessions, sessionId)) return false
    }
    return true
  })

  result.changed = true
  result.removed += removedFromSingleFile
  result.backupPath = written.backupPath
  return result
}

// ---------------------------------------------------------------------------
// 1.8 删除后复核
// ---------------------------------------------------------------------------

/** 收集 sessionsRoot 下所有 <group>/<sessionId> 的 sessionId 集合。 */
async function collectSessionDirectoryIds(sessionsRoot) {
  const ids = new Set()
  if (!sessionsRoot) return ids
  for (const group of await readdirSafe(sessionsRoot)) {
    if (!group.isDirectory()) continue
    for (const child of await readdirSafe(path.join(sessionsRoot, group.name))) {
      if (child.isDirectory()) ids.add(child.name)
    }
  }
  return ids
}

/**
 * 独立复核：返回四个数组中仍残留的 id。全部为空即删除彻底。
 */
export async function verifyGone(paths, sessionIds = []) {
  const ids = normalizeIds(sessionIds)
  const result = {
    stillOnDisk: [],
    stillInRegistry: [],
    stillArchived: [],
    stillInProjectionCache: [],
  }
  if (ids.length === 0) return result

  const onDisk = await collectSessionDirectoryIds(trySessionsRoot(paths))

  const registry = await readRegistry(paths)
  const workspaceMembers = new Set()
  for (const workspace of registry.workspaces) {
    for (const sessionId of workspace.sessionIds) workspaceMembers.add(sessionId)
  }
  const archived = new Set(registry.archivedSessionIds)

  const projection = await readProjectionMeta(paths)
  const projectionKeys = new Set(Object.keys(projection))

  for (const sessionId of ids) {
    if (onDisk.has(sessionId)) result.stillOnDisk.push(sessionId)
    if (workspaceMembers.has(sessionId)) result.stillInRegistry.push(sessionId)
    if (archived.has(sessionId)) result.stillArchived.push(sessionId)
    if (projectionKeys.has(sessionId)) result.stillInProjectionCache.push(sessionId)
  }
  return result
}
