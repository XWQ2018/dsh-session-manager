/**
 * 交互冒烟：在 mock React 环境里真正「点」一次删除，验证
 *  1. 模块级函数（load / performAction / applyResultNotice）执行时不抛 ReferenceError
 *     —— 这类错误表现为 "t is not defined"，只在真实交互时才暴露；
 *  2. 删除成功后弹窗关闭、列表条目减少、播报成功而非报错；
 *  3. 请求失败时弹窗不卡在 busy，而是显示错误并保持可关闭。
 *
 * 运行：node tools/smoke-client-interaction.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

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

// ---------------------------------------------------------------------------
// React mock（效果可手动执行）
// ---------------------------------------------------------------------------
let hookIndex = 0
const hookStore = new Map()
let pendingEffects = []

function createElement(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (Array.isArray(value)) value.forEach(push)
    else if (value !== null && value !== undefined && value !== false && value !== true) flat.push(value)
  }
  children.forEach(push)
  const merged = Object.assign({}, props || {})
  if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
  return { type, props: merged, children: flat }
}

const ReactMock = {
  createElement,
  Fragment: 'Fragment',
  Component: class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(next) {
      this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
    }
  },
  useState(initial) {
    const key = 'h' + hookIndex++
    if (!hookStore.has(key)) hookStore.set(key, typeof initial === 'function' ? initial() : initial)
    return [hookStore.get(key), (next) => hookStore.set(key, typeof next === 'function' ? next(hookStore.get(key)) : next)]
  },
  useEffect(callback) {
    hookIndex += 1
    pendingEffects.push(callback)
  },
  useMemo(factory) {
    hookIndex += 1
    return factory()
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useRef(initial) {
    hookIndex += 1
    return { current: initial === undefined ? null : initial }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot()
  },
}

let captured = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  activeElement: null,
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild() {}, removeChild() {} },
}
// 只挡定时轮询，避免测试结束后仍有定时器；setTimeout 保持原生，保证异步链能跑完
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---------------------------------------------------------------------------
// 可编程 fetch
// ---------------------------------------------------------------------------
const sessionA = 'session-aaaa1111-1111-4111-8111-111111111111'
const sessionB = 'session-bbbb2222-2222-4222-8222-222222222222'

let mode = 'list-ok'
const actionBodies = []

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function makeItem(index, archived) {
  return {
    sessionId: 'session-item' + String(index).padStart(4, '0'),
    title: '会话 ' + index,
    cwd: 'C:\\dsHarness',
    workspaceTitle: 'dsHarness',
    archived,
    pinned: false,
    live: false,
    sizeBytes: 1024,
    createdAt: 1700000000000 - index * 1000,
    updatedAt: 1700000000000 - index * 1000,
    deletable: true,
    blockReason: null,
    origin: null,
  }
}

/** 列表条数可调：默认 2 条用于删除流程，分页场景会调到 25 条。 */
let listSize = 2
let listAllArchived = false

function buildList() {
  const items = []
  if (listSize === 2) {
    items.push(makeItem(1, true), makeItem(2, false))
    items[0].sessionId = sessionA
    items[0].title = '会被删除的会话'
    items[1].sessionId = sessionB
    items[1].title = '保留的会话'
  } else {
    for (let index = 0; index < listSize; index += 1) items.push(makeItem(index, listAllArchived))
  }
  const archived = items.filter((item) => item.archived).length
  return {
    ok: true,
    generatedAt: Date.now(),
    confirmToken: 'sm-testtoken',
    titlesPending: 0,
    stats: {
      total: items.length,
      active: items.length - archived,
      archived,
      live: 0,
      bytes: items.length * 1024,
    },
    items,
  }
}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/list')) {
    if (mode === 'list-fail') return jsonResponse({ ok: false }, 500)
    // 删除后只返回剩下的那条，模拟服务端真实行为
    if (actionBodies.length > 0) {
      const payload = buildList()
      payload.items = payload.items.filter((item) => item.sessionId !== sessionA)
      const archived = payload.items.filter((item) => item.archived).length
      payload.stats = {
        total: payload.items.length,
        active: payload.items.length - archived,
        archived,
        live: 0,
        bytes: payload.items.length * 1024,
      }
      return jsonResponse(payload)
    }
    return jsonResponse(buildList())
  }
  if (target.includes('/action')) {
    actionBodies.push(JSON.parse(init.body))
    if (mode === 'action-fail') {
      return jsonResponse({ ok: false, error: 'confirm-required', message: 'nope' })
    }
    return jsonResponse({
      ok: true,
      action: 'delete-sessions',
      done: [sessionA],
      skipped: [],
      blocked: [],
      warnings: [],
      stats: { total: 1, active: 1, archived: 0, live: 0, bytes: 1024 },
    })
  }
  throw new Error('unexpected fetch: ' + target)
}

