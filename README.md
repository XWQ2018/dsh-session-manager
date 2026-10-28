# 会话管理 · DSH 插件

> 给 DeepSeek Harness 的左侧栏加一个真正能用的会话管理器：搜索、筛选、归档，以及带二次确认的**物理删除**。

![版本](https://img.shields.io/badge/version-1.0.0-blue)
![平台](https://img.shields.io/badge/platform-DSH%20Web-lightgrey)
![许可证](https://img.shields.io/badge/license-MIT-green)

DSH 自带会话列表只能看、不能清理。时间一长，磁盘上会堆积大量历史会话与子代理会话。本插件在侧边栏提供一个集中管理面板，把「查看 / 归档 / 删除」三件事一次做完。

> 物理删除会**不可恢复地**移除会话日志。所有删除操作都需要在弹窗中二次确认。

---

## 目录

- [特性](#特性)
- [截图](#截图)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [安全设计](#安全设计)
- [工作原理](#工作原理)
- [HTTP 接口](#http-接口)
- [常见问题](#常见问题)
- [开发](#开发)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 特性

- **全景会话列表** — 直接扫描 `$DSH_HOME/sessions/`，展示标题、工作目录、体积、更新时间与状态徽标。
- **搜索与筛选** — 按标题 / 工作目录 / 会话 ID 实时过滤，支持「全部 / 未归档 / 已归档」三段切换。
- **分页** — 每页 10 条，超出自动分页；分页器固定在面板底部，不会被列表遮挡。
- **归档 / 取消归档** — 单条或批量。取消归档时若会话的工作区关联丢失，会自动按 `cwd` 重新挂回。
- **物理删除** — 单条、批量、清空全部归档、删除全部会话，四种粒度。
- **二次确认** — 弹窗列出影响条数、会话标题与预计释放体积；确认后立即执行。
- **状态还原准确** — 区分「运行中」（正在执行 turn）与「已加载」（仅在内存中），不会把空闲会话误标成运行中。
- **子会话可切换** — subagent 子会话默认隐藏（它们本来就不会出现在 DSH 侧边栏），需要清理时一键展开。
- **深色 / 浅色自适应** — 仅使用 DSH 主题 token，任何皮肤下都保持可读。

## 截图

<!-- 截图待补充：把图片放到 docs/ 目录后，取消下面两行的注释即可 -->
<!-- ![浅色主题](docs/screenshot-light.png) -->
<!-- ![深色主题](docs/screenshot-dark.png) -->

面板布局示意：

```
┌──────────────────────────────────────────────┐
│  会话管理                          [刷新]     │
│  会话总数  未归档  已归档  占用体积           │
├──────────────────────────────────────────────┤
│  [搜索]        [全部|未归档|已归档] [危险操作] │
├──────────────────────────────────────────────┤
│  ☐ 会话标题                                  │
│     C:\path\to\workspace  · 已归档 · 体积/时间 │
├──────────────────────────────────────────────┤
│  共 22 条 · 第 1 / 3 页            ‹  1/3  ›  │
└──────────────────────────────────────────────┘
```

## 环境要求

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | 0.2.x（Desktop / Web GUI） |
| 运行平台 | Windows / macOS / Linux |
| Host 服务 | 需要 `webServer` 与 `workspaceRegistry`（DSH 默认提供） |

## 安装

### 方式一：插件管理器（推荐）

在 DSH 会话中让 Agent 执行：

```text
plugin_manager install_bundle，target 指向本仓库的绝对路径
```

或在 Shell 中直接安装：

```bash
dsh plugin install /绝对路径/dsh-session-manager
```

安装成功后：

1. 左侧栏图标区（「插件管理」下方）出现「会话管理」图标；
2. 点击即可打开面板。

> **首次安装后请重启一次 DSH**。Client 半边会随页面刷新加载，但 Host 半边（HTTP 路由与数据解析）需要重启才能挂载。

### 方式二：从源码安装

```bash
git clone https://github.com/<your-name>/dsh-session-manager.git
cd dsh-session-manager
dsh plugin install "$(pwd)"
```

本插件没有构建步骤、没有运行时依赖，克隆即可用。

## 使用

### 打开面板

点击左侧栏「会话管理」图标。面板会读取磁盘上的全部会话并展示统计。

### 归档与取消归档

- 行内「归档」按钮 → 弹窗确认 → 会话移入已归档分组。
- 已归档会话的按钮变为「取消归档」→ 弹窗确认 → 回到未归档列表，并自动恢复在 DSH 侧边栏的位置。
- 已加载在内存中的会话也可以归档（会先停止其可能仍在进行的工作）。

### 删除

| 想删除的范围 | 操作 |
| --- | --- |
| 某一条 | 行内删除按钮 → 确认 |
| 勾选的若干条 | 勾选 → 底部「删除所选」→ 确认 |
| 全部已归档 | 顶部「清空全部归档 · N」→ 确认 |
| 全部会话（含未归档） | 顶部「删除全部会话 · N」→ 确认 |

> 顶部两个危险按钮是**全局操作**，不受当前筛选影响，按钮上直接标注了影响数量。

### 搜索、筛选与分页

- 搜索框支持标题、工作目录与会话 ID。
- 筛选与搜索会重置到第一页。
- 分页器左侧有「选中筛选结果全部 N 条」，配合筛选可实现「按范围删除」。

## 安全设计

删除是不可逆操作，因此做了多层防护：

1. **二次确认** — 点击确认后才会发出请求，弹窗展示影响范围与前 5 条会话标题。
2. **一次性确认令牌** — `GET /list` 签发，5 分钟内有效，动作执行期间不轮换（避免重试失败）。
3. **服务端短语校验** — 客户端自动携带对应短语，绕过界面直接调用接口也会被拒。
4. **路径逃逸防护** — 只允许删除 `sessionsRoot` 之下的目录，`..`、绝对路径与软链接逃逸一律抛 `unsafe-path`。
5. **原子写** — 改写 `workspace.json` / `session_projcache.json` 前先备份，写临时文件后 `rename` 覆盖，写完重新解析自校验，失败自动回滚。
6. **无改动不写盘** — 目标不存在时不产生任何写入与备份文件。

## 工作原理

### 架构

```
┌─────────────────────────────┐
│ Client（浏览器）             │
│  sidebar.panellist  入口图标 │
│  main               面板页   │
│  shell.overlay      确认弹窗 │
└──────────────┬──────────────┘
               │ HTTP（同源）
┌──────────────▼──────────────┐
│ Host                         │
│  index.js      路由注册      │
│  lib/host-api.js  编排/校验  │
│  lib/session-store.js 数据层 │
│  lib/title-resolver.js 解析  │
└──────────────┬──────────────┘
               │ cordis 服务
┌──────────────▼──────────────┐
│ workspaceRegistry / sessions │
│ sessionController / webServer│
└─────────────────────────────┘
```

### 删除一个会话会做什么

1. 对目标会话调用 `Workspace.detachSession()`、`unarchiveSession()`、`unpinSession()` —— 让 DSH 立即更新内存索引并推送快照，**官方侧边栏同步消失**。
2. 若会话正在执行或仍加载在内存中，先 `archiveSession({ stopActivity: true })` 停止其活动。
3. 删除磁盘目录 `$DSH_HOME/sessions/<group>/<sessionId>/`。
4. 清理 `workspace.json` 中的三处引用与两处投影缓存（目录版 + 单文件版）作为兜底。
5. 通过 `verify` 端点复核磁盘与注册表均已无残留。

> 为什么必须走服务接口：`workspaceRegistry` 是内存索引，只改文件它感知不到，否则侧边栏会一直显示已删除会话直到重启。

### 标题是怎么来的

DSH 的会话日志是**多帧 zstd**（每个事件一帧），且一个会话可能写入多条 `session/title` 事件：

```
帧#6  fallback  "1+1"                       ← 首条用户消息
帧#7  provider  "Simple arithmetic question" ← 模型生成
```

必须取**最后一条**，否则会显示成 `1+1`。解析器按帧头切分逐帧解压，找到第一条标题后继续多解 24 帧再停，兼顾正确性与速度（实测平均 23ms/会话）。结果按 `mtime + size` 缓存到 `$DSH_HOME/dsh-session-manager/title-cache.json`，首屏只读缓存并立即返回，未命中项后台解析。

## HTTP 接口

前缀：`/api/dsh-session-manager`

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/list` | GET | 会话快照 + 统计 + 确认令牌 |
| `/action` | POST | `archive` / `unarchive` / `delete-sessions` / `delete-archived` / `delete-all` |
| `/verify` | POST | 删除后复核磁盘与注册表 |

删除类动作要求 `confirmToken`，以及对应短语：

| action | confirmPhrase |
| --- | --- |
| `delete-sessions` | `删除` |
| `delete-archived` | `清空归档` |
| `delete-all` | `全部删除` |

错误码：`bad-action`、`bad-request`、`confirm-required`、`confirm-phrase-mismatch`、`registry-unavailable`、`no-target`。

## 常见问题

<details>
<summary><b>删除后 DSH 侧边栏仍显示该会话？</b></summary>

投影缓存有两份，DSH 实际读取的是**目录版**：`$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`。早期版本只清理了旧版单文件 `session_projcache.json`，导致残留。

当前版本会同时清理两处。历史残留可执行：

```bash
node tools/clean-orphan-cache.mjs          # 预演，只列出
node tools/clean-orphan-cache.mjs --apply  # 实际删除
```
</details>

<details>
<summary><b>取消归档后，DSH 侧边栏没有恢复该会话？</b></summary>

两种可能：

1. 它是 **subagent 子会话** —— 子会话从来不出现在 DSH 侧边栏，属于正常行为。面板上带「子会话」徽标。
2. 它的工作区关联丢失 —— 当前版本会在取消归档时按 `cwd` 匹配工作区并 `attachSession` 挂回去。
</details>

<details>
<summary><b>新建的会话显示「已加载」，删不掉？</b></summary>

「已加载」表示会话对象还在 DSH 进程内存里，**不是**「正在生成回复」。它没有超时回收机制，只要 DSH 不重启就会一直保持。

当前版本允许删除已加载会话（删除前先停止其活动）。只有正在执行 turn 的会话才会被标记为「运行中」。
</details>

<details>
<summary><b>标题显示成了我发的第一句话？</b></summary>

会话有多条标题记录（fallback → 模型生成 → 手动重命名），必须取最后一条。1.0.0 之前的版本为了性能"遇到第一条就停"，会显示成首条消息。已修复并升级了缓存版本，重启后自动重建。
</details>

<details>
<summary><b>一页明明 10 条，却只看到 9 条？</b></summary>

分页器曾用 `sticky` 定位浮在滚动区底部，遮挡了最后一行。现在分页器位于滚动区之外的固定底部区域，并加了结构测试防回归。
</details>

<details>
<summary><b>改了代码但界面没变化？</b></summary>

- 只改 `client.js`：刷新页面即可。
- 改了 `index.js` / `lib/*.js`（Host 半边）：**必须重启 DSH**。
</details>

## 开发

### 目录约定

- Host 半边与 Client 半边完全解耦，`lib/host-api.js` 不依赖 cordis，可在 Node 中直接驱动测试。
- 模块之间的接口在 [`lib/CONTRACT.md`](lib/CONTRACT.md) 中冻结，改动需先更新契约。

### 测试

所有测试都是纯 Node 脚本，零依赖：

```bash
# 数据层（扫描 / 原子写 / 删除 / 复核）
node tools/test-session-store.mjs

# 投影缓存清理（目录版 + 单文件版）
node tools/test-cache-purge.mjs

# 编排层（令牌、短语、动作语义、错误码）
node tools/smoke-host-api.mjs

# 客户端：加载与执行式渲染
node tools/smoke-client-load.mjs

# 客户端：真实点击「删除 → 确认」并检查结果
node tools/smoke-client-interaction.mjs

# 客户端：异步不变量（操作后必刷新、异常不卡弹窗）
node tools/audit-async-paths.mjs

# 客户端：视觉红线（硬编码色值、官方包依赖）
node tools/audit-client.mjs

# 文案键完整性
node tools/check-locale.mjs
```

真实环境验证（会临时造一次性会话，用完即清）：

```bash
# 单条物理删除全链路
node tools/e2e-live-delete.mjs

# 批量删除 10 条
node tools/e2e-live-batch.mjs
```

### 诊断工具

```bash
# 查看存储结构与编码规则
node tools/inspect-store.mjs

# 列出某个会话的全部标题历史
node tools/diag-titles.mjs <会话id片段>

# 核对投影缓存与磁盘的一致性
node tools/clean-orphan-cache.mjs
```

> 另外 `tools/` 下还有若干 `probe-*` / `diag-*` 脚本（文件句柄占用探测、多帧解压成本实测等），它们是排查历史问题时的取证工具，保留作参考，不属于常规测试。

### 修改后如何生效

| 改动位置 | 生效方式 |
| --- | --- |
| `client.js` | 刷新页面 |
| `index.js`、`lib/*.js`、`package.json` | 重启 DSH |
| `cordis.patch.yml` | 重启 DSH |

## 项目结构

```
dsh-session-manager/
├── index.js                 Host 半边入口：注册路由、适配 cordis 服务
├── client.js                浏览器半边：侧栏入口 / 面板 / 确认弹窗
├── cordis.patch.yml         Loader 行声明
├── package.json             包清单（含 dsh.client 声明）
├── icon.svg                 插件图标
├── locale/
│   ├── zh.json              插件列表中的中文标题与描述
│   └── en.json              英文
├── lib/
│   ├── CONTRACT.md          模块间接口契约（冻结）
│   ├── host-api.js          编排层：令牌、动作语义、错误码
│   ├── session-store.js     数据层：扫描、原子写、物理删除、复核
│   └── title-resolver.js    标题解析：多帧 zstd 切分 + 缓存
├── tools/                   测试与诊断脚本
├── verify/                  独立验证脚本
├── docs/                    截图等文档资源
├── .github/workflows/       CI（Node 22 / 24 跑 npm test）
├── LICENSE                  MIT
└── .gitignore
```

## 已知限制

- **Host 改动需重启** — 插件没有热更新机制，Host 半边代码变更后必须重启 DSH。
- **删除运行中的会话会中断其工作** — 删除前会调用 `stopActivity` 停止该会话正在进行的 turn。
- **子会话默认隐藏** — 需要清理 subagent 会话时，点工具条上的「显示子会话」。
- **标题解析是异步补全** — 首次打开面板时只读缓存，未命中项在后台解析，标题会分批出现（通常 2 秒内完成）。
- **不处理工作区本身** — 本插件只管理会话，不创建 / 重命名 / 删除工作区。

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请确保：

1. 所有测试脚本通过（见 [开发](#开发)）；
2. 若改动了模块间接口，同步更新 [`lib/CONTRACT.md`](lib/CONTRACT.md)；
3. 新增可见文案时，同时补充 `client.js` 内的 `zh` / `en` 两套字典（`node tools/check-locale.mjs` 会校验）。

## 许可证

[MIT](LICENSE)
