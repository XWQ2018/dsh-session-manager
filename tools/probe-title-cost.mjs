/**
 * 探测：从会话日志里读 title 事件与 header 的成本，以及 group 目录名的正向编码规则。
 * 纯只读；运行 node tools/probe-title-cost.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')

/** 全帧解压：Node 的 zstdDecompressSync 只解第一帧，多帧日志必须走流。 */
function decompressAll(file) {
  const raw = readFileSync(file)
  const out = []
  let offset = 0
  while (offset < raw.length) {
    try {
      const chunk = zlib.zstdDecompressSync(raw.subarray(offset))
      out.push(chunk)
      // 无法得知单帧消费长度，这里退化为整体流式解压
      break
    } catch (error) {
      break
    }
  }
  void out
  // 用流式解压器兜底：它能连续解多帧
  try {
    const stream = zlib.createZstdDecompress()
    const chunks = []
    stream.on('data', (c) => chunks.push(c))
    return new Promise((resolve) => {
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.end(raw)
    })
  } catch (error) {
    return Promise.resolve('')
  }
}

function encodeGroup(p) {
  // 从实测样本反推：删除 ':'，非 ASCII 转 ~XXXX，其余非字母数字转 '-'
  let out = ''
  for (const ch of p) {
    const code = ch.codePointAt(0)
    if (/[A-Za-z0-9]/.test(ch)) out += ch
    else if (ch === ':') continue
    else if (code > 127) out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    else out += '-'
  }
  return '--' + out + '--'
}

// 1) 验证编码规则
const ws = JSON.parse(readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
const groups = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const groupSet = new Set(groups)
let hit = 0
for (const id of Object.keys(ws.tables.workspaces)) {
  const record = ws.tables.workspaces[id]
  const encoded = encodeGroup(record.path)
  const matched = groupSet.has(encoded)
  if (matched) hit += 1
  console.log('工作区', String(record.title).padEnd(24), matched ? 'OK ' : 'MISS', encoded, '<=', record.path)
}
console.log('编码规则命中 ' + hit + ' / ' + Object.keys(ws.tables.workspaces).length + ' 个工作区')
console.log('磁盘分组数 ' + groups.length + '，未被工作区覆盖的分组: ' + groups.filter((g) => !Object.values(ws.tables.workspaces).some((r) => encodeGroup(r.path) === g)).length)

// 2) 抽样测日志解析成本
const sample = []
for (const group of groups) {
  const dir = path.join(sessionsRoot, group)
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    sample.push({ group, id: child.name, dir: path.join(dir, child.name) })
  }
}
const picks = []
for (let i = 0; i < sample.length && picks.length < 6; i += Math.max(1, Math.floor(sample.length / 6))) picks.push(sample[i])

console.log('')
console.log('== 日志解析成本抽样 ==')
for (const item of picks) {
  const files = readdirSync(item.dir).filter((n) => n.includes('.jsonl.'))
  if (files.length === 0) continue
  const logPath = path.join(item.dir, files.sort().pop())
  const started = Date.now()
  const text = await decompressAll(logPath)
  const elapsed = Date.now() - started
  const lines = text.split('\n').filter(Boolean)
  let header = null
  let title = null
  for (const line of lines) {
    try {
      const evt = JSON.parse(line)
      if (!header && (evt.type === 'session' || evt.id)) header = evt
      if (evt.type === 'session/title' && evt.data && typeof evt.data.title === 'string') title = evt.data.title
    } catch (error) {
      /* 忽略坏行 */
    }
  }
  console.log(
    item.id.slice(0, 26).padEnd(28),
    'ms=' + String(elapsed).padEnd(6),
    'events=' + String(lines.length).padEnd(6),
    'cwd=' + String(header && header.cwd).padEnd(16),
    'title=' + (title || '(无)'),
  )
}