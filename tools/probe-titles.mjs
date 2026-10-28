/**
 * 抽样检查会话日志里是否存在 title 事件，判断"列表大多无标题"是数据缺失还是解析遗漏。
 * 纯只读；运行 node tools/probe-titles.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const sessionsRoot = path.join(home, 'sessions')

const groups = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
const pick = []
for (const group of groups) {
  for (const child of readdirSync(path.join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    pick.push({ group: group.name, id: child.name, dir: path.join(sessionsRoot, group.name, child.name) })
  }
}

// 抽样：前 3 个 + 中间 3 个 + 最后 3 个
const sample = [...pick.slice(0, 3), ...pick.slice(Math.floor(pick.length / 2), Math.floor(pick.length / 2) + 3), ...pick.slice(-3)]

let withTitle = 0
let parsed = 0
for (const item of sample) {
  const files = readdirSync(item.dir).filter((n) => n.includes('.jsonl.'))
  if (files.length === 0) {
    console.log(item.id.slice(0, 20), '→ 无日志文件')
    continue
  }
  const logName = files.sort().pop()
  const logPath = path.join(item.dir, logName)
  const started = Date.now()
  let text
  try {
    text = zlib.zstdDecompressSync(readFileSync(logPath)).toString('utf8')
  } catch (error) {
    console.log(item.id.slice(0, 20), '→ 解压失败', String(error.message).slice(0, 60))
    continue
  }
  const elapsed = Date.now() - started
  parsed += 1
  const lines = text.split('\n').filter(Boolean)
  let title = null
  for (const line of lines) {
    if (!line.includes('title')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'session/title' && evt.data && typeof evt.data.title === 'string') title = evt.data.title
    } catch {
      /* 忽略坏行 */
    }
  }
  if (title) withTitle += 1
  const header = JSON.parse(lines[0])
  console.log(
    item.id.slice(0, 22).padEnd(24),
    'events=' + String(lines.length).padEnd(6),
    'size=' + String(statSync(logPath).size).padEnd(9),
    'decompress=' + String(elapsed).padEnd(5) + 'ms',
    'title=' + (title || '(无)'),
    '| origin=' + (header.origin || 'main'),
  )
}

console.log('')
console.log('抽样 ' + sample.length + ' 个，成功解析 ' + parsed + ' 个，其中有 title 事件 ' + withTitle + ' 个')
