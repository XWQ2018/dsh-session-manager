/**
 * 探测：DSH 进程是否持续占用「已加载」会话的日志文件句柄。
 * 只用 FileShare.None 打开再立即关闭，不写入、不删除，纯只读探测。
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const ORIGIN = process.env.DSH_WEB_URL
const sessionsRoot = path.join(HOME, 'sessions')

const res = await fetch(ORIGIN + '/api/dsh-session-manager/list')
const data = await res.json()
const liveItems = data.items.filter((item) => item.live)
console.log('已加载会话数:', liveItems.length)

// 建立 sessionId -> 日志绝对路径
const pathOf = new Map()
for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    const dir = path.join(sessionsRoot, group.name, child.name)
    const files = readdirSync(dir).filter((name) => name.includes('.jsonl.'))
    if (files.length === 0) continue
    pathOf.set(child.name, path.join(dir, files.sort().pop()))
  }
}

const targets = liveItems.slice(0, 6)
if (targets.length === 0) {
  console.log('没有已加载会话可探测')
  process.exit(0)
}

const psScript = (file) => `
$p = '${file.replace(/'/g, "''")}'
try {
  $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $fs.Close()
  'EXCLUSIVE_OK'
} catch {
  'LOCKED: ' + $_.Exception.GetType().Name
}
`

let exclusive = 0
let locked = 0
for (const item of targets) {
  const file = pathOf.get(item.sessionId)
  if (!file) {
    console.log(item.sessionId.slice(0, 26), '-> 找不到日志文件')
    continue
  }
  let verdict = ''
  try {
    verdict = execFileSync('pwsh', ['-NoProfile', '-Command', psScript(file)], { encoding: 'utf8' }).trim()
  } catch (error) {
    verdict = 'ERR: ' + String(error.message).slice(0, 60)
  }
  if (verdict === 'EXCLUSIVE_OK') exclusive += 1
  else locked += 1
  console.log(
    item.sessionId.slice(0, 26).padEnd(28),
    'live=' + item.live,
    'running=' + item.running,
    '| 独占打开:' + verdict,
  )
}
console.log('')
console.log('可独占打开（未被持续占用）:', exclusive, '| 被占用:', locked)