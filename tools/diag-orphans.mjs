/**
 * 诊断二：磁盘会话与工作区登记的交叉一致性。
 * 纯只读。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const raw = JSON.parse(readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
const workspaces = (raw.tables && raw.tables.workspaces) || {}
const archived = new Set((raw.global.archivedSessionIds || []).map(String))

const inWorkspace = new Set()
for (const record of Object.values(workspaces)) {
  for (const id of record.sessionIds || []) inWorkspace.add(String(id))
}

const sessionsRoot = path.join(home, 'sessions')
const disk = []
for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    disk.push({ id: child.name, group: group.name, dir: path.join(sessionsRoot, group.name, child.name) })
  }
}

const orphans = disk.filter((item) => !inWorkspace.has(item.id))
console.log('磁盘会话:', disk.length)
console.log('工作区登记:', inWorkspace.size)
console.log('磁盘上但不在任何工作区:', orphans.length, '  ← 这些在官方侧边栏看不到，但插件列表能看到')
console.log('')

// 读 header 看 cwd/origin
function readHeader(dir) {
  const files = readdirSync(dir).filter((n) => n.includes('.jsonl.'))
  if (files.length === 0) return null
  const buf = readFileSync(path.join(dir, files.sort().pop()))
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const at = buf.indexOf(magic)
  if (at < 0) return null
  try {
    const chunk = zlib.zstdDecompressSync(buf.subarray(at, at + 65536))
    const line = chunk.toString('utf8').split('\n')[0]
    return JSON.parse(line)
  } catch (error) {
    return null
  }
}

console.log('孤儿会话样例（前 10 个）:')
let subagent = 0
let main = 0
for (const item of orphans.slice(0, 10)) {
  const header = readHeader(item.dir)
  const origin = header && header.origin ? header.origin : 'main'
  const cwd = header && header.cwd ? header.cwd : '(未知)'
  if (origin === 'subagent') subagent += 1
  else main += 1
  console.log(
    '  ' + item.id.slice(0, 30).padEnd(32) +
    'origin=' + String(origin).padEnd(10) +
    '归档=' + String(archived.has(item.id)).padEnd(6) +
    'cwd=' + cwd,
  )
}
for (const item of orphans) {
  const header = readHeader(item.dir)
  if (header && header.origin === 'subagent') subagent += 1
  else main += 1
}
console.log('')
console.log('孤儿中 子会话:', subagent, '| 主会话:', main)
console.log('（子会话本来就不出现在侧边栏，属正常）')