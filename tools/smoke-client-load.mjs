/**
 * 客户端加载冒烟：在没有浏览器的前提下，用最小 React mock 验证
 *  1. bundle 能被 __ModuleLoader__ 接收且 factory 不抛异常；
 *  2. apply(ctx) 能完成 sidebar.panellist / main / shell.overlay 三个注册；
 *  3. 三个注册组件都能被"渲染"成虚拟树而不抛错（捕获未定义引用、错误 props 访问）。
 *
 * 它不能替代真实浏览器渲染，但能挡住"插槽整块变空"这类崩溃。
 *
 * 运行：node tools/smoke-client-load.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'client.js')
const source = readFileSync(target, 'utf8')

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
// 最小 React mock
// ---------------------------------------------------------------------------
let hookIndex = 0
const hookStore = new Map()

function createElement(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (Array.isArray(value)) value.forEach(push)
    else if (value !== null && value !== undefined && value !== false && value !== true) flat.push(value)
  }
  children.forEach(push)
  // React 语义：children 同时出现在 props.children 上（Boundary 依赖它透传）
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
    const set = (next) => {
      hookStore.set(key, typeof next === 'function' ? next(hookStore.get(key)) : next)
    }
    return [hookStore.get(key), set]
  },
  useEffect() {
    hookIndex += 1
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

// ---------------------------------------------------------------------------
// 加载 bundle
// ---------------------------------------------------------------------------
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
// 组件不应真的发请求
globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items: [], stats: {} }) })
globalThis.document = { documentElement: { lang: 'zh-CN' }, activeElement: null }

try {
  // eslint-disable-next-line no-new-func
  new Function(source)()
  check('bundle 被 __ModuleLoader__ 接收', Boolean(captured))
} catch (error) {
  check('bundle 被 __ModuleLoader__ 接收', false, String(error && error.message))
}

check('id 正确', captured && captured.id === '@xiaoweiq66/dsh-session-manager', captured && captured.id)

let plugin = null
try {
  plugin = captured.factory((name) => {
    if (name === 'react') return ReactMock
    throw new Error('unexpected require: ' + name)
  })
  check('factory 返回插件对象', Boolean(plugin && typeof plugin.apply === 'function'))
} catch (error) {
  check('factory 返回插件对象', false, String(error && error.message))
}

// ---------------------------------------------------------------------------
// apply(ctx)：捕获三个注册
// ---------------------------------------------------------------------------
const registrations = []
const t = (key, params) => {
  const base = '[' + key + ']'
  if (!params) return base
  return Object.keys(params).reduce((out, k) => out.split('{' + k + '}').join(String(params[k])), base)
}

const ctx = {
  effect(fn) {
    try {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    } catch (error) {
      check('ctx.effect 回调不抛错', false, String(error && error.message))
      return () => {}
    }
  },
  get(name) {
    if (name === 'locale') {
      return {
        bind: () => () => '',
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
      registrations.push({ options, component })
      return () => {}
    },
  },
}

try {
  plugin.apply(ctx)
  check('apply 完成注册', true)
} catch (error) {
  check('apply 完成注册', false, String(error && error.message))
}

const bySlot = new Map(registrations.map((item) => [item.options.name, item]))
check('注册了 sidebar.panellist', bySlot.has('sidebar.panellist'))
check('注册了 main', bySlot.has('main'))
check('注册了 shell.overlay', bySlot.has('shell.overlay'))
check('侧栏 id 正确', bySlot.has('sidebar.panellist') && bySlot.get('sidebar.panellist').options.id === 'dsh-session-manager')
check('主面板 key 正确', bySlot.has('main') && bySlot.get('main').options.key === 'dsh-session-manager')
check(
  '侧栏 label 是 thunk',
  bySlot.has('sidebar.panellist') && typeof bySlot.get('sidebar.panellist').options.label === 'function',
)

// ---------------------------------------------------------------------------
// 执行式渲染：真正调用函数组件 / 类组件，让真实错误暴露出来
// ---------------------------------------------------------------------------

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
    const isBoundary = typeof type.getDerivedStateFromError === 'function'
    if (isBoundary) {
      try {
        return renderNode(instance.render())
      } catch (error) {
        instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error))
        const fallback = renderNode(instance.render())
        throw new Error('boundary-captured: ' + String(error && error.message))
      }
    }
    return renderNode(instance.render())
  }

  if (typeof type === 'function') {
    hookIndex = 0
    hookStore.clear()
    return renderNode(type(props))
  }

  // 宿主元素
  return {
    type,
    props,
    children: (node.children || []).map(renderNode),
  }
}

function collectClasses(tree, out) {
  if (!tree) return out
  if (typeof tree === 'string' || typeof tree === 'number') return out
  if (Array.isArray(tree)) {
    tree.forEach((child) => collectClasses(child, out))
    return out
  }
  const className = tree.props && tree.props.className
  if (typeof className === 'string') out.push(className)
  ;(tree.children || []).forEach((child) => collectClasses(child, out))
  return out
}

function countHostNodes(tree) {
  if (!tree) return 0
  if (typeof tree === 'string' || typeof tree === 'number') return 1
  if (Array.isArray(tree)) return tree.reduce((sum, child) => sum + countHostNodes(child), 0)
  const children = (tree.children || []).reduce((sum, child) => sum + countHostNodes(child), 0)
  return 1 + children
}

for (const [slot, entry] of bySlot) {
  const Component = entry.component
  let tree = null
  try {
    tree = renderNode(Component({ size: 18 }))
    check(slot + ' 渲染不抛错', true)
  } catch (error) {
    check(slot + ' 渲染不抛错', false, String((error && error.stack) || error).split('\n').slice(0, 4).join(' | '))
    continue
  }

  const classes = collectClasses(tree, [])
  const hostNodes = countHostNodes(tree)
  // overlay 在无对话框时本就应渲染为空，只对常驻面板断言有节点
  if (slot !== 'shell.overlay') {
    check(slot + ' 产出可见节点', hostNodes > 0, 'host nodes=' + hostNodes)
  }

  if (slot === 'main') {
    check('主面板根节点为 dsm-root', classes.some((name) => name.indexOf('dsm-root') === 0), classes.slice(0, 6).join('|'))
    check('主面板渲染了 hero', classes.some((name) => name.indexOf('dsm-hero') === 0))
    check('主面板渲染了 4 张统计卡', classes.filter((name) => name === 'dsm-stat' || name.indexOf('dsm-stat ') === 0).length >= 4)
    check('主面板渲染了工具条', classes.some((name) => name.indexOf('dsm-toolbar') === 0))
    check('主面板渲染了搜索框容器', classes.some((name) => name.indexOf('dsm-search') === 0))
    check('主面板渲染了分段控件', classes.some((name) => name.indexOf('dsm-seg') === 0))
    check('主面板未落入错误边界', !classes.some((name) => name.indexOf('dshsm-fallback') === 0), classes.slice(0, 6).join('|'))
    check('未出现旧样式类名', !classes.some((name) => name.indexOf('dshsm-page') === 0))

    // 回归防线：曾经漏掉 <style> 渲染，导致整块布局退化、弹窗跑到左上角
    const styleNodes = []
    const collectStyles = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(collectStyles)
        return
      }
      if (node.type === 'style') styleNodes.push(node)
      ;(node.children || []).forEach(collectStyles)
    }
    collectStyles(tree)
    const cssText = styleNodes.map((node) => (node.children || []).join('')).join('')
    check('主面板渲染了 <style> 注入', styleNodes.length > 0, 'style nodes=' + styleNodes.length)
    check(
      '样式含关键布局规则',
      ['.dsm-root{', '.dsm-backdrop{position:fixed', '.dsm-row{position:relative', '.dsm-stats{display:grid'].every(
        (rule) => cssText.indexOf(rule) >= 0,
      ),
      'css bytes=' + cssText.length,
    )
    check('样式未使用下划线/中文类名', !/[._]dshsm-/.test(cssText.slice(0, 200)))
  }

  if (slot === 'shell.overlay') {
    check('无对话框时 overlay 渲染为空', tree === null, JSON.stringify(tree).slice(0, 120))
  }
}

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exitCode = 1