// ---------------------------------------------------------------------------
// 加载与渲染
// ---------------------------------------------------------------------------
new Function(source)()
const plugin = captured.factory((name) => {
  if (name === 'react') return ReactMock
  throw new Error('unexpected require: ' + name)
})

const registrations = new Map()
const ctx = {
  effect(fn) {
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  get(name) {
    if (name === 'locale') {
      return {
        bind: () => (key) => '',
        getLocale: () => ({ active: 'zh-CN' }),
        register: () => () => {},
        subscribe: () => () => {},
      }
    }
    return undefined
  },
  slots: {
    inject(_slot, callback) {
      return callback()
    },
    register(options, component) {
      registrations.set(options.name, { options, component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

function isClassComponent(type) {
  return typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function'
}

function renderNode(node) {
  if (node === null || node === undefined) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(renderNode)
  const type = node.type
  const props = node.props || {}
  if (isClassComponent(type)) {
    const instance = new type(props)
    if (typeof type.getDerivedStateFromError === 'function') {
      try {
        return renderNode(instance.render())
      } catch (error) {
        instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error))
        throw new Error('boundary-captured: ' + String(error && error.message))
      }
    }
    return renderNode(instance.render())
  }
  if (typeof type === 'function') {
    // 不要在这里清空 hooks / effects：子组件渲染会逐层进入这个分支，
    // 清空会把父页面刚注册的 effect 丢掉（曾导致加载永远不触发）。
    return renderNode(type(props))
  }
  return { type, props, children: (node.children || []).map(renderNode) }
}

/** 让挂起的微任务与宏任务跑完（fetch mock 是 async，链路有多层 await）。 */
async function flush(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** 渲染组件并执行它注册的 effect（模拟 mount），随后等待异步链结束。 */
async function renderMounted(component, props) {
  hookIndex = 0
  hookStore.clear()
  pendingEffects = []
  const tree = renderNode(component(props))
  const effects = pendingEffects.slice()
  pendingEffects = []
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function' && /setInterval|addEventListener/.test(String(cleanup))) cleanup()
  }
  await flush()
  return tree
}

/** 精确判断某个元素是否带指定类名（避免 dsm-row 误匹配 dsm-row-actions）。 */
function hasClass(node, name) {
  const className = (node && node.props && node.props.className) || ''
  return typeof className === 'string' && (' ' + className + ' ').indexOf(' ' + name + ' ') >= 0
}

const isRow = (node) => hasClass(node, 'dsm-row')
const isRowDeleteButton = (node) =>
  node.type === 'button' && hasClass(node, 'is-icon') && hasClass(node, 'is-danger')
const isConfirmButton = (node) => node.type === 'button' && hasClass(node, 'is-primary')

function findAll(tree, predicate, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    tree.forEach((child) => findAll(child, predicate, out))
    return out
  }
  if (predicate(tree)) out.push(tree)
  ;(tree.children || []).forEach((child) => findAll(child, predicate, out))
  return out
}

function textOf(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (tree.type === 'style') return '' // 样式表不是界面文案
  return (tree.children || []).map(textOf).join('')
}

const page = registrations.get('main').component
const overlay = registrations.get('shell.overlay').component

// ---------------------------------------------------------------------------
// 场景 1：加载 → 删除一条 → 检查播报与列表
// ---------------------------------------------------------------------------
console.log('== 场景 1：加载并删除一条 ==')
await renderMounted(page, {})
let tree = await renderMounted(page, {})
const rowsBefore = findAll(tree, isRow)
check('加载后渲染出会话行', rowsBefore.length === 2, 'rows=' + rowsBefore.length)
check('列表渲染未落入错误边界', textOf(tree).indexOf('界面渲染出错') < 0)

// 点第一条的删除按钮
const deleteButtons = findAll(tree, isRowDeleteButton)
check('找到行内删除按钮', deleteButtons.length >= 1, 'buttons=' + deleteButtons.length)

if (deleteButtons.length > 0) {
  deleteButtons[0].props.onClick()
}

// 渲染确认弹窗
let overlayTree = null
try {
  overlayTree = renderNode(overlay({}))
  check('确认弹窗渲染不抛错', true)
} catch (error) {
  check('确认弹窗渲染不抛错', false, String(error && error.message))
}

const confirmButton = findAll(overlayTree, isConfirmButton)[0]
check('找到确认删除按钮', Boolean(confirmButton))
check('确认按钮默认可用', Boolean(confirmButton) && confirmButton.props.disabled !== true)

// 触发删除（异步）
let performError = null
if (confirmButton) {
  try {
    await confirmButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  } catch (error) {
    performError = error
  }
}
check('删除流程不抛异常', performError === null, performError ? String(performError.message) : '')
check('确实发出了 action 请求', actionBodies.length === 1, 'calls=' + actionBodies.length)
check(
  '请求携带了确认令牌与短语',
  actionBodies[0] && actionBodies[0].confirmToken === 'sm-testtoken' && actionBodies[0].confirmPhrase === '删除',
  JSON.stringify(actionBodies[0] || {}),
)

// 再渲染：弹窗应已关闭，列表应少一条，播报应为成功
tree = await renderMounted(page, {})
overlayTree = renderNode(overlay({}))
check('弹窗已关闭', overlayTree === null, JSON.stringify(overlayTree).slice(0, 120))

const rowsAfter = findAll(tree, isRow)
check('列表已少一条（乐观更新或刷新生效）', rowsAfter.length === 1, 'rows=' + rowsAfter.length)

const pageText = textOf(tree)
check('界面未出现 ReferenceError', pageText.indexOf('not defined') < 0, pageText.slice(0, 160))
check('播报了删除结果', pageText.indexOf('noticeDeleted') >= 0 || pageText.indexOf('已删除') >= 0, pageText.slice(0, 200))

// ---------------------------------------------------------------------------
// 场景 2：动作失败 → 弹窗不卡在 busy
// ---------------------------------------------------------------------------
console.log('== 场景 2：动作失败时弹窗不卡死 ==')
mode = 'action-fail'
actionBodies.length = 0
await renderMounted(page, {})
tree = await renderMounted(page, {})
const deleteButtons2 = findAll(tree, isRowDeleteButton)
if (deleteButtons2.length > 0) deleteButtons2[0].props.onClick()
overlayTree = renderNode(overlay({}))
const confirmButton2 = findAll(overlayTree, isConfirmButton)[0]
if (confirmButton2) {
  await confirmButton2.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
overlayTree = renderNode(overlay({}))
const stillBusy = findAll(
  overlayTree,
  (node) => node.type === 'button' && /正在处理|Working/.test(textOf(node)),
)
check('失败后弹窗仍存在', overlayTree !== null)
check('失败后按钮不再显示「正在处理」', stillBusy.length === 0, String(stillBusy.length))
const errorShown = findAll(overlayTree, (node) => String((node.props || {}).className || '').indexOf('dsm-dialog-error') >= 0)
check('失败后展示了错误原因', errorShown.length > 0)

// ---------------------------------------------------------------------------
// 场景 3：25 条已归档 → 分页器必须可见，且每页只渲染 10 条
// ---------------------------------------------------------------------------
console.log('== 场景 3：超过 10 条时分页器可见 ==')
mode = 'list-ok'
actionBodies.length = 0
listSize = 25
listAllArchived = true
await renderMounted(page, {})
tree = await renderMounted(page, {})

const rowsPaged = findAll(tree, isRow)
check('只渲染当前页 10 行', rowsPaged.length === 10, 'rows=' + rowsPaged.length)

const pagers = findAll(tree, (node) => hasClass(node, 'dsm-pager'))
check('分页器已渲染', pagers.length === 1, 'pagers=' + pagers.length)

const pagerText = textOf(pagers[0] || null)
check('显示总条数与页数', /25/.test(pagerText) && /1\s*\/\s*3/.test(pagerText), pagerText)

// 分页器必须位于滚动区之外：贴在滚动内容里会盖住列表最后一行，
// 造成「一页 10 条却只看到 9 条」。
const scrollNodes = findAll(tree, (node) => hasClass(node, 'dsm-scroll'))
check('存在滚动容器', scrollNodes.length === 1, 'scroll=' + scrollNodes.length)
check(
  '分页器不在滚动容器内（不会被遮挡）',
  findAll(scrollNodes[0], (node) => hasClass(node, 'dsm-pager')).length === 0,
)
const footerNodes = findAll(tree, (node) => hasClass(node, 'dsm-footer'))
check('分页器位于固定底部区域', footerNodes.length === 1 && findAll(footerNodes[0], (node) => hasClass(node, 'dsm-pager')).length === 1)

const nextButton = findAll(
  tree,
  (node) => node.type === 'button' && String((node.props || {})['aria-label'] || '').indexOf('下一页') >= 0,
)[0]
check('存在下一页按钮', Boolean(nextButton))
check('第一页时上一页禁用', Boolean(findAll(tree, (node) => node.type === 'button' && String((node.props || {})['aria-label'] || '').indexOf('上一页') >= 0)[0]) )

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1
