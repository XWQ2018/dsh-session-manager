/**
 * 诊断：归档集合里的会话，有多少仍挂在某个 workspace.sessionIds 下。
 * 若大量不在，说明「取消归档」只清了标记、没有重建工作区关联，官方侧边栏就不会恢复。
 * 纯只读。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const raw = JSON.parse(readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
const global = raw.global || {}
const workspaces = (raw.tables && raw.tables.workspaces) || {}
const archived = (global.archivedSessionIds || []).map(String)
const pinned = (global.pinnedSessionIds || []).map(String)

const inWorkspace = new Map() // sessionId -> workspaceId
for (const [workspaceId, record] of Object.entries(workspaces)) {
  for (const id of record.sessionIds || []) inWorkspace.set(String(id), workspaceId)
}

// 磁盘上真实存在的会话
const disk = new Set()
const sessionsRoot = path.join(home, 'sessions')
if (existsSync(sessionsRoot)) {
  for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
      if (child.isDirectory()) disk.add(child.name)
    }
  }
}

console.log('工作区数:', Object.keys(workspaces).length)
console.log('归档会话数:', archived.length)
console.log('磁盘会话数:', disk.size)

const archivedOnDisk = archived.filter((id) => disk.has(id))
const archivedNotOnDisk = archived.filter((id) => !disk.has(id))
const archivedWithoutWorkspace = archivedOnDisk.filter((id) => !inWorkspace.has(id))
const archivedWithWorkspace = archivedOnDisk.filter((id) => inWorkspace.has(id))

console.log('')
console.log('归档且仍在磁盘:', archivedOnDisk.length)
console.log('  其中【不在任何工作区】:', archivedWithoutWorkspace.length, '  ← 取消归档后侧边栏不会恢复')
console.log('  其中【仍在工作区】    :', archivedWithWorkspace.length)
console.log('归档但磁盘已不存在（幽灵归档）:', archivedNotOnDisk.length)

if (archivedWithoutWorkspace.length > 0) {
  console.log('')
  console.log('样例（归档但无工作区归属）:')
  for (const id of archivedWithoutWorkspace.slice(0, 8)) {
    const where = readdirSync(sessionsRoot).find((group) =>
      existsSync(path.join(sessionsRoot, group, id)),
    )
    console.log('  ' + id.padEnd(44) + ' 目录分组=' + where)
  }
}

// 工作区里登记了但磁盘没有的（反向不一致）
const wsOnly = [...inWorkspace.keys()].filter((id) => !disk.has(id))
console.log('')
console.log('工作区登记但磁盘缺失:', wsOnly.length)
if (wsOnly.length > 0) for (const id of wsOnly.slice(0, 6)) console.log('  ' + id)

console.log('')
console.log('置顶数:', pinned.length)