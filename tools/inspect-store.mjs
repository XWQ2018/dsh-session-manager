/**
 * 只读侦察脚本：打印 DSH 存储文件的结构骨架，供数据层与验证层参考。
 * 用法：node tools/inspect-store.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'

function shape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `array(${value.length}) ${value.length ? shape(value[0], depth + 1) : ''}`
  }
  if (typeof value === 'object') {
    if (depth > 2) return 'object{...}'
    const keys = Object.keys(value)
    return `object{${keys.slice(0, 8).join(',')}${keys.length > 8 ? `,…+${keys.length - 8}` : ''}}`
  }
  return typeof value
}

function report(label, path) {
  if (!existsSync(path)) {
    console.log(`== ${label} :: 不存在 ${path}`)
    return
  }
  const size = statSync(path).size
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    console.log(`== ${label} :: ${size} bytes`)
    console.log(`   unit: ${JSON.stringify(json.unit ?? null)}`)
    for (const [key, value] of Object.entries(json)) {
      if (key === 'unit') continue
      console.log(`   ${key}: ${shape(value)}`)
    }
    if (json.global && typeof json.global === 'object') {
      for (const [key, value] of Object.entries(json.global)) {
        const isArray = Array.isArray(value)
        console.log(
          `   global.${key}: ${isArray ? `array(${value.length})` : shape(value)}${
            isArray && value.length ? ` sample=${JSON.stringify(value[0]).slice(0, 120)}` : ''
          }`,
        )
      }
    }
    // 打印非 global 的映射类字段的样本键
    for (const [key, value] of Object.entries(json)) {
      if (key === 'unit' || key === 'global') continue
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value)
        console.log(`   ${key} 样本 (共 ${entries.length}):`)
        for (const [k, v] of entries.slice(0, 2)) {
          console.log(`     - ${k} => ${JSON.stringify(v).slice(0, 400)}`)
        }
      }
    }
  } catch (error) {
    console.log(`== ${label} :: 解析失败 ${String(error)} (${size} bytes)`)
  }
}

report('workspace.json', join(home, 'storages', 'workspace.json'))
report('session_projcache.json', join(home, 'storages', 'session_projcache.json'))
report('schedule.json', join(home, 'storages', 'schedule.json'))
report('dsh-session-archive/state.json', join(home, 'dsh-session-archive', 'state.json'))
report('dsh-session-archive/archive-ledger.json', join(home, 'dsh-session-archive', 'archive-ledger.json'))

const sessionsRoot = join(home, 'sessions')
if (existsSync(sessionsRoot)) {
  const groups = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  console.log(`== sessions 目录：${groups.length} 个分组`)
  for (const group of groups.slice(0, 3)) {
    const dir = join(sessionsRoot, group.name)
    const children = readdirSync(dir, { withFileTypes: true })
    console.log(`   ${group.name}: ${children.length} 项 → ${children.slice(0, 3).map((c) => c.name).join(', ')}`)
    const firstChild = children.find((c) => c.isDirectory())
    if (firstChild) {
      const inner = readdirSync(join(dir, firstChild.name))
      console.log(`      会话目录 ${firstChild.name} → ${inner.join(', ')}`)
    }
  }
}
