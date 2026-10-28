/**
 * 会话管理 Host 半边入口。
 *
 * 职责边界：
 *  - HTTP 路由的注册与生命周期（全部走 ctx.effect，卸载即释放）；
 *  - 把 cordis 服务适配成 lib/host-api.js 需要的依赖；
 *  - 所有业务逻辑都在 host-api.js 里，那边不依赖 cordis，便于隔离测试。
 */
import path from 'node:path'
import { API_PREFIX, createHandler, createManager } from './lib/host-api.js'
import * as store from './lib/session-store.js'
import { createTitleResolver } from './lib/title-resolver.js'

/** 硬依赖：webServer（HTTP 承载）与 workspaceRegistry（归档状态）。 */
export const inject = ['webServer', 'workspaceRegistry']

export function apply(ctx) {
  const paths = store.resolvePaths(process.env)
  const webServer = ctx.webServer
  const registry = ctx.workspaceRegistry

  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-session-manager] webServer 不可用，插件未注册 HTTP 路由')
    return
  }

  /** 当前挂载在内存里的会话：这些正在被使用，禁止物理删除。 */
  function liveIds() {
    try {
      const sessions = ctx.get('sessions')
      if (!sessions || typeof sessions.list !== 'function') return []
      return sessions.list().map((session) => String(session.id))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-session-manager] 读取内存会话失败：' + String(error))
      return []
    }
  }

  /**
   * 可选的会话摘要来源。
   * 优先 sessionController.list（含 running：是否正在执行 turn），
   * 退化到 sessionQuery.listSessions（只有 header，running 一律视为 false）。
   */
  function listRecords() {
    const controller = ctx.get('sessionController')
    if (controller && typeof controller.list === 'function') {
      return async () => {
        const value = await controller.list({}, new AbortController().signal)
        const items = (value && value.items) || []
        return items.map((item) => ({
          sessionId: String(item.sessionId),
          running: item.running === true,
          createdAt: null,
          cwd: typeof item.cwd === 'string' ? item.cwd : null,
        }))
      }
    }
    const query = ctx.get('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      return async () => {
        const records = await query.listSessions()
        return (records || []).map((record) => ({
          sessionId: String(record && record.header ? record.header.id : ''),
          running: false,
          createdAt: record && record.header ? record.header.createdAt : null,
          cwd: record && record.header ? record.header.cwd : null,
        }))
      }
    }
    return null
  }

  // 标题与工作目录解析：缓存 + 后台队列，首屏不阻塞
  const resolver = createTitleResolver({
    cacheFile: path.join(paths.home, 'dsh-session-manager', 'title-cache.json'),
    concurrency: 6,
  })
  try {
    resolver.load()
  } catch (error) {
    ctx.logger?.warn?.('[dsh-session-manager] 标题缓存加载失败：' + String(error))
  }

  /**
   * 让 DSH 的 workspace 服务解除这些会话的关联。
   *
   * 关键：workspaceRegistry 在内存里维护会话索引，直接改 workspace.json 文件它不会重扫，
   * 官方侧边栏（订阅 workspaceController.follow 快照）就会一直显示已删除的会话。
   * 只有走 Workspace.detachSession / unarchiveSession / unpinSession 才会：
   *   1. 更新内存索引；2. 持久化；3. 向客户端推送新的快照。
   */
  async function detachSessions(sessionIds) {
    const wanted = new Set(sessionIds.map(String))
    const problems = []

    let workspaces = []
    try {
      workspaces = typeof registry.list === 'function' ? registry.list() : []
    } catch (error) {
      problems.push('list: ' + String(error))
      workspaces = []
    }

    for (const workspace of workspaces) {
      let owned = []
      try {
        owned = (workspace.sessionIds || []).map(String).filter((id) => wanted.has(id))
      } catch (error) {
        problems.push('sessionIds: ' + String(error))
        continue
      }
      for (const sessionId of owned) {
        try {
          await workspace.detachSession(sessionId)
        } catch (error) {
          // 已经不在该工作区里时可能抛错，忽略即可
          problems.push('detach ' + sessionId + ': ' + String(error))
        }
      }
    }

    for (const sessionId of wanted) {
      try {
        await registry.unarchiveSession(sessionId)
      } catch (error) {
        problems.push('unarchive ' + sessionId + ': ' + String(error))
      }
      try {
        await registry.unpinSession(sessionId)
      } catch (error) {
        problems.push('unpin ' + sessionId + ': ' + String(error))
      }
    }

    if (problems.length > 0) {
      ctx.logger?.warn?.('[dsh-session-manager] 解除工作区关联时有问题：' + problems.slice(0, 5).join('; '))
    }
  }

  /**
   * 确保这些会话挂在某个工作区下。
   *
   * 为什么需要：DSH 官方侧边栏按 `workspace.sessionIds` 渲染。取消归档只从
   * 归档集合里移除标记，并不会重建工作区关联；若会话此前不在任何工作区
   * （或曾被 detach），侧边栏就不会恢复它。这里按 header.cwd 与 workspace.path
   * 匹配，调用 attachSession 挂回去。
   */
  async function ensureWorkspaceLink(sessionIds) {
    let workspaces = []
    try {
      workspaces = typeof registry.list === 'function' ? registry.list() : []
    } catch (error) {
      return
    }
    if (workspaces.length === 0) return

    for (const sessionId of sessionIds.map(String)) {
      const linked = workspaces.some((workspace) => {
        try {
          return (workspace.sessionIds || []).map(String).indexOf(sessionId) >= 0
        } catch (error) {
          return false
        }
      })
      if (linked) continue

      // 会话的 cwd：优先用解析缓存，其次问 sessionQuery
      let cwd = null
      try {
        const cached = resolver.get(sessionId)
        if (cached && cached.cwd) cwd = cached.cwd
      } catch (error) {
        /* 忽略 */
      }
      if (!cwd) {
        const query = ctx.get('sessionQuery')
        if (query && typeof query.readSession === 'function') {
          try {
            const snapshot = await query.readSession(sessionId)
            if (snapshot && snapshot.session && snapshot.session.cwd) cwd = snapshot.session.cwd
          } catch (error) {
            /* 忽略 */
          }
        }
      }
      if (!cwd) continue

      const target = workspaces.find((workspace) => {
        const workspacePath = String(workspace.path || '')
        return workspacePath.toLowerCase() === String(cwd).toLowerCase()
      })
      if (!target) continue

      try {
        await target.attachSession(sessionId)
      } catch (error) {
        ctx.logger?.warn?.('[dsh-session-manager] 重新挂回工作区失败 ' + sessionId + '：' + String(error))
      }
    }
  }

  const manager = createManager({
    paths,
    store,
    resolver,
    liveIds,
    detachSessions,
    ensureWorkspaceLink,
    listRecords: listRecords(),
    archive: (sessionId, options) => registry.archiveSession(sessionId, options),
    unarchive: (sessionId) => registry.unarchiveSession(sessionId),
    log: (event, payload) => {
      const line = '[dsh-session-manager] ' + event + ' ' + JSON.stringify(payload)
      if (event === 'error' || event === 'warn') ctx.logger?.warn?.(line)
      else ctx.logger?.info?.(line)
    },
  })

  const handler = createHandler(manager)

  // 单个前缀路由承接全部三个端点，避免注册顺序敏感。
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    }),
  )

  ctx.logger?.info?.('[dsh-session-manager] 已挂载会话管理 API：' + API_PREFIX)
}