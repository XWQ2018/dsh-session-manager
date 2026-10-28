/**
 * 探测：按 zstd 帧头切分多帧日志，验证能否读到 session/title 事件与真实耗时。
 * 纯只读；运行 node tools/probe-frames.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 找出所有帧起始偏移。 */
function frameOffsets(buf) {
  const offsets = []
  let from = 0
  while (from < buf.length) {
    const at = buf.indexOf(MAGIC, from)
    if (at < 0) break
    offsets.push(at)
    from = at + 4
  }
  return offsets
}

/** 逐帧解压，返回拼接后的文本与帧数统计。 */
function decompressFrames(buf) {
  const offsets = frameOffsets(buf)
  const parts = []
  let ok = 0
  let failed = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
      ok += 1
    } catch (error) {
      failed += 1
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, ok, failed }
}

const groups = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
const all = []
for (const group of groups) {
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    all.push({ group: group.name, id: child.name, dir: path.join(sessionsRoot, group.name, child.name) })
  }
}

// 只取主会话（session- 前缀），它们才可能被自动命名
const mains = all.filter((item) => item.id.startsWith('session-')).slice(0, 6)

console.log('== 多帧解压探测（主会话样本）==')
let withTitle = 0
let totalMs = 0
for (const item of mains) {
  const files = readdirSync(item.dir).filter((n) => n.includes('.jsonl.'))
  if (files.length === 0) continue
  const logPath = path.join(item.dir, files.sort().pop())
  const size = statSync(logPath).size
  const started = Date.now()
  const buf = readFileSync(logPath)
  const { text, frames, ok, failed } = decompressFrames(buf)
  const elapsed = Date.now() - started
  totalMs += elapsed

  const lines = text.split('\n').filter(Boolean)
  let title = null
  let header = null
  for (const line of lines) {
    let evt
    try {
      evt = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (!header && evt.type === 'session') header = evt
    if (evt.type === 'session/title' && evt.data && typeof evt.data.title === 'string') title = evt.data.title
  }
  if (title) withTitle += 1
  console.log(
    item.id.slice(0, 24).padEnd(26),
    'size=' + String(size).padEnd(9),
    'frames=' + String(frames).padEnd(6),
    'ok=' + String(ok).padEnd(5),
    'bad=' + String(failed).padEnd(4),
    'ms=' + String(elapsed).padEnd(6),
    'events=' + String(lines.length).padEnd(6),
    'title=' + (title || '(无)'),
  )
  void header
}
console.log('')
console.log('主会话样本 ' + mains.length + ' 个，其中有 title 的 ' + withTitle + ' 个，累计 ' + totalMs + 'ms，平均 ' + Math.round(totalMs / Math.max(1, mains.length)) + 'ms/个')