/**
 * 会话元信息解析器：从会话日志里读出标题、工作目录、来源与创建时间。
 *
 * 背景：DSH 的投影缓存（session_projcache.json）只为部分会话保留标题，
 * 而会话日志本身是**多帧 zstd**（每个事件一帧），因此必须按帧头切分逐帧解压。
 * 实测 147 个会话全量解析约 5 秒，所以这里采用「缓存 + 后台队列」：
 *  - 首屏只读缓存，立即返回；
 *  - 未命中项排队异步解析，解析结果写入缓存，下一次请求即可见。
 *
 * 纯 Node 模块，不依赖 cordis，便于隔离测试。
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CACHE_VERSION = 2

/** 找出全部 zstd 帧起始偏移。 */
function frameOffsets(buffer) {
  const offsets = []
  let from = 0
  while (from < buffer.length) {
    const at = buffer.indexOf(ZSTD_MAGIC, from)
    if (at < 0) break
    offsets.push(at)
    from = at + 4
  }
  return offsets
}

/**
 * 逐帧解压并拼接文本；坏帧跳过。
 *
 * 关键：一个会话可能有**多条** `session/title` 事件——先写 fallback（首条消息，
 * 如 "1+1"），随后 provider 生成正式标题（如 "Simple arithmetic question"），
 * 用户手动重命名还会再追加一条。因此不能"遇到第一条就停"，否则会显示早期标题。
 *
 * 策略：找到第一条标题后**继续多解 extraFramesAfterTitle 帧**再停，
 * 既覆盖紧随其后的 provider 标题与近期重命名，又不必解压整个大日志。
 */
export function decompressSessionLog(buffer, options = {}) {
  const extraFrames =
    Number.isFinite(options.extraFramesAfterTitle) && options.extraFramesAfterTitle >= 0
      ? options.extraFramesAfterTitle
      : 24
  const offsets = frameOffsets(buffer)
  if (offsets.length === 0) return ''
  const parts = []
  let titleSeenAt = -1
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    let chunk = null
    try {
      chunk = zlib.zstdDecompressSync(buffer.subarray(start, end))
    } catch (error) {
      continue
    }
    parts.push(chunk)
    if (titleSeenAt < 0 && chunk.includes('session/title')) titleSeenAt = index
    if (titleSeenAt >= 0 && index - titleSeenAt >= extraFrames) break
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 从日志文本里提取元信息。
 * 只做一次线性扫描；遇到 title 事件就更新（保留最后一个）。
 */
export function extractMeta(text) {
  const meta = { title: null, cwd: null, origin: null, createdAt: null, parentSession: null }
  if (!text) return meta
  const lines = text.split('\n')
  for (const line of lines) {
    if (!line) continue
    // 快速预筛，避免对每行都做 JSON.parse
    const maybeHeader = line.startsWith('{"type":"session"') || line.indexOf('"cwd"') >= 0
    const maybeTitle = line.indexOf('session/title') >= 0
    if (!maybeHeader && !maybeTitle) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event.type === 'session') {
      if (typeof event.cwd === 'string') meta.cwd = event.cwd
      if (typeof event.origin === 'string') meta.origin = event.origin
      if (Number.isFinite(event.createdAt)) meta.createdAt = event.createdAt
      if (typeof event.parentSession === 'string') meta.parentSession = event.parentSession
      continue
    }
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      // 取最后一条：fallback → provider → 用户重命名，后者优先
      const title = event.data.title.trim()
      if (title) meta.title = title
    }
  }
  return meta
}

/**
 * 创建解析器。
 * options.cacheFile  缓存文件绝对路径（不存在时自动创建目录）
 * options.concurrency 后台并发上限，默认 4
 * options.limit      单轮最多解析多少个，默认 40（避免长任务霸占）
 */
export function createTitleResolver(options = {}) {
  const cacheFile = options.cacheFile
  const concurrency = Math.max(1, Number(options.concurrency) || 4)
  const batchLimit = Math.max(1, Number(options.limit) || 40)

  /** sessionId -> { mtimeMs, size, title, cwd, origin, createdAt, parentSession, failed } */
  const entries = new Map()
  const queue = []
  const queued = new Set()
  let running = 0
  let loaded = false
  let dirty = false

  function load() {
    if (loaded) return
    loaded = true
    if (!cacheFile || !existsSync(cacheFile)) return
    try {
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (!raw || raw.version !== CACHE_VERSION || typeof raw.entries !== 'object') return
      for (const [id, value] of Object.entries(raw.entries)) {
        if (!value || typeof value !== 'object') continue
        entries.set(id, value)
      }
    } catch (error) {
      /* 缓存损坏按空处理，不影响主流程 */
    }
  }

  function save() {
    if (!dirty || !cacheFile) return
    dirty = false
    try {
      mkdirSync(path.dirname(cacheFile), { recursive: true })
      const payload = { version: CACHE_VERSION, entries: Object.fromEntries(entries) }
      const temp = cacheFile + '.tmp-' + process.pid
      writeFileSync(temp, JSON.stringify(payload), 'utf8')
      renameSync(temp, cacheFile)
    } catch (error) {
      /* 缓存写失败不影响正确性 */
    }
  }

  /** 读取已解析的元信息（不触发解析）。 */
  function get(sessionId) {
    return entries.get(String(sessionId)) || null
  }

  /** 队列是否还有待解析项。 */
  function pending() {
    return queue.length + running
  }

  function pump() {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift()
      if (!task) break
      running += 1
      resolveOne(task.sessionId, task.logPath, task.mtimeMs, task.size)
        .catch(() => {})
        .finally(() => {
          running -= 1
          dirty = true
          pump()
        })
    }
    if (running === 0 && queue.length === 0) save()
  }

  async function resolveOne(sessionId, logPath, mtimeMs, size) {
    let meta = null
    try {
      const buffer = readFileSync(logPath)
      meta = extractMeta(decompressSessionLog(buffer))
    } catch (error) {
      meta = { title: null, cwd: null, origin: null, createdAt: null, parentSession: null }
    }
    entries.set(String(sessionId), {
      mtimeMs: Number(mtimeMs) || 0,
      size: Number(size) || 0,
      title: meta.title || null,
      cwd: meta.cwd || null,
      origin: meta.origin || null,
      createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : null,
      parentSession: meta.parentSession || null,
      failed: meta.cwd ? undefined : true,
    })
  }

  /**
   * 提交一个会话供后台解析。
   * 缓存命中且 mtime/size 未变时直接返回，不重复解析。
   */
  function submit(sessionId, logPath, mtimeMs, size) {
    const id = String(sessionId)
    if (!logPath) return
    const cached = entries.get(id)
    if (cached && cached.mtimeMs === Number(mtimeMs) && cached.size === Number(size)) return
    if (queued.has(id)) return
    if (queue.length >= batchLimit * 4) return
    queued.add(id)
    queue.push({ sessionId: id, logPath, mtimeMs, size })
    pump()
  }

  /** 同步解析单个会话（测试用）。 */
  function resolveNow(sessionId, logPath) {
    let mtimeMs = 0
    let size = 0
    try {
      const info = statSync(logPath)
      mtimeMs = info.mtimeMs
      size = info.size
    } catch (error) {
      /* 忽略 */
    }
    return resolveOne(sessionId, logPath, mtimeMs, size).then(() => {
      dirty = true
      return entries.get(String(sessionId))
    })
  }

  function flush() {
    save()
  }

  return { load, save, flush, get, pending, submit, resolveNow, extractMeta, decompressSessionLog }
}