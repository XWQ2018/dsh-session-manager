# 会话管理插件 接口契约（冻结版 v1）

本文件由 Lead 维护，是各模块之间的**唯一接口约定**。所有实现方按本契约编码，不得擅自更改签名与字段名。
若发现契约不可行，先报告 Lead，由 Lead 更新本文档后再改代码。

---

## 0. 常量

```
插件包名        @xiaoweiq66/dsh-session-manager
包目录          C:\dsHarness\dsh-session-manager
侧栏面板 id     dsh-session-manager        （sidebar.panellist 的 id，也是 main 的 key）
HTTP 前缀       /api/dsh-session-manager
```

---

## 1. 数据层：`lib/session-store.js`

**归属：data-plane**。纯 Node ESM 模块。

硬性约束：

- 只允许 import `node:fs`、`node:fs/promises`、`node:path`、`node:os`；**禁止** import 任何 cordis / dsh / react 包。
- 不产生任何 stdout 输出（测试通过返回值断言）。
- 所有路径通过 `resolvePaths()` 得出，默认取 `process.env.DSH_HOME`；不得写死绝对路径。
- 除 `sessionsRoot` 下的会话目录、`<home>/storages/workspace.json`、`<home>/storages/session_projcache.json` 外，不得删除或改写任何文件。
- 所有"读-改-写"必须是原子写：先写 `<file>.tmp-<pid>-<ts>`，再 `rename` 覆盖目标。写前备份为 `<file>.bak-<ts>`。
- 写后必须重新 `JSON.parse` 自校验；校验失败时用备份还原，然后抛出 `Error`。

### 1.1 `resolvePaths(env = {})`

```js
export function resolvePaths(env = {}) → {
  home: string,                  // 默认 env.DSH_HOME 或 process.env.DSH_HOME
  storageDir: string,            // <home>/storages
  workspaceJson: string,         // <home>/storages/workspace.json
  sessionProjCacheJson: string,  // <home>/storages/session_projcache.json
  sessionsRoot: string,          // <home>/sessions
}
```

### 1.2 `scanSessionDirectories(paths)`

```js
export async function scanSessionDirectories(paths) → {
  entries: Array<{
    sessionId: string,   // 目录名
    group: string,       // 上一层目录名，如 --C-dsHarness--
    dir: string,         // 会话目录绝对路径
    logPath: string|null,// 目录内 session.*.jsonl.* 文件中版本号最高者；无则 null
    logFiles: string[],  // 目录内全部常规文件（绝对路径，已排序）
    sizeBytes: number,   // logFiles 的字节总和
    mtimeMs: number,     // 目录内最新文件的 mtime（毫秒时间戳），用于"更新时间"
  }>,
  skipped: string[],     // 被跳过的目录绝对路径（不含 session.*.jsonl.* 文件）
}
```

- 遍历 `paths.sessionsRoot` 的两层结构：`<group>/<sessionId>/`。
- `sessionId` 必须是目录名本身。
- 不存在的 `sessionsRoot` 返回 `{ entries: [], skipped: [] }`，不抛错。
- 结果按 `sessionId` 升序稳定排序。

### 1.3 `readRegistry(paths)`

```js
export async function readRegistry(paths) → {
  fileExists: boolean,
  raw: object|null,
  workspaceIds: string[],
  archivedSessionIds: string[],
  pinnedSessionIds: string[],
  workspaces: Array<{ workspaceId: string, title: string|null, path: string|null, sessionIds: string[] }>,
}
```

- 来源：`<home>/storages/workspace.json`，形如
  `{ unit:{name:'workspace',version:2}, global:{initialized,workspaceIds[],archivedSessionIds[],pinnedSessionIds[]}, tables:{workspaces:{<id>:{path,title,sessionIds[]}}} }`。
- 兼容 v1：`tables.workspaces` 缺失时，尝试把 `global.workspaces` 或 `raw.workspaces` 当作该表。
- 文件缺失或解析失败：返回 `fileExists:false` / `raw:null`，其余字段为空数组，**不抛错**。

### 1.4 `readProjectionMeta(paths)`

```js
export async function readProjectionMeta(paths) → Record<sessionId, {
  title: string|null,
  createdAt: number|null,
  cwd: string|null,
}>
```

- 来源：`<home>/storages/session_projcache.json`，形如
  `{ unit:{name:'session_projcache',version:3}, tables:{sessions:{<sessionId>:{identity:{createdAt,cwd},rows:{title:{ver,seq,val:"标题"}}}}}}`。
- 标题取值路径兼容：`rows.title.val`（字符串）优先；其次 `rows.title` 本身是字符串。
- 文件缺失/解析失败/结构缺失 → 返回 `{}`，不抛错。

