/**
 * 会话管理 Host 半边：HTTP API 与归档 / 物理删除编排。
 *
 * 设计要点：本模块不直接依赖 cordis，所有外部能力（文件系统、归档服务、
 * 内存会话列表、时钟）都通过 deps 注入，因此可以在隔离环境里完整跑端到端
 * 测试——这也是验证层 verify/e2e-delete.mjs 的用法。
 */
import { randomBytes } from 'node:crypto'

/** HTTP 前缀；client.js 必须使用同一常量。 */
export const API_PREFIX = '/api/dsh-session-manager'

/** 确认令牌有效期：5 分钟。 */
const CONFIRM_TTL_MS = 5 * 60 * 1000

/** 各删除动作要求的确认短语（服务端二次校验，纵深防御）。 */
const CONFIRM_PHRASES = {
  'delete-sessions': '删除',
  'delete-archived': '清空归档',
  'delete-all': '全部删除',
}

const DELETE_ACTIONS = new Set(Object.keys(CONFIRM_PHRASES))
const ACTIONS = new Set(['archive', 'unarchive', ...DELETE_ACTIONS])

/** 人类可读体积。 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return value + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return (size >= 10 ? size.toFixed(1) : size.toFixed(2)) + ' ' + units[index]
}

/**
 * 把工作区路径编码成 DSH 的 sessions 分组目录名。
 * 实测规则：删除 ':'，非 ASCII 字符转 ~XXXX（UTF-16 大写十六进制），
 * 其余非字母数字字符（含 '_'、'.'、'\\'、空格）一律转 '-'，最后两端各包一层 '--'。
 */
export function encodeGroupName(workspacePath) {
  const text = String(workspacePath || '')
  let out = ''
  for (const char of text) {
    if (/[A-Za-z0-9]/.test(char)) out += char
    else if (char === ':') continue
    else if (char.codePointAt(0) > 127) out += '~' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    else out += '-'
  }
  return '--' + out + '--'
}

