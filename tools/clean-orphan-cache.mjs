/**
 * 清理孤儿投影缓存：storages/session_projcache/sessions/<id>.json 里
 * 存在、但 sessions/ 目录下已无对应会话的那些文件。
 *
 * 为什么需要：DSH 的投影缓存是「目录版」（每个会话一个 json），
 * 早期删除流程只清了旧的单文件 session_projcache.json，残留文件会让
 * DSH 侧边栏继续显示已删除的会话（未分组里的幽灵条目）。
 *
 * 用法：
 *   node tools/clean-orphan-cache.mjs            # 只列出，不删除
 *   node tools/clean-orphan-cache.mjs --apply    # 真正删除
 */
import { readdirSync, existsSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'

const apply = process.argv.includes('--apply')
const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')
const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')

if (!existsSync(cacheDir)) {
  console.log('投影缓存目录不存在:', cacheDir)
  process.exit(0)
}

// 磁盘上真实存在的会话 id
const disk = new Set()
for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (child.isDirectory()) disk.add(child.name)
  }
}

const files = readdirSync(cacheDir).filter((name) => name.endsWith('.json'))
const orphans = []
for (const name of files) {
  const id = name.slice(0, -'.json'.length)
  if (disk.has(id)) continue
  orphans.push({ id, name, bytes: statSync(path.join(cacheDir, name)).size })
}

console.log('磁盘会话:', disk.size)
console.log('投影缓存文件:', files.length)
console.log('孤儿缓存（对应会话已不存在）:', orphans.length)
console.log('')

for (const item of orphans.slice(0, 12)) {
  console.log('  ' + item.id.padEnd(46) + String(item.bytes).padStart(9) + ' B')
}
if (orphans.length > 12) console.log('  …等共 ' + orphans.length + ' 个')

if (!apply) {
  console.log('')
  console.log('这是预演。加 --apply 参数才会真正删除。')
  process.exit(0)
}

let removed = 0
let freed = 0
for (const item of orphans) {
  try {
    rmSync(path.join(cacheDir, item.name), { force: true })
    removed += 1
    freed += item.bytes
  } catch (error) {
    console.log('  删除失败 ' + item.id + ': ' + String(error))
  }
}
console.log('')
console.log('已删除 ' + removed + ' 个孤儿缓存，释放 ' + (freed / 1024).toFixed(1) + ' KB')