### 1.5 `deleteSessionDirectory(paths, entry)`

```js
export async function deleteSessionDirectory(paths, entry) → {
  dir: string,
  removed: string[],   // 实际删除的文件绝对路径；目录本身不在其中
  freedBytes: number,
}
```

- 递归删除 `entry.dir` 整棵子树（含子目录与文件），使用 `fs.rm(dir, { recursive:true, force:true })`。
- `entry.dir` 必须位于 `paths.sessionsRoot` 之下（用 `path.relative` 校验，逃逸则抛 `Error('unsafe-path')`）。
- 目录不存在时返回 `{ dir, removed: [], freedBytes: 0 }`，不抛错。
- 删除前先枚举 `entry.logFiles`（或目录内实际文件）以计算 `removed` 与 `freedBytes`。

### 1.6 `purgeWorkspaceRegistry(paths, options)`

```js
export async function purgeWorkspaceRegistry(paths, {
  sessionIds = [],
  dropArchive = true,
  dropPin = true,
} = {}) → {
  changed: boolean,
  backupPath: string|null,
  removedFromWorkspaces: number,   // 从各 workspace 的 sessionIds 中移除的条目数（含重复计数）
  removedFromArchive: number,
  removedFromPin: number,
}
```

- 读-改-写 `paths.workspaceJson`：
  1. 从 `tables.workspaces[*].sessionIds` 中移除全部 `sessionIds`；
  2. `dropArchive` 时从 `global.archivedSessionIds` 移除；
  3. `dropPin` 时从 `global.pinnedSessionIds` 移除；
  4. 不动 `global.workspaceIds` 与 `tables.workspaces` 的键集合（不删除工作区本身）。
- 无实际改动 → `changed:false` 且**不写盘**、不产生备份。
- 有改动 → 备份 → 原子写 → 自校验。

### 1.7 `purgeProjectionCache(paths, sessionIds)`

```js
export async function purgeProjectionCache(paths, sessionIds = []) → {
  changed: boolean,
  removed: number,          // 删除的缓存条目总数（目录版文件 + 单文件版键）
  backupPath: string|null,
}
```

**必须同时清理两处**：

1. **目录版**（DSH 实际使用的）：`<storageDir>/session_projcache/sessions/<sessionId>.json`，每个会话一个文件；
2. **单文件版**（旧格式）：`<storageDir>/session_projcache.json` 的 `tables.sessions`。

只清单文件版会留下目录版文件——DSH 侧边栏会继续显示已删除的会话（出现在「未分组」里），而且重启也不会消失。无改动时不写盘。

- 从 `tables.sessions` 删除这些键；无改动则不写盘。

### 1.8 `verifyGone(paths, sessionIds)`

```js
export async function verifyGone(paths, sessionIds = []) → {
  stillOnDisk: string[],
  stillInRegistry: string[],
  stillArchived: string[],
  stillInProjectionCache: string[],
}
```

- 用于删除后的独立复核，四个数组均为**仍残留**的 id；全部为空即删除彻底。

---

## 2. HTTP 契约

**实现方：Lead（`index.js` + `lib/host-api.js`）**。UI 层只按本节调用。

响应统一 `Content-Type: application/json; charset=utf-8`。所有 GET/POST 都是同源请求。

### 2.1 `GET /api/dsh-session-manager/list`

```jsonc
{
  "ok": true,
  "generatedAt": 1790000000000,
  "confirmToken": "sm-<随机十六进制>",   // 由 list 签发，TTL 5 分钟；动作执行期间不轮换，重新 list 才刷新
  "stats": { "total": 62, "active": 40, "archived": 22, "live": 1, "running": 0, "bytes": 123456789 },
  "items": [
    {
      "sessionId": "session-xxxx",
      "title": "安卓接入 RapidOCR 可行性与步骤",
      "cwd": "C:\\dsHarness",
      "workspaceId": "e022ff97-...",
      "workspaceTitle": "dsHarness",
      "archived": false,
      "pinned": false,
      "live": false,            // 会话被加载在内存里（可能早已空闲），禁止物理删除
      "running": false,         // 正在执行 turn（真正的"运行中"）
      "sizeBytes": 123456,
      "createdAt": 1787119112946,
      "updatedAt": 1790000000000,
      "deletable": true,        // 恒为 true：已加载会话也允许删除（删除前会先停止其活动）
      "blockReason": null,      // live 时为 'attached'，仅作提示，不再阻止删除
      "origin": null,           // 'subagent' 表示子会话
      "parentSession": null     // 子会话的父会话 id
    }
  ],
  "titlesPending": 0            // 仍在后台解析标题的会话数；> 0 时界面应稍后自动重拉
}
```

