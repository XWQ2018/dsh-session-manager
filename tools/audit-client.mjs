/**
 * 客户端静态审查：视觉红线、依赖红线、无障碍属性。
 * 纯只读；运行 node tools/audit-client.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'client.js')
const text = readFileSync(target, 'utf8')

function count(re) {
  return (text.match(re) || []).length
}

// 纯白是确认类按钮的前景色（红底白字，对比度最高），按用户指定配色放行；
// 其余任何硬编码色值仍然会被列出来。
const allHex = [...new Set(text.match(/#[0-9a-fA-F]{3,8}\b/g) || [])]
const hexColors = allHex.filter((value) => !/^#(fff|ffffff)$/i.test(value))
const allowedHex = allHex.filter((value) => /^#(fff|ffffff)$/i.test(value))
const tokens = [...new Set(text.match(/--dsw-[a-z0-9-]+/g) || [])].sort()
const requires = text.match(/require\(['"][^'"]+['"]\)/g) || []
const officialRequires = requires.filter((item) => item.includes('@deepseek-ai'))

console.log('== 依赖红线')
console.log('  require 语句:', JSON.stringify(requires))
console.log('  官方包 require 数量:', officialRequires.length, officialRequires.length ? JSON.stringify(officialRequires) : '(无)')
console.log('  document.body 出现:', count(/document\.body/g))
console.log('  fetch 调用:', count(/fetch\(/g))
console.log('  try/catch 块:', count(/catch\s*[({]/g))

console.log('== 视觉红线')
console.log('  硬编码 hex 色值:', hexColors.length, hexColors.length ? JSON.stringify(hexColors) : '(无)')
console.log('  白名单（按钮前景纯白）:', allowedHex.length ? JSON.stringify(allowedHex) : '(无)')
console.log('  主题 token 种类:', tokens.length)
console.log('  token 列表:', tokens.join(' '))
console.log('  color-mix 使用:', count(/color-mix\(/g))
console.log('  prefers-reduced-motion:', text.includes('prefers-reduced-motion'))
console.log('  cubic-bezier:', count(/cubic-bezier\(/g))

console.log('== 无障碍')
console.log('  aria-modal:', text.includes('aria-modal'))
console.log('  role dialog:', /role:\s*['"]dialog['"]/.test(text))
console.log('  aria-labelledby:', text.includes('aria-labelledby'))
console.log('  focus-visible:', count(/focus-visible/g))
console.log('  Escape 处理:', /Escape/.test(text))

console.log('== 契约对齐')
console.log('  API 常量:', /const API = '\/api\/dsh-session-manager'/.test(text))
console.log('  list GET:', text.includes('/list'))
console.log('  action POST:', text.includes('/action'))
console.log('  confirmPhrase 赋值处:', count(/payload\.confirmPhrase\s*=/g))
console.log('  confirmToken 赋值处:', count(/payload\.confirmToken\s*=/g))
console.log('  PHRASE_OF 存在:', /const PHRASE_OF/.test(text))
console.log('  三个删除动作都要求短语:', /delete-sessions[\s\S]{0,40}PHRASE_DELETE/.test(text))

console.log('== 结构')
console.log('  ModuleLoader:', text.includes('__ModuleLoader__.load'))
console.log('  sidebar.panellist:', text.includes("'sidebar.panellist'"))
console.log('  main 注册:', /name:\s*'main'/.test(text))
console.log('  useSyncExternalStore:', text.includes('useSyncExternalStore'))
console.log('  行数:', text.split('\n').length)
