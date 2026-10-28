/**
 * 异步路径静态审查：把「删除后必须刷新、异常不得卡住弹窗」这几条不变量固化成检查，
 * 防止后续改动把它们改回去。
 *
 * 运行 node tools/audit-async-paths.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const text = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : ''))
  }
}

/** 截取某个函数的源码块（从 function 名开始，按花括号配平）。 */
function blockOf(name) {
  const start = text.indexOf('function ' + name + '(')
  if (start < 0) return ''
  const open = text.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

const loadBlock = blockOf('load')
const performBlock = blockOf('performAction')
const postBlock = blockOf('postAction')
const pageBlock = blockOf('SessionManagerPage')

console.log('== load：强制刷新能力 ==')
check('load 支持 force 选项', /const force = options && options\.force === true/.test(loadBlock))
check('force 时先等待进行中的请求', /if \(!force\) return inflight[\s\S]{0,120}await inflight/.test(loadBlock))
check('load 结束后释放 inflight', /finally\s*\{[\s\S]*inflight = null/.test(loadBlock))

console.log('== performAction：不卡死 + 立即生效 ==')
check('performAction 存在 try 块', /try\s*\{/.test(performBlock))
check('performAction 存在 catch 兜底', /catch \(error\)/.test(performBlock))
check('performAction 存在 finally 兜底', /finally\s*\{/.test(performBlock))
check(
  'finally 中兜底解除 dialog.busy',
  /finally\s*\{[\s\S]*state\.dialog && state\.dialog\.busy[\s\S]*patchDialog\(\{ busy: false \}\)/.test(performBlock),
)
check('finally 中兜底清空全局 busy', /finally\s*\{[\s\S]*if \(state\.busy\) patch\(\{ busy: '' \}\)/.test(performBlock))
check('成功路径先关闭弹窗', /patch\(\{ dialog: null \}\)/.test(performBlock))
check('删除成功后做乐观更新', /const doneSet = new Set\(doneIds\.map\(String\)\)/.test(performBlock))
check('乐观更新同时清理选择', /selection: new Set\(Array\.from\(state\.selection\)\.filter/.test(performBlock))
check('操作后的刷新带 force', /await load\(\{ silent: true, force: true \}\)/.test(performBlock))

console.log('== postAction：超时可控 ==')
check('postAction 有超时计时器', /setTimeout\(\(\) => \{/.test(postBlock))
check('postAction 区分超时', /timedOut/.test(postBlock) && /error: 'timeout'/.test(postBlock))
check('postAction 不向外抛错', /catch \(error\) \{[\s\S]*return \{ ok: false/.test(postBlock))

console.log('== 轮询与分页守卫 ==')
check('轮询避开操作进行中', /if \(isBusy\) return undefined/.test(pageBlock))
check('页码越界自动回退', /if \(store\.page > pageCount\) patch\(\{ page: pageCount \}\)/.test(pageBlock))

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1