- `active` = 未归档数量；`archived` = 归档数量；`total` = 两者之和。
- `items` 按 `archived` 升序、`updatedAt` 降序排列。

### 2.2 `POST /api/dsh-session-manager/action`

请求体：

```jsonc
{
  "action": "archive" | "unarchive" | "delete-sessions" | "delete-archived" | "delete-all",
  "ids": ["session-xxxx"],          // delete-all / delete-archived 可省略
  "confirmToken": "sm-...",         // 删除类动作必填，且须等于最近一次 list 下发的令牌
  "confirmPhrase": "删除"           // 删除类动作必填，三个动作各自的短语见下表
}
```

成功响应：

```jsonc
{
  "ok": true,
  "action": "delete-sessions",
  "done": ["session-xxxx"],
  "skipped": [{ "sessionId": "session-yyyy", "reason": "not-archived" }],
  "blocked": [{ "sessionId": "session-zzzz", "reason": "live" }],
  "warnings": ["projection-cache-purge-failed: ..."],
  "stats": { "total": 61, "active": 39, "archived": 22, "live": 1, "bytes": 123456000 }
}
```

失败响应（HTTP 200，`ok:false`）：

```jsonc
{ "ok": false, "error": "confirm-required", "message": "删除操作需要先获取确认令牌" }
```

错误码表：

| error | 含义 |
| --- | --- |
| `bad-action` | action 不在枚举内 |
| `bad-request` | 请求体不是合法 JSON 或字段类型错误 |
| `confirm-required` | 缺少或过期/不匹配的 confirmToken |
| `confirm-phrase-mismatch` | confirmPhrase 与要求不一致 |

各删除动作要求的确认短语：

| action | confirmPhrase |
| --- | --- |
| `delete-sessions` | `删除` |
| `delete-archived` | `清空归档` |
| `delete-all` | `全部删除` |
| `registry-unavailable` | 归档服务不可用 |
| `no-target` | 解析后没有任何目标 id |

### 2.3 复核端点 `POST /api/dsh-session-manager/verify`

请求 `{ "ids": ["session-xxxx"] }`，响应 `{ ok:true, gone:true|false, detail:{...} }`。
`detail` 即 `verifyGone()` 的返回值。

---

## 3. UI 契约

**归属：ui-plane**（`client.js`，单个文件，CommonJS-free 的浏览器模块）。

- 结构：`window.__ModuleLoader__.load({ id:'@xiaoweiq66/dsh-session-manager', factory(require){ ... } })`。
- React 通过 `require('react')` 获取，禁止 `require` 任何 dsh-client-* 包。
- 插件对象：`{ inject:['slots','locale'], apply(ctx){ ... } }`；所有注册用 `ctx.effect` 或经 `ctx.slots.inject` 包裹。
- `sidebar.panellist`：`{ name:'sidebar.panellist', id:'dsh-session-manager', order:50, label:()=>t('open') }`。
- `main`：`{ name:'main', key:'dsh-session-manager' }`，渲染完整面板页。
- 数据：`fetch('/api/dsh-session-manager/list', { credentials:'same-origin' })`；操作：`POST /api/dsh-session-manager/action`。
- 视觉：仅使用 `--dsw-alias-*` 主题 token 与 `color-mix()`；禁止硬编码 hex 颜色（插画/图标除外）。
- 无障碍：弹窗 `role="dialog" aria-modal="true"`，打开时聚焦主按钮，Esc 关闭，关闭后焦点还原；所有按钮 `:focus-visible` 可见。
- 危险操作一律二次确认弹窗；用户**只需点击确认按钮**（不要求手输短语），由客户端自动携带 `confirmToken` 与对应 `confirmPhrase`。服务端仍按 2.2 校验。

### 2.4 标题与工作目录的来源

`title` 与 `cwd` 按以下优先级取值（前者缺失才回退）：

1. **日志解析缓存**：`<home>/dsh-session-manager/title-cache.json`。会话日志是多帧 zstd，按帧头切分逐帧解压，读到 `session/title` 即停止；缓存按 `mtime + size` 失效。
2. **投影缓存**：`session_projcache.json` 的 `rows.title.val` / `identity.cwd`。
3. **工作区目录名反查**：`sessions/<group>/` 的 group 名是工作区路径的编码形式，用 `encodeGroupName()` 正向匹配 `workspace.json` 里的 path。
4. **工作区注册表**：`tables.workspaces[*].path`。

首次请求只读缓存并立即返回（实测 147 个会话约 150ms），未命中的会话排队后台解析（实测约 2–5 秒完成），期间 `titlesPending > 0`，界面据此自动重拉。

