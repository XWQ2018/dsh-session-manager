/**
 * 专项测试：purgeProjectionCache 必须同时清理
 *   1) 目录版缓存 <storageDir>/session_projcache/sessions/<id>.json（DSH 实际使用的）
 *   2) 单文件版 session_projcache.json 里的键
 *
 * 漏掉目录版的后果：DSH 侧边栏继续显示已删除的会话（「未分组」里的幽灵条目），重启也不消失。
 *
 * 运行：node tools/test-cache-purge.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/session-store.js'

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

const exists = async (file) => {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

const home = await mkdtemp(path.join(tmpdir(), 'dshsm-cachepurge-'))
const paths = store.resolvePaths({ DSH_HOME: home })
const cacheDir = path.join(paths.storageDir, 'session_projcache', 'sessions')
await mkdir(cacheDir, { recursive: true })

const TARGET = 'session-aaaa1111-1111-4111-8111-111111111111'
const KEEP = 'session-bbbb2222-2222-4222-8222-222222222222'

// 目录版缓存：两个会话各一个文件
await writeFile(path.join(cacheDir, TARGET + '.json'), JSON.stringify({ id: TARGET }))
await writeFile(path.join(cacheDir, KEEP + '.json'), JSON.stringify({ id: KEEP }))

// 单文件版缓存：也放两个键
await writeFile(
  paths.sessionProjCacheJson,
  JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: { sessions: { [TARGET]: { identity: {} }, [KEEP]: { identity: {} } } },
  }),
)

console.log('== 清理前 ==')
check('目录版目标存在', await exists(path.join(cacheDir, TARGET + '.json')))
check('目录版保留项存在', await exists(path.join(cacheDir, KEEP + '.json')))

console.log('== 执行清理 ==')
const result = await store.purgeProjectionCache(paths, [TARGET])
check('报告 changed=true', result.changed === true, JSON.stringify(result))
check('移除计数 >= 1', result.removed >= 1, String(result.removed))

console.log('== 清理后 ==')
check('目录版目标已删除', !(await exists(path.join(cacheDir, TARGET + '.json'))))
check('目录版保留项仍在', await exists(path.join(cacheDir, KEEP + '.json')))

const single = JSON.parse(await readFile(paths.sessionProjCacheJson, 'utf8'))
check('单文件版目标键已删除', !(TARGET in single.tables.sessions))
check('单文件版保留项仍在', KEEP in single.tables.sessions)

console.log('== 幂等与空入参 ==')
const again = await store.purgeProjectionCache(paths, [TARGET])
check('重复清理无改动', again.changed === false, JSON.stringify(again))
const empty = await store.purgeProjectionCache(paths, [])
check('空入参无改动', empty.changed === false)

console.log('== 缓存目录不存在时不报错 ==')
const home2 = await mkdtemp(path.join(tmpdir(), 'dshsm-cachepurge2-'))
const paths2 = store.resolvePaths({ DSH_HOME: home2 })
let threw = null
try {
  await store.purgeProjectionCache(paths2, [TARGET])
} catch (error) {
  threw = error
}
check('无缓存目录时不抛错', threw === null, threw ? String(threw.message) : '')

await rm(home, { recursive: true, force: true })
await rm(home2, { recursive: true, force: true })

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1