/** 诊断日志：绝不把异常吞掉，但也不让它冒泡成 HTTP 500。 */
function report(deps, event, payload) {
  try {
    if (typeof deps.log === 'function') deps.log(event, payload)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 尽力而为的可选步骤：失败时降级为 warning，不回滚已完成的删除。 */
async function bestEffort(deps, warnings, label, work) {
  try {
    return await work()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(label + ': ' + message)
    report(deps, 'warn', { label, message })
    return null
  }
}

/**
 * 创建会话管理器。
 *
 * deps:
 *  - paths             resolvePaths() 的结果
 *  - store             lib/session-store.js 模块（可注入假的实现做测试）
 *  - liveIds           () => string[]，当前挂载在内存里的会话 id（禁止物理删除）
 *  - archive           async (sessionId, options) => void
 *  - unarchive         async (sessionId) => void
 *  - listRecords       async () => [{ sessionId, createdAt }]（可选，来自 sessionQuery）
 *  - now               () => number（可选，便于测试注入时钟）
 *  - log               (event, payload) => void（可选）
 */
export function createManager(deps) {
  if (!deps || !deps.paths || !deps.store) throw new Error('createManager: paths 与 store 为必填依赖')
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  // 最近一次 list 下发的确认令牌；每次 list 刷新，过期即失效。
  let confirmToken = null
  let confirmIssuedAt = 0

  function issueConfirmToken() {
    confirmToken = 'sm-' + randomBytes(16).toString('hex')
    confirmIssuedAt = now()
    return confirmToken
  }

  function checkConfirmToken(candidate) {
    if (typeof candidate !== 'string' || candidate === '') return 'confirm-required'
    if (confirmToken === null) return 'confirm-required'
    if (now() - confirmIssuedAt > CONFIRM_TTL_MS) return 'confirm-required'
    if (candidate !== confirmToken) return 'confirm-required'
    return null
  }

  function liveIdSet() {
    try {
      const ids = typeof deps.liveIds === 'function' ? deps.liveIds() : []
      return new Set(Array.isArray(ids) ? ids.map(String) : [])
    } catch (error) {
      report(deps, 'error', { where: 'liveIds', message: String(error) })
      return new Set()
    }
  }

  /**
   * 组装完整会话快照。
   * 权威来源是磁盘扫描（它才是物理删除的对象）；注册表、投影缓存与
   * sessionQuery 只用来补标题 / 时间 / 归属，绝不凭空造出磁盘上不存在的条目。
   *
   * 语义对齐契约 2.1：默认（即 GET /list 的语义）签发新的 confirmToken。
   * 动作内部重建快照时必须传 { issueToken: false }，否则一次被 blocked 拦截的
   * 操作就会让用户手里的令牌失效，重试必然失败。
   */
  async function buildSnapshot(options = {}) {
    const issueToken = options.issueToken !== false
    const [scan, registry, projections] = await Promise.all([
      deps.store.scanSessionDirectories(deps.paths),
      deps.store.readRegistry(deps.paths),
      deps.store.readProjectionMeta(deps.paths),
    ])

    const archived = new Set(registry.archivedSessionIds.map(String))
    const pinned = new Set(registry.pinnedSessionIds.map(String))
    const live = liveIdSet()

    // sessionId -> 归属的工作区
    const ownerOf = new Map()
    for (const workspace of registry.workspaces) {
      for (const sessionId of workspace.sessionIds) {
        if (!ownerOf.has(String(sessionId))) {
          ownerOf.set(String(sessionId), { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, workspacePath: workspace.path })
        }
      }
    }

    // DSH 会话服务提供的补充信息：
    //   running → 正在执行 turn（真正的"运行中"）
    //   live    → 仅表示会话被加载在内存里（可能早已空闲），由 sessions.list() 判定
    const summaryById = new Map()
    if (typeof deps.listRecords === 'function') {
      await bestEffort(deps, [], 'session-summary', async () => {
        const records = await deps.listRecords()
        for (const record of records || []) {
          const id = String(record && record.sessionId ? record.sessionId : '')
          if (id) summaryById.set(id, record)
        }
      })
    }

    // 工作区路径按目录名反查：group 名是路径的编码形式，命中即可零成本给出 cwd
    const cwdByGroup = new Map()
    for (const workspace of registry.workspaces) {
      if (!workspace.path) continue
      cwdByGroup.set(encodeGroupName(workspace.path), workspace.path)
    }

    const resolver = deps.resolver
    const items = []
    for (const entry of scan.entries) {
      const sessionId = String(entry.sessionId)
      const projection = projections[sessionId] || {}
      const owner = ownerOf.get(sessionId) || null
      const isLive = live.has(sessionId)

      // 解析器缓存（标题 / cwd / 来源），未命中时先留空并排队后台解析
      const parsed = resolver ? resolver.get(sessionId) : null
      if (resolver && entry.logPath) {
        resolver.submit(sessionId, entry.logPath, entry.mtimeMs, entry.sizeBytes)
      }

      const title = (parsed && parsed.title) || projection.title || null
      const summary = summaryById.get(sessionId) || null
      const running = Boolean(summary && summary.running)
      const cwd =
        (parsed && parsed.cwd) ||
        projection.cwd ||
        (summary && summary.cwd) ||
        cwdByGroup.get(entry.group) ||
        (owner && owner.workspacePath) ||
        null
      const createdAt = Number.isFinite(parsed && parsed.createdAt)
        ? parsed.createdAt
        : Number.isFinite(projection.createdAt)
          ? projection.createdAt
          : (summary && Number.isFinite(summary.createdAt) ? summary.createdAt : null)
      // 更新时间：文件系统 mtime 不可得时退化为创建时间
      const updatedAt = Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : createdAt
      const isArchived = archived.has(sessionId)

      items.push({
        sessionId,
        title,
        cwd,
        origin: (parsed && parsed.origin) || null,
        parentSession: (parsed && parsed.parentSession) || null,
        workspaceId: owner ? owner.workspaceId : null,
        workspaceTitle: owner ? owner.workspaceTitle : null,
        archived: isArchived,
        pinned: pinned.has(sessionId),
        live: isLive,
        running,
        sizeBytes: Number(entry.sizeBytes) || 0,
        createdAt: createdAt || null,
        updatedAt: updatedAt || null,
        // 已加载会话也允许删除（会先停止其活动）；仅给出提示信息，不再阻止
        deletable: true,
        blockReason: isLive ? 'attached' : null,
      })
    }

    items.sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })

    const total = items.length
    const archivedCount = items.filter((item) => item.archived).length
    const snapshot = {
      generatedAt: now(),
      stats: {
        total,
        active: total - archivedCount,
        archived: archivedCount,
        live: items.filter((item) => item.live).length,
        running: items.filter((item) => item.running).length,
        bytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
      },
      items,
      titlesPending: resolver ? resolver.pending() : 0,
    }
    if (issueToken) snapshot.confirmToken = issueConfirmToken()
    return snapshot
  }

  /** 按动作解析目标会话。返回 { targets: string[], skipped: [{sessionId,reason}] }。 */
  async function resolveTargets(action, requestedIds, snapshot) {
    const skipped = []
    if (action === 'delete-all') {
      return { targets: snapshot.items.map((item) => item.sessionId), skipped }
    }
    if (action === 'delete-archived') {
      return {
        targets: snapshot.items.filter((item) => item.archived).map((item) => item.sessionId),
        skipped,
      }
    }
    const known = new Map(snapshot.items.map((item) => [item.sessionId, item]))
    const targets = []
    const seen = new Set()
    for (const raw of requestedIds) {
      const sessionId = String(raw)
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      const item = known.get(sessionId)
      if (!item) {
        skipped.push({ sessionId, reason: 'not-found' })
        continue
      }
      if (action === 'delete-sessions') {
        // 「对现有会话也支持删除」——现有会话与归档会话都可删，但运行中的不行。
        targets.push(sessionId)
        continue
      }
      if (action === 'unarchive') {
        if (!item.archived) {
          skipped.push({ sessionId, reason: 'not-archived' })
          continue
        }
        targets.push(sessionId)
        continue
      }
      if (action === 'archive') {
        if (item.archived) {
          skipped.push({ sessionId, reason: 'already-archived' })
          continue
        }
        // 已加载在内存里的会话同样可以归档：归档只是元数据操作，
        // 传 stopActivity 让服务先停掉它可能还在进行的工作即可，不涉及删文件。
        targets.push(sessionId)
        continue
      }
      skipped.push({ sessionId, reason: 'bad-action' })
    }
    return { targets, skipped }
  }

  /**
   * 执行一次动作。返回契约 2.2 的响应体（不含 HTTP 状态处理）。
   * 所有失败都以 { ok:false, error, message } 形式返回，不抛异常。
   */
  async function runAction(body) {
    const request = body && typeof body === 'object' ? body : {}
    const action = typeof request.action === 'string' ? request.action : ''
    const warnings = []

    if (!ACTIONS.has(action)) {
      return { ok: false, error: 'bad-action', message: '不支持的操作：' + String(action || '(空)') }
    }

    if (DELETE_ACTIONS.has(action)) {
      const tokenError = checkConfirmToken(request.confirmToken)
      if (tokenError) {
        return { ok: false, error: tokenError, message: '删除操作需要先刷新列表以获取确认令牌' }
      }
      const expected = CONFIRM_PHRASES[action]
      if (String(request.confirmPhrase || '') !== expected) {
        return {
          ok: false,
          error: 'confirm-phrase-mismatch',
          message: '确认短语不匹配，需要输入「' + expected + '」',
        }
      }
    }

    const requestedIds = Array.isArray(request.ids) ? request.ids : []
    if (!DELETE_ACTIONS.has(action) && requestedIds.length === 0) {
      return { ok: false, error: 'no-target', message: '请先选择要操作的会话' }
    }

    const snapshot = await buildSnapshot({ issueToken: false })
    const resolved = await resolveTargets(action, requestedIds, snapshot)

    // 「清空全部归档」还要顺带清掉磁盘已不存在的幽灵归档 id，
    // 否则它们会永远留在归档集合里、界面上永远显示为「已归档」。
    const ghostArchiveIds = []
    if (action === 'delete-archived') {
      try {
        const registryNow = await deps.store.readRegistry(deps.paths)
        const onDisk = new Set(snapshot.items.map((item) => item.sessionId))
        for (const raw of registryNow.archivedSessionIds) {
          const id = String(raw)
          if (onDisk.has(id)) continue
          if (resolved.targets.indexOf(id) >= 0) continue
          resolved.targets.push(id)
          ghostArchiveIds.push(id)
        }
      } catch (error) {
        report(deps, 'warn', { where: 'collect-ghost-archive', message: String(error) })
      }
    }

    const skipped = resolved.skipped.slice()

    if (resolved.targets.length === 0) {
      return { ok: false, error: 'no-target', message: '解析后没有任何可操作的会话', skipped }
    }

    const done = []
    const blocked = []
    const byId = new Map(snapshot.items.map((item) => [item.sessionId, item]))

    if (action === 'delete-sessions' || action === 'delete-archived' || action === 'delete-all') {
      const entries = new Map()
      const scan = await deps.store.scanSessionDirectories(deps.paths)
      for (const entry of scan.entries) entries.set(String(entry.sessionId), entry)

      // 先让 DSH 自己的 workspace 服务解除关联：workspaceRegistry 是内存索引，
      // 只改 workspace.json 文件它感知不到，官方侧边栏会一直显示已删除的会话。
      // 走 detachSession / unarchiveSession / unpinSession 才会推送快照刷新侧边栏。
      const detachable = resolved.targets.filter((sessionId) => {
        const item = byId.get(sessionId)
        return !(item && item.live)
      })
      if (typeof deps.detachSessions === 'function' && detachable.length > 0) {
        await bestEffort(deps, warnings, 'detach-from-workspace-failed', () =>
          deps.detachSessions(detachable),
        )
      }

      for (const sessionId of resolved.targets) {
        const item = byId.get(sessionId)

        // 已加载在内存里的会话也允许删除：实测 DSH 不长期独占日志文件句柄，
        // 删除本身可以成功。但若它正在执行 turn（running），先让服务停掉它的
        // 活动，避免"边写边删"产生半截日志。删完后 DSH 内存里的旧对象可能仍在，
        // 重启后彻底消失——界面会就此给出提示。
        if (item && (item.running || item.live) && typeof deps.archive === 'function') {
          await bestEffort(deps, warnings, 'stop-before-delete-failed', () =>
            deps.archive(sessionId, { stopActivity: true }),
          )
        }

        const entry = entries.get(sessionId)
        if (!entry) {
          // 磁盘上已经不存在（幽灵归档）：不需要删目录，但要把注册表引用清掉
          if (ghostArchiveIds.indexOf(sessionId) >= 0) {
            done.push(sessionId)
            continue
          }
          skipped.push({ sessionId, reason: 'not-on-disk' })
          continue
        }
        try {
          const result = await deps.store.deleteSessionDirectory(deps.paths, entry)
          done.push(sessionId)
          report(deps, 'deleted', {
            sessionId,
            removed: result.removed.length,
            freedBytes: result.freedBytes,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          blocked.push({ sessionId, reason: 'delete-failed', message })
          report(deps, 'error', { where: 'delete', sessionId, message })
        }
      }

      if (done.length > 0) {
        await bestEffort(deps, warnings, 'registry-purge-failed', () =>
          deps.store.purgeWorkspaceRegistry(deps.paths, {
            sessionIds: done,
            dropArchive: true,
            dropPin: true,
          }),
        )
        await bestEffort(deps, warnings, 'projection-cache-purge-failed', () =>
          deps.store.purgeProjectionCache(deps.paths, done),
        )
      }
    } else {
      const method = action === 'archive' ? 'archive' : 'unarchive'
      const call = action === 'archive' ? deps.archive : deps.unarchive
      if (typeof call !== 'function') {
        return { ok: false, error: 'registry-unavailable', message: '归档服务当前不可用' }
      }
      for (const sessionId of resolved.targets) {
        try {
          // 取消归档后，若该会话并不在任何工作区里，官方侧边栏不会恢复它
          // （侧边栏按 workspace.sessionIds 渲染）。这里按 cwd 重新挂回对应工作区。
          if (action === 'unarchive' && typeof deps.ensureWorkspaceLink === 'function') {
            await bestEffort(deps, warnings, 'relink-workspace-failed', () =>
              deps.ensureWorkspaceLink([sessionId]),
            )
          }
          if (action === 'archive') {
            // 对已加载/运行中的会话，先让服务停掉它的活动再归档，避免直接失败。
            const item = byId.get(sessionId)
            const stopActivity = Boolean(item && (item.live || item.running))
            await call(sessionId, { stopActivity })
          } else {
            await call(sessionId)
          }
          done.push(sessionId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          blocked.push({ sessionId, reason: 'action-failed', message })
          report(deps, 'error', { where: action, sessionId, message })
        }
      }
    }

    const next = await buildSnapshot({ issueToken: false })
    return {
      ok: true,
      action,
      done,
      skipped,
      blocked,
      warnings,
      stats: next.stats,
    }
  }

  /** 删除后的独立复核：确认磁盘与三份注册表都不再残留这些 id。 */
  async function verify(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(String)
    const detail = await deps.store.verifyGone(deps.paths, list)
    const gone =
      detail.stillOnDisk.length === 0 &&
      detail.stillInRegistry.length === 0 &&
      detail.stillArchived.length === 0 &&
      detail.stillInProjectionCache.length === 0
    return { ok: true, gone, detail }
  }

  return { buildSnapshot, runAction, verify, formatBytes }
}

// ---------------------------------------------------------------------------
// HTTP 承载
// ---------------------------------------------------------------------------

/** 读取并解析 JSON 请求体；空体返回 {}；超过上限抛 BadRequest。 */
export function readJsonBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body-too-large'))
        try {
          req.destroy()
        } catch {
          /* 忽略 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('invalid-json'))
      }
    })
  })
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/**
 * 创建 HTTP handler。manager 来自 createManager()。
 * 路由：GET <prefix>/list、POST <prefix>/action、POST <prefix>/verify。
 */
export function createHandler(manager) {
  return async function handler(req, res) {
    try {
      const rawUrl = typeof req.url === 'string' ? req.url : ''
      const pathname = rawUrl.split('?')[0].replace(/\/+$/, '') || '/'
      const method = (req.method || 'GET').toUpperCase()

      if (pathname === API_PREFIX + '/list' && method === 'GET') {
        sendJson(res, { ok: true, ...(await manager.buildSnapshot({ issueToken: true })) })
        return
      }

      if (pathname === API_PREFIX + '/action' && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, await manager.runAction(body))
        return
      }

      if (pathname === API_PREFIX + '/verify' && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, await manager.verify(body.ids))
        return
      }

      sendJson(res, { ok: false, error: 'not-found', message: '未知端点' }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = message === 'invalid-json' ? 'bad-request' : 'internal'
      sendJson(res, { ok: false, error: code, message }, 200)
    }
  }
}