/**
 * 诊断：某个会话日志里一共有几个 session/title 事件、分别是什么。
 * 用法：node tools/diag-titles.mjs 2a340f3751da
 * 纯只读。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const needle = process.argv[2] || '2a340f3751da'
const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const disk = []
for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    disk.push({ id: child.name, group: group.name, dir: path.join(sessionsRoot, group.name, child.name) })
  }
}
const compact = (v) => String(v).replace(/-/g, '').toLowerCase()
const hit = disk.find((item) => compact(item.id).indexOf(compact(needle)) >= 0)
if (!hit) {
  console.log('未找到会话:', needle)
  process.exit(1)
}

const files = readdirSync(hit.dir).filter((n) => n.includes('.jsonl.'))
const logPath = path.join(hit.dir, files.sort().pop())
const buf = readFileSync(logPath)

const offsets = []
let from = 0
while (from < buf.length) {
  const at = buf.indexOf(MAGIC, from)
  if (at < 0) break
  offsets.push(at)
  from = at + 4
}

console.log('会话:', hit.id)
console.log('日志:', path.basename(logPath), '|', buf.length, 'B |', offsets.length, '帧')

const titles = []
let header = null
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  let chunk = null
  try {
    chunk = zlib.zstdDecompressSync(buf.subarray(start, end))
  } catch (error) {
    continue
  }
  const text = chunk.toString('utf8')
  if (i === 0) {
    try {
      header = JSON.parse(text.split('\n')[0])
    } catch (error) {
      /* 忽略 */
    }
  }
  if (text.indexOf('session/title') < 0) continue
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('session/title') < 0) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'session/title' && evt.data) {
        titles.push({ frame: i, seq: evt.seq, title: evt.data.title, source: evt.data.source })
      }
    } catch (error) {
      /* 忽略 */
    }
  }
}

console.log('header:', JSON.stringify({ id: header && header.id, cwd: header && header.cwd, origin: header && header.origin }))
console.log('')
console.log('共 ' + titles.length + ' 个 title 事件：')
for (const item of titles) {
  const source = item.source ? (item.source.kind || JSON.stringify(item.source)) : '(无)'
  console.log('  帧#' + String(item.frame).padEnd(4) + 'seq=' + String(item.seq).padEnd(7) + 'source=' + String(source).padEnd(10) + ' title=' + JSON.stringify(item.title))
}

if (titles.length > 1) {
  console.log('')
  console.log('→ 说明：同一个会话有多条标题记录。插件必须取【最后一条】，否则会显示成早期标题。')
}