---

## 4. 客户端异步不变量（回归防线）

以下三条由 `tools/audit-async-paths.mjs` 静态强制，改动不得破坏：

1. **操作后的列表刷新必须 `force`**：`load()` 在 `inflight` 存在时默认复用该请求，但删除等操作之后必须传 `{ force: true }`——否则会拿到"操作之前"发出的旧响应，表现为「删完了列表没变」。
2. **`performAction` 必须 try/catch/finally 全包**：`finally` 中无条件解除 `dialog.busy` 与全局 `busy`。任何异常都不得让弹窗永久停在「正在处理中」。
3. **删除成功先做乐观更新**：立即把 `result.done` 中的 id 从本地 `items` 与 `selection` 移除并重算统计，再发起强制刷新。这样即使刷新失败，用户也能看到删除已生效。

另外：`postAction` 自带 20 秒超时，超时返回 `error: 'timeout'` 并提示「删除可能已执行，请刷新确认」；轮询补标题时若正在执行操作会跳过，避免与强制刷新抢数据。
4. **文案函数 `t` 必须在模块作用域声明**：`load` / `postAction` / `describeFailure` / `noticeTitleFor` / `applyResultNotice` / `performAction` / `reasonLabel` / `titleOf` 都是模块级函数，却在调用 `t()`。若 `t` 只在 `apply()` 内部声明，这些函数一执行就抛 `ReferenceError: t is not defined`（表现为删除成功后弹出一条莫名报错）。`apply()` 里必须是**赋值** `t = function (...)`，不能再次 `function t(...)` 声明（否则遮蔽模块级变量）。
5. **删除会话必须先走 DSH 服务解除关联，再删文件**：`workspaceRegistry` 是内存索引，只改 `workspace.json` 文件它感知不到，DSH 官方侧边栏（订阅 `workspaceController.follow` 快照）会继续显示已删除的会话，直到重启。删除流程必须对每个目标调用 `Workspace.detachSession()`、`registry.unarchiveSession()`、`registry.unpinSession()`，让服务更新内存索引、持久化并推送新快照；随后再做文件级清理作为兜底（此时通常已无改动，不会重复写盘）。
### 2.5 `live` 与 `running` 的区别

| 字段 | 含义 | 来源 | 影响 |
| --- | --- | --- | --- |
| `live` | 会话被加载在内存中（`sessions.list()` 里有它），持有写句柄 | Host 内存会话表 | 禁止物理删除；对话可能早已结束，重启 DSH 后释放 |
| `running` | 正在执行一个 turn（模型/工具在跑） | `sessionController.list()` 的 `running` | 仅用于展示与提示，不单独阻止删除 |

界面必须区分这两个状态：只有 `running` 才显示「运行中」，仅 `live` 显示「已加载」。早期版本把 `live` 一律标成「运行中」，导致用户看到"对话已完成却显示运行中"的困惑。
### 2.6 已加载（live）会话的处理策略

早期版本把 `live` 当作"禁止删除"，实际体验很差：新建会话必然处于 live，只要不重启 DSH 就永远删不掉。

实测（`tools/probe-file-lock.mjs`）DSH 并不长期独占会话日志句柄，重命名/删除均可行。因此当前策略：

- **归档**：允许。归档是纯元数据操作，对 live 会话传 `stopActivity: true` 先停掉其活动。
- **删除**：允许。删除前若会话 `running` 或 `live`，先调用 `archiveSession(id, { stopActivity: true })` 停止其工作，再移除目录与注册表引用。
- **提示**：`blockReason: 'attached'` 只用于界面提示，不再是删除障碍。若用户删除的正是当前正在查看的会话，该对话随后无法继续——弹窗文案必须写明这一点。
### 2.7 取消归档必须重建工作区关联

DSH 官方侧边栏按 `workspace.sessionIds` 渲染，**subagent 子会话从不出现**（它们只存在于磁盘与插件列表里）。

`unarchiveSession()` 只从归档集合移除标记，不会重建工作区关联。因此 `unarchive` 动作在调用它之后还必须：

1. 检查该会话是否已在某个 `workspace.sessionIds` 中；
2. 若不在，用 `header.cwd` 与 `workspace.path`（忽略大小写）匹配目标工作区；
3. 调用 `Workspace.attachSession(sessionId)` 挂回去，侧边栏才会恢复显示。

另外，`delete-archived` 需要把「归档集合里存在、但磁盘上已不存在」的幽灵 id 一并清理，否则它们会永远显示为已归档。

界面默认隐藏 `origin === 'subagent'` 的会话，使列表与官方侧边栏口径一致；需要清理子会话时用「显示子会话」开关展开。