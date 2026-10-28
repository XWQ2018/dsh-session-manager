/**
 * 会话管理插件 —— 浏览器半边（client.js）
 *
 * 职责：
 *  1. 侧栏入口（sidebar.panellist，id = 'dsh-session-manager'，order 50）
 *  2. 主面板整页界面（main，key = 'dsh-session-manager'）
 *  3. 确认对话框（shell.overlay）：点一下确认就执行，不再要求手输短语
 *
 * 约束（见 lib/CONTRACT.md 第 2、3 节）：
 *  - 只 require('react')，不 require 任何 @deepseek-ai/* 包
 *  - 不渲染到 document.body，所有注册包在 ctx.effect / ctx.slots.inject 内
 *  - 视觉只用 --dsw-alias-* 主题 token + color-mix()，无硬编码颜色
 *  - 数据通道：GET /api/dsh-session-manager/list、POST /api/dsh-session-manager/action
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ==================================================================
     * 常量
     * ================================================================== */

    const NS = 'dsh-session-manager'
    const API = '/api/dsh-session-manager'
    const ID = 'dsh-session-manager'
    // 服务端仍保留短语校验作为纵深防御（契约 2.2）。界面不再让用户手输，
    // 由确认按钮直接带上对应短语——用户只需点一次"确认删除"。
    const PHRASE_OF = {
      'delete-sessions': '删除',
      'delete-archived': '清空归档',
      'delete-all': '全部删除',
    }
    // 服务端错误码 → 本地化文案键
    const ERROR_KEY = {
      'bad-action': 'errBadAction',
      'bad-request': 'errBadRequest',
      'confirm-required': 'errConfirmRequired',
      'confirm-phrase-mismatch': 'errConfirmPhrase',
      'registry-unavailable': 'errRegistryUnavailable',
      'no-target': 'errNoTarget',
    }
    /**
     * 文案函数：模块作用域占位，apply() 时会被替换为绑定 locale 的实现。
     *
     * 必须声明在模块作用域，因为 load / postAction / describeFailure /
     * noticeTitleFor / applyResultNotice / performAction / reasonLabel / titleOf
     * 这些模块级函数都要调用它。若只在 apply() 内部声明，这些函数执行时会
     * 抛 "t is not defined"（删除成功后的结果提示就会踩到）。
     */
    let t = function (key) {
      return String(key)
    }

    // 服务端 skipped/blocked 的 reason → 本地化文案键（未知 reason 原样展示）
    const REASON_KEY = {
      live: 'reasonLive',
      'not-archived': 'reasonNotArchived',
      'not-found': 'reasonNotFound',
      'archive-failed': 'reasonArchiveFailed',
    }

    const zh = {
      open: '会话管理',
      title: '会话管理',
      subtitle: '浏览本地会话记录，整理、归档与彻底清理；删除前一律二次确认',
      refresh: '刷新',
      refreshHint: '重新读取会话列表',
      statTotal: '会话总数',
      statActive: '未归档',
      statArchived: '已归档',
      statBytes: '占用体积',
      statLiveHint: '其中已加载 {n} 个',
      statRunningHint: '其中运行中 {n} 个',
      searchPlaceholder: '搜索标题 / 工作目录 / 会话 ID',
      searchHint: '按标题、工作目录或会话 ID 实时过滤',
      searchClear: '清空搜索内容',
      filterAll: '全部',
      filterActive: '未归档',
      filterArchived: '已归档',
      selectAll: '全选',
      invertSelection: '反选',
      clearSelection: '清除选择',
      selectedCount: '已选 {n} 项',
      archiveSelected: '归档所选',
      deleteSelected: '删除所选',
      purgeArchived: '清空全部归档',
      deleteAll: '删除全部会话',
      purgeHint: '删除「全部」已归档会话，不受当前筛选影响',
      deleteAllHint: '删除「全部」会话（含未归档），不受当前筛选影响',
      emptyTitle: '暂无会话记录',
      emptyHint: '当前没有可管理的会话目录',
      emptyFilteredTitle: '没有匹配的会话',
      emptyFilteredHint: '试试更换关键词或切换筛选条件',
      loading: '正在读取会话列表…',
      loadFailed: '读取会话列表失败',
      retry: '重试',
      unknownError: '操作未返回具体原因',
      renderFailed: '界面渲染出错，请重试或刷新页面',
      untitled: '未命名会话',
      unknownCwd: '未知工作目录',
      unknownTime: '时间未知',
      justNow: '刚刚',
      minuteAgo: '1 分钟前',
      minutesAgo: '{n} 分钟前',
      hourAgo: '1 小时前',
      hoursAgo: '{n} 小时前',
      dayAgo: '1 天前',
      daysAgo: '{n} 天前',
      monthAgo: '1 个月前',
      monthsAgo: '{n} 个月前',
      yearAgo: '1 年前',
      yearsAgo: '{n} 年前',
      badgeArchived: '已归档',
      badgePinned: '已固定',
      badgeLive: '运行中',
      badgeRunning: '运行中',
      badgeAttached: '已加载',
      showSubagents: '显示子会话 {n} 个',
      hideSubagents: '隐藏子会话',
      subagentHint: '子会话（subagent）不会出现在 DSH 左侧栏，默认隐藏',
      actionArchive: '归档',
      actionUnarchive: '取消归档',
      actionDelete: '删除',
      liveDeleteHint: '该会话仍加载在内存中；删除前会先停止其活动，重启 DSH 后彻底消失',
      liveArchiveHint: '该会话仍加载在内存中，归档时会先停止它的活动',
      rowSelectHint: '选择该会话',
      rowActionsHint: '会话操作',
      dialogArchiveTitle: '归档会话',
      dialogUnarchiveTitle: '取消归档',
      dialogDeleteTitle: '删除会话',
      dialogPurgeTitle: '清空归档',
      dialogDeleteAllTitle: '删除全部会话',
      dialogArchiveDesc: '归档后会话会移入已归档分组，随时可以取消归档。',
      dialogUnarchiveDesc: '该会话将回到未归档列表。',
      dialogDeleteDesc:
        '会话目录、归档记录与缓存条目都会被彻底删除，此操作不可撤销。仍加载在内存中的会话会先停止其活动；若它正是你当前正在查看的会话，删除后该对话将无法继续。',
      dialogPurgeDesc: '将删除「全部已归档」会话，不受当前筛选影响；正在运行的会话会被跳过，此操作不可撤销。',
      dialogDeleteAllDesc: '将删除「全部」会话（含未归档），不受当前筛选影响；正在运行的会话会被跳过，此操作不可撤销。',
      scopeTitle: '影响范围',
      scopeCount: '{n} 项',
      scopeEmpty: '没有可预览的条目',
      scopeMore: '…等共 {n} 项',
      scopeBytes: '预计释放 {size}',
      scopeLiveNote: '其中 {n} 个仍加载在内存中，删除前会先停止其活动',
      phrasePrefix: '请输入「',
      phraseSuffix: '」以确认',
      phrasePlaceholder: '在此输入上方短语',
      phraseMismatch: '确认短语不匹配，主按钮保持禁用',
      confirmArchive: '确认归档',
      confirmUnarchive: '确认取消归档',
      confirmDelete: '确认删除',
      confirmPurge: '确认清空',
      confirmDeleteAll: '确认全部删除',
      cancel: '取消',
      busyWorking: '正在处理…',
      close: '关闭',
      closeHint: '关闭提示',
      noticeArchived: '已归档 {n} 个会话',
      noticeUnarchived: '已取消归档 {n} 个会话',
      noticeDeleted: '已删除 {n} 个会话',
      noticePurged: '已清空归档，删除 {n} 个会话',
      noticeSkipped: '跳过 {n} 个',
      noticeBlocked: '运行中跳过 {n} 个',
      noticeWarnings: '{n} 条提醒',
      noticeDetails: '查看明细',
      noticeDetailsHide: '收起明细',
      reasonLive: '运行中',
      reasonNotArchived: '未归档',
      reasonNotFound: '未找到',
      reasonArchiveFailed: '归档记录清理失败',
      errBadAction: '不支持的操作',
      errBadRequest: '请求格式不被接受',
      errConfirmRequired: '确认令牌缺失或已过期，请先刷新列表',
      errConfirmPhrase: '确认短语不匹配',
      errRegistryUnavailable: '归档服务当前不可用',
      errNoTarget: '没有匹配到任何会话',
      errNetwork: '无法连接到插件服务',
      errTimeout: '操作超时：删除可能已经执行，请刷新列表确认结果',
      errBadResponse: '插件返回了无法解析的数据',
      errHttp: '服务返回 HTTP {code}',
      errPhraseRequired: '确认短语不匹配，请重新输入',
      tokenMissing: '确认令牌缺失，请先刷新列表再重试',
      columnSession: '会话',
      columnStatus: '状态',
      columnSize: '体积',
      columnActions: '操作',
      dialogIrreversible: '此操作不可撤销',
      badgeSubagent: '子会话',
      pagePrev: '上一页',
      pageNext: '下一页',
      pageInfo: '共 {count} 条 · 第 {page} / {total} 页',
      pageInfoSingle: '共 {count} 条',
      selectFiltered: '选中筛选结果全部 {n} 条',
    }

    const en = {
      open: 'Session Manager',
      title: 'Session Manager',
      subtitle: 'Browse local sessions, tidy, archive and clean up — every deletion needs confirmation',
      refresh: 'Refresh',
      refreshHint: 'Reload the session list',
      statTotal: 'Sessions',
      statActive: 'Active',
      statArchived: 'Archived',
      statBytes: 'Disk usage',
      statLiveHint: '{n} loaded',
      statRunningHint: '{n} running now',
      searchPlaceholder: 'Search title / cwd / session id',
      searchHint: 'Filter by title, working directory or session id',
      searchClear: 'Clear search',
      filterAll: 'All',
      filterActive: 'Active',
      filterArchived: 'Archived',
      selectAll: 'Select all',
      invertSelection: 'Invert',
      clearSelection: 'Clear selection',
      selectedCount: '{n} selected',
      archiveSelected: 'Archive selected',
      deleteSelected: 'Delete selected',
      purgeArchived: 'Purge all archived',
      deleteAll: 'Delete every session',
      purgeHint: 'Deletes ALL archived sessions; the current filter does not apply',
      deleteAllHint: 'Deletes EVERY session including active ones; the current filter does not apply',
      emptyTitle: 'No sessions yet',
      emptyHint: 'There is nothing to manage right now',
      emptyFilteredTitle: 'No matching sessions',
      emptyFilteredHint: 'Try another keyword or switch the filter',
      loading: 'Loading sessions…',
      loadFailed: 'Failed to load the session list',
      retry: 'Retry',
      unknownError: 'The operation failed without a reason',
      renderFailed: 'The view failed to render; retry or reload the page',
      untitled: 'Untitled session',
      unknownCwd: 'Unknown working directory',
      unknownTime: 'Unknown time',
      justNow: 'just now',
      minuteAgo: '1 minute ago',
      minutesAgo: '{n} minutes ago',
      hourAgo: '1 hour ago',
      hoursAgo: '{n} hours ago',
      dayAgo: '1 day ago',
      daysAgo: '{n} days ago',
      monthAgo: '1 month ago',
      monthsAgo: '{n} months ago',
      yearAgo: '1 year ago',
      yearsAgo: '{n} years ago',
      badgeArchived: 'Archived',
      badgePinned: 'Pinned',
      badgeLive: 'Live',
      badgeRunning: 'Running',
      badgeAttached: 'Loaded',
      showSubagents: 'Show {n} sub-sessions',
      hideSubagents: 'Hide sub-sessions',
      subagentHint: 'Sub-agent sessions never appear in the DSH sidebar; hidden by default',
      actionArchive: 'Archive',
      actionUnarchive: 'Unarchive',
      actionDelete: 'Delete',
      liveDeleteHint: 'Still loaded in memory; its activity is stopped first, and it disappears fully after a DSH restart',
      liveArchiveHint: 'Still loaded in memory; archiving will stop its activity first',
      rowSelectHint: 'Select this session',
      rowActionsHint: 'Session actions',
      dialogArchiveTitle: 'Archive session',
      dialogUnarchiveTitle: 'Unarchive session',
      dialogDeleteTitle: 'Delete session',
      dialogPurgeTitle: 'Purge archived',
      dialogDeleteAllTitle: 'Delete all sessions',
      dialogArchiveDesc: 'Archived sessions move to the archived group and can be restored at any time.',
      dialogUnarchiveDesc: 'This session returns to the active list.',
      dialogDeleteDesc:
        'The session directory, archive entry and cache record are removed for good. This cannot be undone. Sessions still loaded in memory have their activity stopped first; if this is the conversation you are viewing right now, it will stop working afterwards.',
      dialogPurgeDesc: 'ALL archived sessions are deleted, regardless of the current filter; live sessions are skipped. This cannot be undone.',
      dialogDeleteAllDesc: 'EVERY session is deleted, including active ones, regardless of the current filter; live sessions are skipped. This cannot be undone.',
      scopeTitle: 'Affected scope',
      scopeCount: '{n} items',
      scopeEmpty: 'Nothing to preview',
      scopeMore: '…and {n} in total',
      scopeBytes: 'Frees about {size}',
      scopeLiveNote: '{n} of them are still loaded in memory; their activity is stopped first',
      phrasePrefix: 'Type "',
      phraseSuffix: '" to confirm',
      phrasePlaceholder: 'Enter the phrase above',
      phraseMismatch: 'The phrase does not match; the primary button stays disabled',
      confirmArchive: 'Archive',
      confirmUnarchive: 'Unarchive',
      confirmDelete: 'Delete',
      confirmPurge: 'Purge',
      confirmDeleteAll: 'Delete all',
      cancel: 'Cancel',
      busyWorking: 'Working…',
      close: 'Close',
      closeHint: 'Dismiss this notice',
      noticeArchived: 'Archived {n} sessions',
      noticeUnarchived: 'Unarchived {n} sessions',
      noticeDeleted: 'Deleted {n} sessions',
      noticePurged: 'Archive purged, deleted {n} sessions',
      noticeSkipped: 'Skipped {n}',
      noticeBlocked: '{n} skipped because they are live',
      noticeWarnings: '{n} warnings',
      noticeDetails: 'Show details',
      noticeDetailsHide: 'Hide details',
      reasonLive: 'live',
      reasonNotArchived: 'not archived',
      reasonNotFound: 'not found',
      reasonArchiveFailed: 'archive record cleanup failed',
      errBadAction: 'Unsupported action',
      errBadRequest: 'The request was rejected',
      errConfirmRequired: 'The confirmation token is missing or expired; refresh the list first',
      errConfirmPhrase: 'The confirmation phrase does not match',
      errRegistryUnavailable: 'The archive service is unavailable',
      errNoTarget: 'No session matched',
      errNetwork: 'Cannot reach the plugin service',
      errTimeout: 'Timed out: the action may have completed — refresh the list to confirm',
      errBadResponse: 'The plugin returned unreadable data',
      errHttp: 'The service replied with HTTP {code}',
      errPhraseRequired: 'The confirmation phrase does not match; type it again',
      tokenMissing: 'The confirmation token is missing; refresh the list and retry',
      columnSession: 'Session',
      columnStatus: 'Status',
      columnSize: 'Size',
      columnActions: 'Actions',
      dialogIrreversible: 'This cannot be undone',
      badgeSubagent: 'Sub-session',
      pagePrev: 'Previous',
      pageNext: 'Next',
      pageInfo: '{count} items · page {page} / {total}',
      pageInfoSingle: '{count} items',
      selectFiltered: 'Select all {n} filtered',
    }

    /* ==================================================================
     * 样式：仅使用 --dsw-alias-* token + color-mix()，深浅色通用。
     * 两个关键点：
     *  1) 根容器带**不透明**底色，避免壁纸/皮肤插件穿透导致文字不可读；
     *  2) 本块必须由组件渲染成 <style> 才会生效（见 SessionManagerPage）。
     * ================================================================== */

    const CSS = [
      /* ---------- 根容器 ---------- */
      '.dsm-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:100%;min-height:0;overflow:hidden;background:radial-gradient(1200px 420px at 18% -12%,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent),transparent 72%),var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:0.8125rem;line-height:1.55;font-family:inherit}',
      '.dsm-root *,.dsm-backdrop *{box-sizing:border-box}',
      '.dsm-root button,.dsm-backdrop button,.dsm-root input,.dsm-backdrop input{font-family:inherit}',
      '.dsm-root :focus-visible,.dsm-backdrop :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
      '.dshsm-fallback{padding:24px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-base));font-size:0.8125rem}',
      '.dsm-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:14px;padding:22px 24px 10px}',
      '.dsm-footer{flex:none;display:flex;flex-direction:column;gap:8px;padding:0 24px 20px}',

      /* ---------- Hero ---------- */
      '.dsm-hero{position:relative;display:flex;align-items:center;gap:14px;padding:16px 18px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 66%);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsm-hero::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 90% at 100% 0,color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent),transparent 62%)}',
      '.dsm-hero-icon{position:relative;flex:none;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent);background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent));color:var(--dsw-alias-brand-primary);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-bg-base) 40%,transparent)}',
      '.dsm-hero-text{position:relative;flex:1 1 auto;min-width:0}',
      '.dsm-hero-title{margin:0;font-size:1.0625rem;font-weight:650;letter-spacing:.005em}',
      '.dsm-hero-sub{margin:3px 0 0;font-size:0.75rem;color:var(--dsw-alias-label-secondary)}',
      '.dsm-hero-actions{position:relative;flex:none;display:flex;align-items:center;gap:8px}',

      /* ---------- 统计卡 ---------- */
      '.dsm-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '.dsm-stat{position:relative;padding:12px 14px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 46%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 62%);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsm-stat-label{display:block;font-size:0.6875rem;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dsm-stat-value{display:block;margin-top:4px;font-size:1.375rem;font-weight:660;line-height:1.2;letter-spacing:-.015em;font-variant-numeric:tabular-nums}',
      '.dsm-stat-hint{display:block;margin-top:2px;font-size:0.6875rem;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-stat.is-live .dsm-stat-value{color:var(--dsw-alias-state-success-primary)}',
      '.dsm-stat.is-archived .dsm-stat-value{color:var(--dsw-alias-label-secondary)}',

      /* ---------- 工具条 ---------- */
      '.dsm-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsm-search{position:relative;flex:1 1 210px;min-width:160px;display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);transition:border-color .15s cubic-bezier(.2,0,0,1),box-shadow .15s cubic-bezier(.2,0,0,1)}',
      '.dsm-search:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
      '.dsm-search input{flex:1 1 auto;min-width:0;height:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:0.8125rem;outline:none}',
      '.dsm-search input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dsm-search input::-webkit-search-cancel-button{display:none}',
      '.dsm-search-clear{display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dsm-search-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsm-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsm-seg button{height:26px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:0.75rem;white-space:nowrap;cursor:pointer;transition:background .15s cubic-bezier(.2,0,0,1),color .15s cubic-bezier(.2,0,0,1),box-shadow .15s cubic-bezier(.2,0,0,1)}',
      '.dsm-seg button:hover{color:var(--dsw-alias-label-primary)}',
      '.dsm-seg button.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}',
      '.dsm-toolbar-actions{display:flex;align-items:center;gap:8px;margin-left:auto}',

      /* ---------- 按钮 ---------- */
      '.dsm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:0.75rem;white-space:nowrap;cursor:pointer;transition:background .15s cubic-bezier(.2,0,0,1),border-color .15s cubic-bezier(.2,0,0,1),color .15s cubic-bezier(.2,0,0,1),opacity .15s}',
      '.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dsm-btn:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,var(--dsw-alias-bg-layer-1))}',
      '.dsm-btn:disabled{opacity:.42;cursor:default}',
      '.dsm-btn.is-on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dsm-btn.is-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsm-btn.is-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsm-btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}',
      '.dsm-btn.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l1))}',
      '.dsm-btn.is-primary{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#ffffff;font-weight:600}',
      '.dsm-btn.is-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 84%,var(--dsw-alias-label-primary));color:#ffffff}',
      '.dsm-btn.is-icon{width:30px;height:30px;padding:0;border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsm-btn.is-icon:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsm-btn.is-icon.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}',

      /* ---------- 列表 ---------- */
      '.dsm-listcard{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);overflow:hidden}',
      '.dsm-listhead{display:grid;grid-template-columns:30px minmax(0,1fr) auto 76px 92px;align-items:center;gap:12px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);font-size:0.6875rem;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dsm-listhead .dsm-al-right{text-align:right}',
      '.dsm-row{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) auto 76px 92px;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 66%,transparent);transition:background .15s cubic-bezier(.2,0,0,1)}',
      '.dsm-row:last-child{border-bottom:0}',
      '.dsm-row::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:2px;border-radius:2px;background:transparent;transition:background .15s cubic-bezier(.2,0,0,1)}',
      '.dsm-row:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}',
      '.dsm-row:hover::before{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      '.dsm-row.is-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.dsm-row.is-selected::before{background:var(--dsw-alias-brand-primary)}',
      '.dsm-check{width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}',
      '.dsm-check:disabled{cursor:not-allowed;opacity:.5}',
      '.dsm-main{min-width:0}',
      '.dsm-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8125rem;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-sub{display:flex;align-items:center;gap:6px;margin-top:2px;overflow:hidden;font-size:0.6875rem;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dsm-sid{flex:none;color:var(--dsw-alias-label-tertiary);opacity:.85}',
      '.dsm-badges{display:flex;align-items:center;gap:5px;justify-content:flex-end}',
      '.dsm-badge{display:inline-flex;align-items:center;gap:5px;height:19px;padding:0 8px 0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:0.625rem;line-height:1;white-space:nowrap}',
      '.dsm-badge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.8}',
      '.dsm-badge.is-live{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
      '.dsm-badge.is-archived{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 11%,transparent)}',
      '.dsm-badge.is-pinned{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent)}',
      '.dsm-metric{text-align:right;font-variant-numeric:tabular-nums;line-height:1.35}',
      '.dsm-metric-size{display:block;font-size:0.75rem;color:var(--dsw-alias-label-secondary)}',
      '.dsm-metric-time{display:block;font-size:0.625rem;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px}',
      '.dsm-badge.is-sub{color:var(--dsw-alias-label-secondary);border-style:dashed}',
      '.dsm-badge.is-attached{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent)}',
      '.dsm-btn-count{min-width:17px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,currentColor 15%,transparent);font-size:0.625rem;line-height:15px;font-variant-numeric:tabular-nums;text-align:center}',
      '.dsm-pager{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}',
      '.dsm-pager-info{font-size:0.6875rem;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsm-pager-actions{display:flex;align-items:center;gap:6px}',
      '.dsm-pager-current{min-width:58px;text-align:center;font-size:0.75rem;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsm-link{border:0;background:none;padding:0;color:var(--dsw-alias-brand-primary);font-size:0.6875rem;cursor:pointer;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}',
      '.dsm-link:hover{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-primary))}',

      /* ---------- 空 / 加载态 ---------- */
      '.dsm-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:56px 24px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent)}',
      '.dsm-state-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:13px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
      '.dsm-state-title{font-size:0.875rem;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-state-hint{font-size:0.75rem;color:var(--dsw-alias-label-secondary)}',

      /* ---------- 批量条 ---------- */
      '.dsm-bulk{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1));border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}',
      '.dsm-bulk-count{font-size:0.75rem;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsm-bulk-spacer{flex:1 1 auto}',

      /* ---------- 提示条 ---------- */
      '.dsm-notice{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:0.75rem}',
      '.dsm-notice.is-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,var(--dsw-alias-bg-layer-1))}',
      '.dsm-notice.is-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,var(--dsw-alias-bg-layer-1))}',
      '.dsm-notice.is-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}',
      '.dsm-notice-body{flex:1 1 auto;min-width:0}',
      '.dsm-notice-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-notice-detail{margin-top:3px;font-size:0.6875rem;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dsm-notice-link{border:0;background:none;padding:0;color:var(--dsw-alias-brand-primary);font-size:0.6875rem;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
      '.dsm-notice-close{flex:none;display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dsm-notice-close:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',

      /* ---------- 确认对话框（居中于视口） ---------- */
      '.dsm-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 64%,transparent);backdrop-filter:blur(3px);animation:dsm-fade .16s cubic-bezier(.2,0,0,1)}',
      '.dsm-dialog{width:min(432px,100%);max-height:min(86vh,640px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-overlay);box-shadow:0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);animation:dsm-pop .18s cubic-bezier(.2,0,0,1)}',
      '.dsm-dialog-head{display:flex;align-items:center;gap:10px;padding:18px 18px 0}',
      '.dsm-dialog-icon{flex:none;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dsm-dialog-icon.is-neutral{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.dsm-dialog-title{flex:1 1 auto;font-size:0.9375rem;font-weight:650;color:var(--dsw-alias-label-primary)}',
      '.dsm-dialog-body{padding:10px 18px 0;font-size:0.75rem;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
      '.dsm-scope{margin:12px 18px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsm-scope-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:0.6875rem;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dsm-scope-list{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;max-height:132px;overflow:auto}',
      '.dsm-scope-item{display:flex;align-items:baseline;gap:8px;font-size:0.6875rem;color:var(--dsw-alias-label-primary)}',
      '.dsm-scope-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsm-scope-size{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsm-scope-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:0.6875rem;color:var(--dsw-alias-label-secondary)}',
      '.dsm-scope-live{color:var(--dsw-alias-state-warn-primary)}',
      '.dsm-dialog-error{margin:12px 18px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:0.6875rem;line-height:1.5}',
      '.dsm-dialog-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 18px}',
      '.dsm-dialog-hint{margin-right:auto;font-size:0.6875rem;color:var(--dsw-alias-label-tertiary)}',

      /* ---------- 动效 ---------- */
      '@keyframes dsm-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dsm-pop{from{opacity:0;transform:translateY(8px) scale(.986)}to{opacity:1;transform:none}}',
      '@keyframes dsm-spin{to{transform:rotate(360deg)}}',
      '.dsm-spin{animation:dsm-spin .9s linear infinite}',

      /* ---------- 响应式 ---------- */
      '@media (max-width:900px){.dsm-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:760px){.dsm-listhead,.dsm-row{grid-template-columns:26px minmax(0,1fr) auto 84px}.dsm-col-metric{display:none}}',
      '@media (max-width:600px){.dsm-scroll{padding:16px}.dsm-toolbar-actions{width:100%;margin-left:0}}',
      '@media (prefers-reduced-motion:reduce){.dsm-root *,.dsm-backdrop *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}}',
    ].join('\n')

    /* ==================================================================
     * 工具函数（全部防御式：任何异常都不应冒泡到插槽）
     * ================================================================== */

    function safeString(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return ''
    }

    function errorText(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      if (error.name === 'AbortError') return 'timeout'
      if (error.diagnostic) return safeString(error.diagnostic)
      if (error.data && (error.data.diagnostic || error.data.message)) {
        return safeString(error.data.diagnostic || error.data.message)
      }
      if (error.message) return safeString(error.message)
      if (error.code) return safeString(error.code)
      try {
        return JSON.stringify(error)
      } catch (unused) {
        return ''
      }
    }

    // 人类可读体积（等宽数字展示）
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = value
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size = size / 1024
        index += 1
      }
      const digits = index === 0 ? 0 : size >= 100 ? 0 : 1
      return size.toFixed(digits) + ' ' + units[index]
    }

    // sessionId 短码：session-xxxxxxxx → 后 8 位
    function shortId(sessionId) {
      const text = safeString(sessionId)
      if (!text) return '—'
      const dash = text.lastIndexOf('-')
      if (dash >= 0 && text.length - dash - 1 >= 6) return text.slice(dash + 1)
      return text.length > 12 ? text.slice(0, 12) : text
    }

    function isInteractiveTarget(target) {
      if (!target || typeof target.closest !== 'function') return false
      return Boolean(target.closest('button, a, input, label, select, textarea'))
    }

    /* ==================================================================
     * 单一 store + 轻量订阅（列表行不各自建监听）
     * ================================================================== */

    let state = {
      loaded: false,
      loading: false,
      error: '',
      items: [],
      stats: { total: 0, active: 0, archived: 0, live: 0, bytes: 0 },
      confirmToken: '',
      fetchedAt: 0,
      query: '',
      statusFilter: 'all',
      page: 1,
      titlesPending: 0,
      // 默认隐藏 subagent 子会话：官方侧边栏本来就不显示它们，
      // 混在一起会让人误以为"取消归档后侧边栏应该恢复"。
      showSubagents: false,
      selection: new Set(),
      busy: '',
      notice: null,
      dialog: null,
    }

    /** 每页条数（用户要求：一页 10 条，超出分页）。 */
    const PAGE_SIZE = 10

    const listeners = new Set()

    function getSnapshot() {
      return state
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function notify() {
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-session-manager] listener failed', error)
        }
      }
    }

    // 不可变更新：替换 state 引用，便于 useSyncExternalStore 判定变化
    function patch(next) {
      state = Object.assign({}, state, next)
      notify()
    }

    /**
     * 组件订阅：优先 useSyncExternalStore，缺失时回落 useState + 订阅。
     * 两种实现都在模块初始化时选定一次，保证 hook 调用顺序稳定。
     */
    const useStore =
      typeof React.useSyncExternalStore === 'function'
        ? function useStore() {
            return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
          }
        : function useStore() {
            const [snapshot, setSnapshot] = React.useState(state)
            React.useEffect(() => {
              const listener = () => setSnapshot(state)
              listeners.add(listener)
              return () => {
                listeners.delete(listener)
              }
            }, [])
            return snapshot
          }

    /* ==================================================================
     * 数据通道（契约第 2 节）
     * ================================================================== */

    let inflight = null

    function normalizeStats(raw, items) {
      const total = items.length
      let active = 0
      let archived = 0
      let live = 0
      let bytes = 0
      for (const item of items) {
        if (item.archived) archived += 1
        else active += 1
        if (item.live) live += 1
        bytes += item.sizeBytes
      }
      const source = raw && typeof raw === 'object' ? raw : {}
      const pick = (key, fallback) => {
        const value = Number(source[key])
        return isFinite(value) && value >= 0 ? value : fallback
      }
      return {
        total: pick('total', total),
        active: pick('active', active),
        archived: pick('archived', archived),
        live: pick('live', live),
        running: pick('running', items.filter((item) => item.running).length),
        bytes: pick('bytes', bytes),
      }
    }

    function normalizeItems(raw) {
      if (!Array.isArray(raw)) return []
      const items = []
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const sessionId = safeString(entry.sessionId)
        if (!sessionId) continue
        const sizeBytes = Number(entry.sizeBytes)
        const live = entry.live === true
        items.push({
          sessionId,
          title: safeString(entry.title).trim(),
          cwd: safeString(entry.cwd),
          origin: safeString(entry.origin),
          parentSession: safeString(entry.parentSession),
          workspaceTitle: safeString(entry.workspaceTitle),
          archived: entry.archived === true,
          pinned: entry.pinned === true,
          live,
          running: entry.running === true,
          sizeBytes: isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
          createdAt: Number(entry.createdAt) || 0,
          updatedAt: Number(entry.updatedAt) || 0,
          deletable: entry.deletable !== false && !live,
          blockReason: safeString(entry.blockReason),
        })
      }
      // 契约已排序，这里做一次稳定兜底
      items.sort((left, right) => {
        if (left.archived !== right.archived) return left.archived ? 1 : -1
        return (right.updatedAt || 0) - (left.updatedAt || 0)
      })
      return items
    }

    /**
     * GET /list：读取列表、统计与一次性 confirmToken。
     * 返回值丢失也不会抛错；失败时只更新 error/notice。
     */
    async function load(options) {
      const force = options && options.force === true
      if (inflight) {
        // 非强制时复用进行中的请求；强制时必须等它结束后再发新请求，
        // 否则会拿到「上一次操作之前」的旧响应（删完列表不变的原因）。
        if (!force) return inflight
        try {
          await inflight
        } catch (error) {
          /* 旧请求失败不影响新请求 */
        }
      }
      const silent = options && options.silent === true
      if (!silent) patch({ loading: true, error: '' })
      inflight = (async () => {
        try {
          const response = await fetch(API + '/list', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          let data = null
          try {
            data = await response.json()
          } catch (parseError) {
            data = null
          }
          if (!response.ok) throw new Error(t('errHttp', { code: response.status }))
          if (!data || typeof data !== 'object' || data.ok !== true) {
            const message = data && typeof data.message === 'string' ? data.message : ''
            throw new Error(message || t('errBadResponse'))
          }
          const items = normalizeItems(data.items)
          const ids = new Set(items.map((item) => item.sessionId))
          // 选择集合只保留仍存在的 id，避免删除后残留幽灵选择
          const selection = new Set(Array.from(state.selection).filter((id) => ids.has(id)))
          patch({
            loaded: true,
            loading: false,
            error: '',
            items,
            stats: normalizeStats(data.stats, items),
            confirmToken: safeString(data.confirmToken),
            fetchedAt: Number(data.generatedAt) || Date.now(),
            titlesPending: Number(data.titlesPending) || 0,
            selection,
          })
          return true
        } catch (error) {
          const detail = errorText(error) || t('unknownError')
          const message = t('loadFailed') + '：' + detail
          if (silent) patch({ notice: { kind: 'error', title: message, details: [], at: Date.now() } })
          else patch({ loading: false, loaded: true, error: message })
          return false
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    /** POST /action：统一返回对象；网络异常与超时都不抛出，而是带回显式错误码。 */
    async function postAction(payload) {
      let controller = null
      let timer = null
      let timedOut = false
      try {
        if (typeof AbortController === 'function') {
          controller = new AbortController()
          timer = setTimeout(() => {
            timedOut = true
            try {
              controller.abort()
            } catch (unused) {
              /* 忽略 */
            }
          }, 20000)
        }
        const response = await fetch(API + '/action', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        })
        let data = null
        try {
          data = await response.json()
        } catch (parseError) {
          data = null
        }
        if (!response.ok) {
          return { ok: false, error: 'http-' + response.status, message: t('errHttp', { code: response.status }) }
        }
        if (!data || typeof data !== 'object') {
          return { ok: false, error: 'bad-response', message: t('errBadResponse') }
        }
        return data
      } catch (error) {
        if (timedOut) {
          return { ok: false, error: 'timeout', message: t('errTimeout') }
        }
        return { ok: false, error: 'network', message: t('errNetwork') + '：' + (errorText(error) || t('unknownError')) }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    function describeFailure(result) {
      if (!result) return t('errBadResponse')
      const code = safeString(result.error)
      if (ERROR_KEY[code]) return t(ERROR_KEY[code])
      if (typeof result.message === 'string' && result.message) return result.message
      return t('unknownError')
    }

    function reasonLabel(entry) {
      const reason = safeString(entry && entry.reason)
      if (REASON_KEY[reason]) return t(REASON_KEY[reason])
      return reason || t('unknownError')
    }

    function titleOf(item) {
      if (!item) return ''
      return item.title || shortId(item.sessionId)
    }

    /* ==================================================================
     * 列表过滤与选择
     * ================================================================== */

    function filterItems(items, query, statusFilter, showSubagents) {
      const keyword = safeString(query).trim().toLowerCase()
      return items.filter((item) => {
        if (statusFilter === 'active' && item.archived) return false
        if (statusFilter === 'archived' && !item.archived) return false
        if (!showSubagents && item.origin === 'subagent') return false
        if (!keyword) return true
        const haystack = [item.title, item.cwd, item.sessionId, item.workspaceTitle]
          .map((value) => safeString(value).toLowerCase())
          .join('\n')
        return haystack.indexOf(keyword) >= 0
      })
    }

    function itemsByIds(ids) {
      const wanted = new Set(Array.isArray(ids) ? ids.map(safeString) : [])
      return state.items.filter((item) => wanted.has(item.sessionId))
    }

    function toggleSelection(sessionId, force) {
      const next = new Set(state.selection)
      const has = next.has(sessionId)
      const want = typeof force === 'boolean' ? force : !has
      if (want) next.add(sessionId)
      else next.delete(sessionId)
      patch({ selection: next })
    }

    function selectMany(ids) {
      patch({ selection: new Set(Array.isArray(ids) ? ids : []) })
    }

    function invertMany(ids) {
      const next = new Set(state.selection)
      for (const id of Array.isArray(ids) ? ids : []) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      patch({ selection: next })
    }

    function clearSelection() {
      patch({ selection: new Set() })
    }

    /* ==================================================================
     * 确认对话框状态机
     * 交互原则：一次点击即可确认——打开弹窗后点"确认删除"就执行，
     * 不再要求用户手写短语（服务端令牌与短语校验仍在，由界面自动携带）。
     * ================================================================== */

    function openDialog(kind, ids) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : []
      const items = itemsByIds(list)
      const bytes = items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0)
      const liveCount = items.filter((item) => item.live).length
      patch({
        dialog: {
          key: kind + ':' + Date.now() + ':' + list.length,
          kind,
          ids: list,
          labels: items.map(titleOf),
          sizes: items.map((item) => item.sizeBytes || 0),
          bytes,
          liveCount,
          busy: false,
          error: '',
        },
      })
    }


    function patchDialog(next) {
      if (!state.dialog) return
      patch({ dialog: Object.assign({}, state.dialog, next) })
    }

    function closeDialog() {
      const dialog = state.dialog
      if (!dialog || dialog.busy) return
      patch({ dialog: null })
    }

    function noticeTitleFor(kind, doneCount) {
      if (kind === 'archive') return t('noticeArchived', { n: doneCount })
      if (kind === 'unarchive') return t('noticeUnarchived', { n: doneCount })
      if (kind === 'delete-archived') return t('noticePurged', { n: doneCount })
      return t('noticeDeleted', { n: doneCount })
    }

    function applyResultNotice(kind, result) {
      const done = Array.isArray(result.done) ? result.done : []
      const skipped = Array.isArray(result.skipped) ? result.skipped : []
      const blocked = Array.isArray(result.blocked) ? result.blocked : []
      const warnings = Array.isArray(result.warnings) ? result.warnings : []
      const details = []
      const nameOf = (entry) => {
        const item = itemsByIds([entry && entry.sessionId])[0]
        return item ? titleOf(item) : shortId(entry && entry.sessionId)
      }
      if (blocked.length > 0) {
        details.push({
          label: t('noticeBlocked', { n: blocked.length }),
          text: blocked.map((entry) => nameOf(entry) + ' · ' + reasonLabel(entry)).join('；'),
        })
      }
      if (skipped.length > 0) {
        details.push({
          label: t('noticeSkipped', { n: skipped.length }),
          text: skipped.map((entry) => nameOf(entry) + ' · ' + reasonLabel(entry)).join('；'),
        })
      }
      if (warnings.length > 0) {
        details.push({
          label: t('noticeWarnings', { n: warnings.length }),
          text: warnings.map((text) => safeString(text)).join('；'),
        })
      }
      patch({
        selection: new Set(),
        notice: {
          kind: details.length > 0 ? 'warn' : 'success',
          title: noticeTitleFor(kind, done.length),
          details,
          at: Date.now(),
        },
      })
    }

    /**
     * 执行动作：删除类自动携带 confirmToken 与对应确认短语（用户只需点确认）。
     *
     * 三条硬性保证（之前踩过的坑）：
     *  1. 任何异常都不会让弹窗永久停在"正在处理中"——finally 里兜底解除 busy；
     *  2. 删除成功后立刻把已删条目从本地列表移除（乐观更新），
     *     即使后续刷新失败，用户也能看到结果；
     *  3. 随后的刷新必须 force，避免复用操作前发出的旧请求。
     */
    async function performAction(kind, ids) {
      const dialog = state.dialog
      if (!dialog || dialog.busy) return
      const targetIds = Array.isArray(ids) ? ids.filter(Boolean) : []
      const isDelete = kind.indexOf('delete') === 0

      try {
        const payload = { action: kind }
        if (kind !== 'delete-all') {
          // delete-all 由服务端解析全部目标；其余动作显式带 ids
          payload.ids = targetIds
        }
        if (isDelete) {
          if (!state.confirmToken) {
            patchDialog({ error: t('tokenMissing') })
            return
          }
          payload.confirmToken = state.confirmToken
          // 短语由界面自动携带（契约 2.2），用户无需手输
          payload.confirmPhrase = PHRASE_OF[kind]
        }

        patchDialog({ busy: true, error: '' })
        patch({ busy: kind, error: '' })

        const result = await postAction(payload)

        if (!result || result.ok !== true) {
          const message = describeFailure(result)
          patch({ busy: '' })
          patchDialog({ busy: false, error: message })
          patch({ notice: { kind: 'error', title: message, details: [], at: Date.now() } })
          return
        }

        // 先关闭弹窗，再处理结果：保证用户不会看到卡住的"正在处理中"
        patch({ dialog: null })

        // 乐观更新：已删除的条目立即从本地列表移除，不必等刷新
        const doneIds = Array.isArray(result.done) ? result.done : []
        if (doneIds.length > 0) {
          const doneSet = new Set(doneIds.map(String))
          const remaining = state.items.filter((item) => !doneSet.has(item.sessionId))
          patch({
            items: remaining,
            stats: normalizeStats(null, remaining),
            selection: new Set(Array.from(state.selection).filter((id) => !doneSet.has(id))),
            busy: '',
          })
        } else {
          patch({ busy: '' })
        }

        applyResultNotice(kind, result)

        // 令牌由 list 签发；force 确保拿到操作之后的数据
        await load({ silent: true, force: true })
      } catch (error) {
        const message = errorText(error) || t('unknownError')
        patch({ busy: '' })
        patch({ notice: { kind: 'error', title: message, details: [], at: Date.now() } })
        patchDialog({ busy: false, error: message })
      } finally {
        // 兜底：任何路径都不允许把 busy 留在 true 上
        if (state.busy) patch({ busy: '' })
        if (state.dialog && state.dialog.busy) patchDialog({ busy: false })
      }
    }

    /* ==================================================================
     * 图标（全部 currentColor，无硬编码颜色）
     * ================================================================== */


    function svgBase(size, strokeWidth) {
      return {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: strokeWidth || 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }
    }

    function BrandGlyph(props) {
      const size = (props && props.size) || 22
      return h(
        'svg',
        svgBase(size),
        h('path', { d: 'M4 7.6 12 3.4l8 4.2-8 4.2-8-4.2Z' }),
        h('path', { d: 'M4 12.4l8 4.2 8-4.2' }),
        h('path', { d: 'M4 16.6l8 4.2 8-4.2' }),
      )
    }

    function SearchGlyph(props) {
      const size = (props && props.size) || 14
      return h(
        'svg',
        svgBase(size),
        h('circle', { cx: 11, cy: 11, r: 6.2 }),
        h('path', { d: 'M20 20l-3.6-3.6' }),
      )
    }

    function RefreshGlyph(props) {
      const size = (props && props.size) || 15
      return h(
        'svg',
        svgBase(size, 1.9),
        h('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }),
        h('path', { d: 'M20 5v6h-6' }),
      )
    }

    function CloseGlyph(props) {
      const size = (props && props.size) || 14
      return h('svg', svgBase(size, 1.9), h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    }

    function CheckGlyph(props) {
      const size = (props && props.size) || 12
      return h('svg', svgBase(size, 2.6), h('path', { d: 'M5 12.5l4.2 4.2L19 7' }))
    }

    function ArchiveGlyph(props) {
      const size = (props && props.size) || 15
      return h(
        'svg',
        svgBase(size, 1.8),
        h('path', { d: 'M4 7.5h16' }),
        h('path', { d: 'M5.5 7.5V19a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 18.5 19V7.5' }),
        h('path', { d: 'M10 12.5h4' }),
      )
    }

    function UnarchiveGlyph(props) {
      const size = (props && props.size) || 15
      return h(
        'svg',
        svgBase(size, 1.8),
        h('path', { d: 'M4 7.5h16' }),
        h('path', { d: 'M5.5 7.5V19a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 18.5 19V7.5' }),
        h('path', { d: 'M12 16.5v-5' }),
        h('path', { d: 'M9.6 13.6 12 11.2l2.4 2.4' }),
      )
    }

    function TrashGlyph(props) {
      const size = (props && props.size) || 15
      return h(
        'svg',
        svgBase(size, 1.8),
        h('path', { d: 'M4.5 7h15' }),
        h('path', { d: 'M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7' }),
        h('path', { d: 'M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12' }),
        h('path', { d: 'M10.5 11.5v6M13.5 11.5v6' }),
      )
    }

    function ShieldGlyph(props) {
      const size = (props && props.size) || 15
      return h(
        'svg',
        svgBase(size, 1.8),
        h('path', { d: 'M12 3.5 5 6.4v5.2c0 4.1 2.8 7.2 7 8.9 4.2-1.7 7-4.8 7-8.9V6.4L12 3.5Z' }),
        h('path', { d: 'M12 9v4' }),
        h('path', { d: 'M12 16.2h.01' }),
      )
    }

    function AlertGlyph(props) {
      const size = (props && props.size) || 15
      return h(
        'svg',
        svgBase(size, 1.8),
        h('path', { d: 'M12 4.2 3.4 19.2h17.2L12 4.2Z' }),
        h('path', { d: 'M12 10v4.2' }),
        h('path', { d: 'M12 17.1h.01' }),
      )
    }

    function InboxGlyph(props) {
      const size = (props && props.size) || 24
      return h(
        'svg',
        svgBase(size, 1.5),
        h('path', { d: 'M4 13.5 6.6 5.8A2 2 0 0 1 8.5 4.4h7a2 2 0 0 1 1.9 1.4L20 13.5' }),
        h('path', { d: 'M4 13.5h4l1.2 2.6h5.6l1.2-2.6h4v4.1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4.1Z' }),
      )
    }

    function ChevronLeftGlyph(props) {
      const size = (props && props.size) || 16
      return h('svg', svgBase(size, 2), h('path', { d: 'M14.5 5.5L8 12l6.5 6.5' }))
    }

    function ChevronRightGlyph(props) {
      const size = (props && props.size) || 16
      return h('svg', svgBase(size, 2), h('path', { d: 'M9.5 5.5L16 12l-6.5 6.5' }))
    }

    function SpinnerGlyph(props) {
      const size = (props && props.size) || 14
      return h(
        'svg',
        svgBase(size, 2),
        h('path', { d: 'M12 3.6a8.4 8.4 0 1 1-8.4 8.4', opacity: 0.9 }),
      )
    }

    /* ==================================================================
     * 小组件
     * ================================================================== */

    function Badge(props) {
      return h(
        'span',
        { className: 'dsm-badge' + (props.tone ? ' is-' + props.tone : '') },
        props.label,
      )
    }

    function StatCard(props) {
      return h(
        'div',
        { className: 'dsm-stat' + (props.tone ? ' is-' + props.tone : '') },
        h('span', { className: 'dsm-stat-label' }, props.label),
        h('span', { className: 'dsm-stat-value' }, props.value),
        props.hint ? h('span', { className: 'dsm-stat-hint' }, props.hint) : null,
      )
    }

    /** 单行会话：一屏内横排信息，不再竖排堆叠。 */
    function SessionRow(props) {
      const t = props.t
      const item = props.item
      const selected = props.selected === true
      const busy = props.busy === true
      const title = titleOf(item)
      const cwd = safeString(item.cwd) || t('unknownCwd')

      const badges = []
      if (item.archived) badges.push(h(Badge, { key: 'archived', tone: 'archived', label: t('badgeArchived') }))
      if (item.pinned) badges.push(h(Badge, { key: 'pinned', tone: 'pinned', label: t('badgePinned') }))
      // 「运行中」只在真的执行 turn 时显示；仅仅加载在内存里（空闲、对话早已结束）
      // 用「已加载」表示，避免让人误以为对话还在跑。
      if (item.running) badges.push(h(Badge, { key: 'running', tone: 'live', label: t('badgeRunning') }))
      else if (item.live) badges.push(h(Badge, { key: 'attached', tone: 'attached', label: t('badgeAttached') }))
      if (item.origin === 'subagent') {
        badges.push(h(Badge, { key: 'sub', tone: 'sub', label: t('badgeSubagent') }))
      }

      const archiveButton = item.archived
        ? h(
            'button',
            {
              className: 'dsm-btn is-icon',
              type: 'button',
              title: t('actionUnarchive'),
              'aria-label': t('actionUnarchive'),
              disabled: busy,
              onClick: () => openDialog('unarchive', [item.sessionId]),
            },
            h(UnarchiveGlyph, { size: 15 }),
          )
        : h(
            'button',
            {
              className: 'dsm-btn is-icon',
              type: 'button',
              title: item.live ? t('liveArchiveHint') : t('actionArchive'),
              'aria-label': t('actionArchive'),
              disabled: busy,
              onClick: () => openDialog('archive', [item.sessionId]),
            },
            h(ArchiveGlyph, { size: 15 }),
          )

      return h(
        'div',
        { className: 'dsm-row' + (selected ? ' is-selected' : '') },
        h('input', {
          className: 'dsm-check',
          type: 'checkbox',
          checked: selected,
          'aria-label': t('rowSelectHint'),
          onChange: () => toggleSelection(item.sessionId),
        }),
        h(
          'div',
          { className: 'dsm-main' },
          h('div', { className: 'dsm-title', title }, title),
          h(
            'div',
            { className: 'dsm-sub' },
            h('span', { className: 'dsm-path', title: cwd }, cwd),
            h('span', { className: 'dsm-sid' }, shortId(item.sessionId)),
          ),
        ),
        h('div', { className: 'dsm-badges' }, badges),
        h(
          'div',
          { className: 'dsm-metric dsm-col-metric' },
          h('span', { className: 'dsm-metric-size' }, formatBytes(item.sizeBytes)),
          h('span', { className: 'dsm-metric-time' }, relativeTime(item.updatedAt, props.now, t)),
        ),
        h(
          'div',
          { className: 'dsm-row-actions' },
          archiveButton,
          h(
            'button',
            {
              className: 'dsm-btn is-icon is-danger',
              type: 'button',
              title: item.live ? t('liveDeleteHint') : t('actionDelete'),
              'aria-label': t('actionDelete'),
              disabled: busy,
              onClick: () => openDialog('delete-sessions', [item.sessionId]),
            },
            h(TrashGlyph, { size: 15 }),
          ),
        ),
      )
    }

    /* ==================================================================
     * 工具条 / 批量条 / 提示条
     * ================================================================== */

    function Toolbar(props) {
      const t = props.t
      const store = props.store
      const busy = Boolean(store.busy)
      const archivedCount = Number(store.stats && store.stats.archived) || 0
      const totalCount = store.items.length
      const archivedIds = store.items.filter((item) => item.archived).map((item) => item.sessionId)
      const subagentCount = store.items.filter((item) => item.origin === 'subagent').length

      const segmented = [
        ['all', 'filterAll'],
        ['active', 'filterActive'],
        ['archived', 'filterArchived'],
      ].map(([value, labelKey]) =>
        h(
          'button',
          {
            key: value,
            type: 'button',
            className: store.statusFilter === value ? 'is-active' : '',
            'aria-pressed': store.statusFilter === value,
            onClick: () => patch({ statusFilter: value, page: 1 }),
          },
          t(labelKey),
        ),
      )

      return h(
        'div',
        { className: 'dsm-toolbar' },
        h(
          'div',
          { className: 'dsm-search' },
          h(SearchGlyph, { size: 15 }),
          h('input', {
            type: 'search',
            value: store.query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchHint'),
            onChange: (event) => patch({ query: event.target.value, page: 1 }),
          }),
          store.query
            ? h(
                'button',
                {
                  className: 'dsm-search-clear',
                  type: 'button',
                  title: t('searchClear'),
                  'aria-label': t('searchClear'),
                  onClick: () => patch({ query: '' }),
                },
                h(CloseGlyph, { size: 12 }),
              )
            : null,
        ),
        h('div', { className: 'dsm-seg', role: 'group' }, segmented),
        subagentCount > 0
          ? h(
              'button',
              {
                className: 'dsm-btn' + (store.showSubagents ? ' is-on' : ''),
                type: 'button',
                title: t('subagentHint'),
                'aria-pressed': store.showSubagents,
                onClick: () => patch({ showSubagents: !store.showSubagents, page: 1 }),
              },
              store.showSubagents
                ? t('hideSubagents')
                : t('showSubagents', { n: subagentCount }),
            )
          : null,
        h(
          'div',
          { className: 'dsm-toolbar-actions' },
          h(
            'button',
            {
              className: 'dsm-btn is-danger',
              type: 'button',
              title: t('purgeHint'),
              disabled: busy || archivedCount === 0,
              onClick: () => openDialog('delete-archived', archivedIds),
            },
            h(TrashGlyph, { size: 14 }),
            t('purgeArchived'),
            h('span', { className: 'dsm-btn-count' }, String(archivedCount)),
          ),
          h(
            'button',
            {
              className: 'dsm-btn is-danger',
              type: 'button',
              title: t('deleteAllHint'),
              disabled: busy || totalCount === 0,
              onClick: () => openDialog('delete-all', store.items.map((item) => item.sessionId)),
            },
            h(AlertGlyph, { size: 14 }),
            t('deleteAll'),
            h('span', { className: 'dsm-btn-count' }, String(totalCount)),
          ),
        ),
      )
    }

    function BulkBar(props) {
      const t = props.t
      const busy = props.busy === true
      const selectedIds = props.selectedIds
      const archivable = props.items
        .filter((item) => selectedIds.indexOf(item.sessionId) >= 0 && !item.archived && !item.live)
        .map((item) => item.sessionId)

      return h(
        'div',
        { className: 'dsm-bulk' },
        h('span', { className: 'dsm-bulk-count' }, t('selectedCount', { n: selectedIds.length })),
        h('span', { className: 'dsm-bulk-spacer' }),
        h(
          'button',
          {
            className: 'dsm-btn',
            type: 'button',
            disabled: busy || archivable.length === 0,
            onClick: () => openDialog('archive', archivable),
          },
          h(ArchiveGlyph, { size: 14 }),
          t('archiveSelected'),
        ),
        h(
          'button',
          {
            className: 'dsm-btn is-danger',
            type: 'button',
            disabled: busy,
            onClick: () => openDialog('delete-sessions', selectedIds),
          },
          h(TrashGlyph, { size: 14 }),
          t('deleteSelected'),
        ),
        h(
          'button',
          { className: 'dsm-btn is-ghost', type: 'button', onClick: () => clearSelection() },
          t('clearSelection'),
        ),
      )
    }

    function NoticeBar(props) {
      const t = props.t
      const notice = props.notice
      const [open, setOpen] = React.useState(false)
      const stamp = notice && notice.at ? notice.at : 0

      // 新提示到达时收起明细；hook 必须在任何条件返回之前调用
      React.useEffect(() => {
        setOpen(false)
      }, [stamp])

      if (!notice) return null

      const details = Array.isArray(notice.details) ? notice.details : []
      const tone =
        notice.kind === 'error' ? ' is-error' : notice.kind === 'warn' ? ' is-warn' : ' is-success'

      return h(
        'div',
        { className: 'dsm-notice' + tone, role: notice.kind === 'error' ? 'alert' : 'status' },
        h(
          'div',
          { className: 'dsm-notice-body' },
          h('div', { className: 'dsm-notice-title' }, notice.title),
          open
            ? details.map((detail, index) =>
                h(
                  'div',
                  { key: index, className: 'dsm-notice-detail' },
                  detail.label + ' · ' + detail.text,
                ),
              )
            : null,
          details.length > 0
            ? h(
                'button',
                {
                  className: 'dsm-notice-link',
                  type: 'button',
                  onClick: () => setOpen((value) => !value),
                },
                open ? t('noticeDetailsHide') : t('noticeDetails', { n: details.length }),
              )
            : null,
        ),
        h(
          'button',
          {
            className: 'dsm-notice-close',
            type: 'button',
            title: t('closeHint'),
            'aria-label': t('closeHint'),
            onClick: () => patch({ notice: null }),
          },
          h(CloseGlyph, { size: 12 }),
        ),
      )
    }

    /** 分页器：一页 10 条；并支持一次选中「当前筛选结果」的全部（可跨页）。 */
    function Pager(props) {
      const t = props.t
      const page = props.page
      const pageCount = props.pageCount
      const info =
        pageCount > 1
          ? t('pageInfo', { count: props.total, page, total: pageCount })
          : t('pageInfoSingle', { count: props.total })

      const filteredIds = Array.isArray(props.filteredIds) ? props.filteredIds : []
      const allFilteredSelected =
        filteredIds.length > 0 && filteredIds.every((id) => props.selection.has(id))

      const scopeLink =
        filteredIds.length > 1
          ? h(
              'button',
              {
                className: 'dsm-link',
                type: 'button',
                onClick: () => {
                  if (allFilteredSelected) clearSelection()
                  else selectMany(filteredIds)
                },
              },
              allFilteredSelected
                ? t('clearSelection')
                : t('selectFiltered', { n: filteredIds.length }),
            )
          : null

      return h(
        'div',
        { className: 'dsm-pager' },
        h('span', { className: 'dsm-pager-info' }, info),
        scopeLink,
        pageCount > 1
          ? h(
              'div',
              { className: 'dsm-pager-actions' },
              h(
                'button',
                {
                  className: 'dsm-btn is-icon',
                  type: 'button',
                  title: t('pagePrev'),
                  'aria-label': t('pagePrev'),
                  disabled: page <= 1,
                  onClick: () => patch({ page: page - 1 }),
                },
                h(ChevronLeftGlyph, { size: 15 }),
              ),
              h('span', { className: 'dsm-pager-current' }, page + ' / ' + pageCount),
              h(
                'button',
                {
                  className: 'dsm-btn is-icon',
                  type: 'button',
                  title: t('pageNext'),
                  'aria-label': t('pageNext'),
                  disabled: page >= pageCount,
                  onClick: () => patch({ page: page + 1 }),
                },
                h(ChevronRightGlyph, { size: 15 }),
              ),
            )
          : null,
      )
    }

    /* ==================================================================
     * 主面板
     * ================================================================== */

    function SessionManagerPage(props) {
      const t = props.t
      const store = useStore()
      const [now, setNow] = React.useState(() => Date.now())

      // 打开面板即加载；load() 内部有并发去重
      React.useEffect(() => {
        load({ silent: false })
      }, [])

      // 相对时间每 30 秒刷新一次
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(timer)
      }, [])

      // 后台还在解析标题时，自动重新拉取，让标题逐批补全
      const pendingTitles = store.titlesPending
      const isBusy = Boolean(store.busy)
      React.useEffect(() => {
        if (!pendingTitles || pendingTitles <= 0) return undefined
        if (isBusy) return undefined
        const timer = setTimeout(() => load({ silent: true }), 1500)
        return () => clearTimeout(timer)
      }, [pendingTitles, store.fetchedAt, isBusy])


      const filtered = filterItems(store.items, store.query, store.statusFilter, store.showSubagents)
      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
      const page = Math.min(Math.max(1, store.page || 1), pageCount)
      const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      const selectedIds = Array.from(store.selection)

      // 删除后当前页可能越界，自动回退到最后一页，避免出现"空页"
      React.useEffect(() => {
        if (store.page > pageCount) patch({ page: pageCount })
      }, [store.page, pageCount])
      const busy = Boolean(store.busy)
      const stats = store.stats || { total: 0, active: 0, archived: 0, live: 0, bytes: 0 }
      const allSelected =
        pageItems.length > 0 && pageItems.every((item) => store.selection.has(item.sessionId))

      const hero = h(
        'header',
        { className: 'dsm-hero' },
        h('div', { className: 'dsm-hero-icon' }, h(BrandGlyph, { size: 22 })),
        h(
          'div',
          { className: 'dsm-hero-text' },
          h('h1', { className: 'dsm-hero-title' }, t('title')),
          h('p', { className: 'dsm-hero-sub' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'dsm-hero-actions' },
          h(
            'button',
            {
              className: 'dsm-btn',
              type: 'button',
              title: t('refreshHint'),
              disabled: store.loading || busy,
              onClick: () => load({ silent: false }),
            },
            store.loading
              ? h('span', { className: 'dsm-spin', style: { display: 'inline-flex' } }, h(SpinnerGlyph, { size: 14 }))
              : h(RefreshGlyph, { size: 14 }),
            t('refresh'),
          ),
        ),
      )

      const statsRow = h(
        'section',
        { className: 'dsm-stats' },
        h(StatCard, { label: t('statTotal'), value: String(stats.total) }),
        h(StatCard, {
          label: t('statActive'),
          value: String(stats.active),
          tone: stats.live > 0 ? 'live' : '',
          hint:
            stats.running > 0
              ? t('statRunningHint', { n: stats.running })
              : stats.live > 0
                ? t('statLiveHint', { n: stats.live })
                : '',
        }),
        h(StatCard, { label: t('statArchived'), value: String(stats.archived), tone: 'archived' }),
        h(StatCard, { label: t('statBytes'), value: formatBytes(stats.bytes) }),
      )

      let listArea = null
      if (!store.loaded && !store.error) {
        listArea = h(
          'div',
          { className: 'dsm-state' },
          h('div', { className: 'dsm-state-icon' }, h(SpinnerGlyph, { size: 18 })),
          h('div', { className: 'dsm-state-title' }, t('loading')),
        )
      } else if (store.error) {
        listArea = h(
          'div',
          { className: 'dsm-state' },
          h('div', { className: 'dsm-state-icon' }, h(AlertGlyph, { size: 18 })),
          h('div', { className: 'dsm-state-title' }, t('loadFailed')),
          h('div', { className: 'dsm-state-hint' }, store.error),
          h(
            'button',
            { className: 'dsm-btn', type: 'button', onClick: () => load({ silent: false }) },
            t('retry'),
          ),
        )
      } else if (filtered.length === 0) {
        const hasFilter = Boolean(store.query) || store.statusFilter !== 'all'
        listArea = h(
          'div',
          { className: 'dsm-state' },
          h('div', { className: 'dsm-state-icon' }, h(InboxGlyph, { size: 18 })),
          h('div', { className: 'dsm-state-title' }, t(hasFilter ? 'emptyFilteredTitle' : 'emptyTitle')),
          h('div', { className: 'dsm-state-hint' }, t(hasFilter ? 'emptyFilteredHint' : 'emptyHint')),
        )
      } else {
        const head = h(
          'div',
          { className: 'dsm-listhead' },
          h('input', {
            className: 'dsm-check',
            type: 'checkbox',
            checked: allSelected,
            'aria-label': t('selectAll'),
            onChange: () => {
              if (allSelected) clearSelection()
              else selectMany(pageItems.map((item) => item.sessionId))
            },
          }),
          h('span', null, t('columnSession')),
          h('span', { className: 'dsm-al-right' }, t('columnStatus')),
          h('span', { className: 'dsm-al-right dsm-col-metric' }, t('columnSize')),
          h('span', { className: 'dsm-al-right' }, t('columnActions')),
        )
        const rows = pageItems.map((item) =>
          h(SessionRow, {
            key: item.sessionId,
            item,
            t,
            now,
            busy,
            selected: store.selection.has(item.sessionId),
          }),
        )
        listArea = h('section', { className: 'dsm-listcard' }, head, rows)
      }

      // 分页器独立于列表卡、吸附在滚动区底部：列表再长也始终可见
      const pager =
        filtered.length > 0
          ? h(Pager, {
              t,
              page,
              pageCount,
              total: filtered.length,
              filteredIds: filtered.map((item) => item.sessionId),
              selection: store.selection,
            })
          : null

      const bulk = selectedIds.length > 0
        ? h(BulkBar, { t, busy, selectedIds, items: store.items })
        : null

      // 分页器/批量条放在滚动区之外：粘在滚动内容里会盖住列表最后一行，
      // 造成"一页本该 10 条却只看到 9 条"的假象。
      const footer = pager || bulk ? h('div', { className: 'dsm-footer' }, bulk, pager) : null

      return h(
        'div',
        { className: 'dsm-root' },
        h('style', { key: 'dsm-css' }, CSS),
        h(
          'div',
          { className: 'dsm-scroll' },
          hero,
          statsRow,
          h(Toolbar, { t, store }),
          h(NoticeBar, { t, notice: store.notice }),
          listArea,
        ),
        footer,
      )
    }

    /* ==================================================================
     * 确认对话框（点击确认即执行）
     * ================================================================== */

    function dialogTitleKey(kind) {
      if (kind === 'archive') return 'dialogArchiveTitle'
      if (kind === 'unarchive') return 'dialogUnarchiveTitle'
      if (kind === 'delete-archived') return 'dialogPurgeTitle'
      if (kind === 'delete-all') return 'dialogDeleteAllTitle'
      return 'dialogDeleteTitle'
    }

    function dialogDescKey(kind) {
      if (kind === 'archive') return 'dialogArchiveDesc'
      if (kind === 'unarchive') return 'dialogUnarchiveDesc'
      if (kind === 'delete-archived') return 'dialogPurgeDesc'
      if (kind === 'delete-all') return 'dialogDeleteAllDesc'
      return 'dialogDeleteDesc'
    }

    function confirmLabelKey(kind) {
      if (kind === 'archive') return 'confirmArchive'
      if (kind === 'unarchive') return 'confirmUnarchive'
      if (kind === 'delete-archived') return 'confirmPurge'
      if (kind === 'delete-all') return 'confirmDeleteAll'
      return 'confirmDelete'
    }

    function ConfirmOverlay(props) {
      const t = props.t
      const store = useStore()
      const dialog = store.dialog
      const cancelRef = React.useRef(null)
      const confirmRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      const dialogKey = dialog ? dialog.key : ''

      // 打开时把焦点放在"取消"上：误按回车也不会直接删除
      React.useEffect(() => {
        if (!dialogKey) return undefined
        try {
          restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null
        } catch (error) {
          restoreRef.current = null
        }
        const timer = setTimeout(() => {
          const target = cancelRef.current || confirmRef.current
          if (target && typeof target.focus === 'function') {
            try {
              target.focus()
            } catch (error) {
              /* 焦点失败不影响可用性 */
            }
          }
        }, 0)
        return () => {
          clearTimeout(timer)
          const previous = restoreRef.current
          if (previous && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch (error) {
              /* 忽略 */
            }
          }
        }
      }, [dialogKey])

      if (!dialog) return null

      const isDelete = dialog.kind.indexOf('delete') === 0
      const labels = Array.isArray(dialog.labels) ? dialog.labels : []
      const sizes = Array.isArray(dialog.sizes) ? dialog.sizes : []
      const preview = labels.slice(0, 5)

      const scopeItems = preview.map((label, index) =>
        h(
          'li',
          { key: index, className: 'dsm-scope-item' },
          h('span', { className: 'dsm-scope-name', title: label }, label),
          h('span', { className: 'dsm-scope-size' }, formatBytes(sizes[index] || 0)),
        ),
      )

      const scopeCard = h(
        'div',
        { className: 'dsm-scope' },
        h(
          'div',
          { className: 'dsm-scope-head' },
          h('span', null, t('scopeTitle')),
          h('span', null, t('scopeCount', { n: dialog.ids.length })),
        ),
        labels.length === 0
          ? h('div', { className: 'dsm-scope-foot' }, t('scopeEmpty'))
          : h('ul', { className: 'dsm-scope-list' }, scopeItems),
        labels.length > preview.length
          ? h('div', { className: 'dsm-scope-foot' }, t('scopeMore', { n: labels.length }))
          : null,
        h(
          'div',
          { className: 'dsm-scope-foot' },
          h('span', null, t('scopeBytes', { size: formatBytes(dialog.bytes) })),
          dialog.liveCount > 0
            ? h('span', { className: 'dsm-scope-live' }, t('scopeLiveNote', { n: dialog.liveCount }))
            : null,
        ),
      )

      return h(
        'div',
        {
          className: 'dsm-backdrop',
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeDialog()
            }
          },
        },
        h('style', { key: 'dsm-css-overlay' }, CSS),
        h(
          'div',
          {
            className: 'dsm-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsm-dialog-title',
          },
          h(
            'div',
            { className: 'dsm-dialog-head' },
            h(
              'div',
              { className: 'dsm-dialog-icon' + (isDelete ? '' : ' is-neutral') },
              isDelete ? h(AlertGlyph, { size: 17 }) : h(ShieldGlyph, { size: 17 }),
            ),
            h('div', { id: 'dsm-dialog-title', className: 'dsm-dialog-title' }, t(dialogTitleKey(dialog.kind))),
          ),
          h('div', { className: 'dsm-dialog-body' }, t(dialogDescKey(dialog.kind))),
          scopeCard,
          dialog.error
            ? h('div', { className: 'dsm-dialog-error', role: 'alert' }, dialog.error)
            : null,
          h(
            'div',
            { className: 'dsm-dialog-foot' },
            h('span', { className: 'dsm-dialog-hint' }, isDelete ? t('dialogIrreversible') : ''),
            h(
              'button',
              {
                ref: cancelRef,
                className: 'dsm-btn is-ghost',
                type: 'button',
                disabled: dialog.busy,
                onClick: () => closeDialog(),
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                ref: confirmRef,
                className: 'dsm-btn' + (isDelete ? ' is-primary' : ''),
                type: 'button',
                disabled: dialog.busy,
                onClick: () => performAction(dialog.kind, dialog.ids),
              },
              dialog.busy ? t('busyWorking') : t(confirmLabelKey(dialog.kind)),
            ),
          ),
        ),
      )
    }

    function PanelEntry(props) {
      const t = props.t
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            color: 'inherit',
          },
          'aria-hidden': 'true',
        },
        h(BrandGlyph, { size: Math.max(14, size - 2) }),
      )
    }

    /* ==================================================================
     * 错误边界：任何渲染异常都不应让插槽变空
     * ================================================================== */

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-session-manager] render failed', error, info)
      }

      render() {
        if (this.state.failed) {
          return h('div', { className: 'dshsm-fallback', role: 'alert' }, this.props.message)
        }
        return this.props.children
      }
    }

    /* ==================================================================
     * 相对时间（等宽数字，按 locale 输出）
     * ================================================================== */

    function relativeTime(timestamp, now, t) {
      const time = Number(timestamp)
      if (!isFinite(time) || time <= 0) return t('unknownTime')
      const diff = Math.max(0, now - time)
      const seconds = Math.floor(diff / 1000)
      if (seconds < 45) return t('justNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes <= 1 ? t('minuteAgo') : t('minutesAgo', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours <= 1 ? t('hourAgo') : t('hoursAgo', { n: hours })
      const days = Math.round(hours / 24)
      if (days < 30) return days <= 1 ? t('dayAgo') : t('daysAgo', { n: days })
      const months = Math.round(days / 30)
      if (months < 12) return months <= 1 ? t('monthAgo') : t('monthsAgo', { n: months })
      const years = Math.round(months / 12)
      return years <= 1 ? t('yearAgo') : t('yearsAgo', { n: years })
    }

    /* ==================================================================
     * 插件装配
     * ================================================================== */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')

        const translate = (() => {
          try {
            return locale ? locale.bind(NS) : null
          } catch (error) {
            return null
          }
        })()

        function activeLocale() {
          if (locale) {
            try {
              return locale.getLocale().active || ''
            } catch (error) {
              /* 回落到 document 提示 */
            }
          }
          if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
            return document.documentElement.lang
          }
          return (typeof navigator !== 'undefined' && navigator.language) || ''
        }

        function dict() {
          return String(activeLocale()).toLowerCase().startsWith('zh') ? zh : en
        }

        function interpolate(text, params) {
          if (!params) return text
          let out = String(text)
          for (const key of Object.keys(params)) {
            out = out.split('{' + key + '}').join(String(params[key]))
          }
          return out
        }

        // 赋值而非声明：让模块级函数也能用到绑定 locale 的实现
        t = function (key, params) {
          let text = ''
          if (translate) {
            try {
              const value = translate(key)
              if (value && value !== key) text = value
            } catch (error) {
              /* 回落到内置词典 */
            }
          }
          if (!text) text = dict()[key] || key
          return interpolate(text, params)
        }

        // 注册 locale 词典与订阅；卸载时由 ctx.effect 清理
        if (locale) {
          try {
            ctx.effect(() => locale.register(NS, 'zh', zh))
            ctx.effect(() => locale.register(NS, 'en', en))
            ctx.effect(() =>
              locale.subscribe(() => {
                notify()
              }),
            )
          } catch (error) {
            console.error('[dsh-session-manager] locale registration failed', error)
          }
        }

        const renderMessage = () => {
          try {
            return t('renderFailed')
          } catch (error) {
            return 'render failed'
          }
        }

        // main：整页面板（点击侧栏入口后由宿主切换到这里）
        function PageRoot() {
          return h(Boundary, { message: renderMessage() }, h(SessionManagerPage, { t }))
        }

        // shell.overlay：二次确认对话框，层级高于面板且不被裁剪
        function OverlayRoot() {
          return h(Boundary, { message: renderMessage() }, h(ConfirmOverlay, { t }))
        }

        function EntryRoot(props) {
          return h(Boundary, { message: '' }, h(PanelEntry, { t, size: props && props.size }))
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: ID,
              order: 50,
              // thunk：语言切换后重新取词
              label: () => t('open'),
            },
            EntryRoot,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: ID,
            },
            PageRoot,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: ID,
            },
            OverlayRoot,
          ),
        )
      },
    }
  },
})