/**
 * 检查 client.js 的文案键完整性：
 *  - 所有 t('key') 使用的键都必须在 zh / en 字典里存在（缺失即失败）；
 *  - 列出定义了但没被使用的键（仅提示，不失败）。
 *
 * 纯只读；运行 node tools/check-locale.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const text = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/**
 * 取出某个字典对象字面量的第一层键。
 * 字典在源码里是「一行一个 key: 'value'」的扁平结构，按行匹配即可；
 * 不要逐字符扫描，否则会把 value 的后缀误当成键。
 */
function dictKeys(name) {
  const start = text.indexOf('const ' + name + ' = {')
  if (start < 0) return null
  const open = text.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null

  const body = text.slice(open + 1, end)
  const keys = new Set()
  for (const line of body.split('\n')) {
    const match = /^\s+([A-Za-z_$][\w$]*)\s*:/.exec(line)
    if (!match) continue
    keys.add(match[1])
  }
  return keys
}

const zh = dictKeys('zh')
const en = dictKeys('en')
if (!zh || !en) {
  console.error('未找到 zh / en 字典')
  process.exit(1)
}

const used = new Set()
const re = /\bt\(\s*'([^']+)'/g
let match
while ((match = re.exec(text)) !== null) used.add(match[1])

const missingZh = [...used].filter((key) => !zh.has(key)).sort()
const missingEn = [...used].filter((key) => !en.has(key)).sort()
const unusedZh = [...zh].filter((key) => !used.has(key)).sort()

console.log('zh 键数: ' + zh.size + ' | en 键数: ' + en.size + ' | 使用中: ' + used.size)
console.log('zh 缺失: ' + (missingZh.length ? missingZh.join(', ') : '(无)'))
console.log('en 缺失: ' + (missingEn.length ? missingEn.join(', ') : '(无)'))
// 注意：通过变量间接调用的键（例如 t(dialogDescKey(kind))）无法被静态扫描到，
// 也会出现在这个列表里，因此它只是「可能是冗余」的提示，不能据此删除。
console.log(
  '可能是冗余的键: ' +
    unusedZh.length +
    (unusedZh.length
      ? '（' + unusedZh.slice(0, 8).join(', ') + (unusedZh.length > 8 ? ' …' : '') + '；经变量间接调用的键也会落入此列）'
      : ''),
)

if (missingZh.length || missingEn.length) process.exitCode = 1
