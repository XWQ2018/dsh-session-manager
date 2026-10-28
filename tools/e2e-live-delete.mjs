/**
 * 真实环境端到端验证：造一个一次性测试会话 → 列表可见 → 经 HTTP API 物理删除 → 复核彻底消失。
 *
 * 安全边界：
 *  - 只创建/删除本脚本自己造的测试会话目录（目录名带 sm-e2e- 前缀）；
 *  - 绝不触碰任何既有会话目录；
 *  - 结束前无论成败都尝试清理自己造出来的残留。
 *
 * 运行：node tools/e2e-live-delete.mjs
 */
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const ORIGIN = process.env.DSH_WEB_URL || 'http://127.0.0.1:59665'
const API = ORIGIN + '/api/dsh-session-manager'
const GROUP = '--C-dsHarness--'

const testId = 'session-sm-e2e-' + Date.now().toString(36)
const sessionDir = path.join(HOME, 'sessions', GROUP, testId)

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

async function list() {
  const res = await fetch(API + '/list')
  if (!res.ok) throw new Error('list HTTP ' + res.status)
  return res.json()
}

async function action(body) {
  const res = await fetch(API + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

console.log('== 0. 环境')
console.log('  DSH_HOME =', HOME)
console.log('  API      =', API)
console.log('  测试会话 =', testId)

const before = await list()
if (!before.ok) {
  console.log('list 不可用：', JSON.stringify(before).slice(0, 200))
  process.exit(1)
}
console.log('  删除前统计: total=' + before.stats.total + ' archived=' + before.stats.archived)

try {
  console.log('== 1. 造一次性测试会话（仅本脚本所有）')
  await mkdir(sessionDir, { recursive: true })
  const header = {
    type: 'session',
    version: 4,
    id: testId,
    createdAt: Date.now(),
    cwd: 'C:\\dsHarness',
    isSeeded: false,
  }
  const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd')
  // 注意：本插件按目录与文件名识别会话，不解析日志内容；写入最小 header 仅为形态真实。
  await writeFile(logPath, zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')))
  check('测试会话目录已创建', existsSync(sessionDir))
  check('日志文件已创建', existsSync(logPath))

  console.log('== 2. 列表应能看到它（未归档、可删）')
  const mid = await list()
  const item = mid.items.find((i) => i.sessionId === testId)
  check('列表收录测试会话', Boolean(item))
  check('标记为未归档', item && item.archived === false)
  check('标记为可删', item && item.deletable === true)
  check('含确认令牌', typeof mid.confirmToken === 'string' && mid.confirmToken.startsWith('sm-'))
  console.log('  录入后统计: total=' + mid.stats.total)

  console.log('== 3. 缺少短语时必须被拒（二次确认硬校验）')
  const noPhrase = await action({ action: 'delete-sessions', ids: [testId], confirmToken: mid.confirmToken })
  check('缺短语被拒', noPhrase.ok === false && noPhrase.error === 'confirm-phrase-mismatch', JSON.stringify(noPhrase).slice(0, 160))
  check('拒绝后目录仍在', existsSync(sessionDir))

  console.log('== 4. 错误短语也必须被拒')
  const wrongPhrase = await action({
    action: 'delete-sessions',
    ids: [testId],
    confirmToken: mid.confirmToken,
    confirmPhrase: '全部删除',
  })
  check('错短语被拒', wrongPhrase.ok === false && wrongPhrase.error === 'confirm-phrase-mismatch')
  check('拒绝后目录仍在', existsSync(sessionDir))

  console.log('== 5. 令牌缺失必须被拒')
  const noToken = await action({ action: 'delete-sessions', ids: [testId], confirmPhrase: '删除' })
  check('缺令牌被拒', noToken.ok === false && noToken.error === 'confirm-required')

  console.log('== 6. 正确令牌 + 正确短语 → 物理删除')
  const del = await action({
    action: 'delete-sessions',
    ids: [testId],
    confirmToken: mid.confirmToken,
    confirmPhrase: '删除',
  })
  check('删除成功', del.ok === true && Array.isArray(del.done) && del.done.includes(testId), JSON.stringify(del).slice(0, 220))
  check('磁盘目录已消失', !existsSync(sessionDir))
  let stillListed = false
  try {
    const after = await list()
    stillListed = after.items.some((i) => i.sessionId === testId)
    console.log('  删除后统计: total=' + after.stats.total)
  } catch (error) {
    console.log('  删除后列表读取失败:', String(error.message))
  }
  check('列表中不再出现', stillListed === false)

  console.log('== 7. verify 端点独立复核')
  const verified = await action({ action: '__noop__' }).catch(() => null)
  const res = await fetch(API + '/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [testId] }),
  })
  const verifyBody = await res.json()
  check('verify 报告已彻底消失', verifyBody.ok === true && verifyBody.gone === true, JSON.stringify(verifyBody).slice(0, 220))
  void verified
} finally {
  console.log('== 8. 清理（幂等）')
  if (existsSync(sessionDir)) {
    await rm(sessionDir, { recursive: true, force: true })
    console.log('  已清理残留测试目录')
  } else {
    console.log('  无残留')
  }
  const groupDir = path.join(HOME, 'sessions', GROUP)
  const leftovers = (await readdir(groupDir)).filter((name) => name.startsWith('session-sm-e2e-'))
  check('分组目录下无测试残留', leftovers.length === 0, leftovers.join(','))
}

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1
