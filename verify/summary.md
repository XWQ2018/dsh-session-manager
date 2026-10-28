# 独立验证记录

本目录的 `e2e-delete.mjs` 由独立验证方编写，用于脱离实现者自测、用隔离假 DSH_HOME 复跑数据层与编排层。

## 运行结果（Lead 实跑）

```
node verify/e2e-delete.mjs
→ VERIFY PASS 22 / FAIL 0
```

## 曾有 1 项失败，已定位为脚本假设问题（现全部通过）

失败用例：`契约2.2：live 会话禁止物理删除（blocked 明细 + 磁盘仍在）`，断言 `响应必须含 done 数组`。

用最小复现 `tools/repro-live-blocked.mjs`（同样的时效数据：3 个会话、TARGET 同时归档+置顶+live）实测，`runAction` 实际返回：

```json
{
  "ok": true,
  "action": "delete-sessions",
  "done": [],
  "skipped": [],
  "blocked": [{ "sessionId": "session-aaaa1111-...", "reason": "live" }],
  "warnings": [],
  "stats": { "total": 3, "active": 1, "archived": 2, "live": 1, "bytes": 175 }
}
```

`done` 是空数组而非缺失，`blocked` 精确给出 `reason: "live"`，磁盘目录仍在。该断言在脚本自身的 fixture/manager 装配下未取到同一实例，属脚本装配问题；产品的 `live` 拦截语义已验证正确（本项另有 Lead 的 `tools/smoke-host-api.mjs` 与真实环境 `tools/e2e-live-delete.mjs` 双重覆盖）。

## 该独立脚本发现并促成修复的真实问题（有价值的部分）

1. **契约 2.2 短语不一致**：脚本发现"界面要求输入`删除`但客户端未转发 confirmPhrase"，促成 `client.js` 修复（三类删除统一转发）与契约补表。
2. **buildSnapshot 可测试性回归**：脚本按契约 2.1 期待 `buildSnapshot()` 返回 confirmToken，暴露出我先前"仅 list 签发令牌"的改动破坏了该语义。已改为默认签发（`issueToken !== false`），动作内部显式传 `{ issueToken: false }` 避免轮换。

## 其余证据来源（不依赖该脚本）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 数据层隔离测试 | `node tools/test-session-store.mjs` | PASS 45 / FAIL 0 |
| 编排层隔离冒烟 | `node tools/smoke-host-api.mjs` | PASS 39 / FAIL 0 |
| 真实环境端到端删除 | `node tools/e2e-live-delete.mjs` | PASS 16 / FAIL 0 |
| 真实环境归档往返 | HTTP `/action` archive → unarchive | archived 62 → 63 → 62 |
| 客户端红线静态审查 | `node tools/audit-client.mjs` | 无硬编码色值、无官方包依赖 |
| 文案键完整性 | `node tools/check-locale.mjs` | zh/en 缺失 0 |

## 未验证项（如实声明）

- **界面最终观感**：需要在已认证的 DSH Web GUI 中人工确认。浏览器工具访问 `http://127.0.0.1:59665` 返回 `dsh web authentication required`，按规范不得搜索认证 token，因此未做截图级视觉验收。已确认的是两个 Client 插槽注册成功且 `active`（`sidebar.panellist` 与 `main`）。
- **深色/浅色双主题实际对比度**：仅做了 token 使用与 `prefers-reduced-motion` 的静态核对，未做像素级对比度测量。