# Agent B — 淘宝/天猫公开来源与场次发现

任务：TCL R1.8，2026-11-08。执行者：实际子智能体 `/root/b_tmall`。

## 已交付

- `probes/r18/sources/tmall/index.mjs`：ESM、Node 内置 fetch、无新增依赖。
- `observe(options)`：对固定账号公开页执行一次 GET；不重试、不跟随登录重定向、不访问受保护接口。
- `parsePage(options)`：静态 HTML 不足以证明当前目标直播状态，始终 UNKNOWN；识别登录/验证码/429/403/网络错误。
- `parsePassiveResponse(options)`：只解析正常浏览器加载已经收到的 response，绝不构造或重放请求。固定账号身份、目标页面、响应 origin/path、status=200、90 秒捕获时效和可信传输标记均为必要条件。验证 broadCaster.accountId、账号名、data.accountId、房间一致性及 liveId 格式。推荐标记直接拒绝。
- 来源未证明则 `source_attested=false`，失败不变成 OFFLINE。
- 不以历史 room 130742 为当前房间要求。同一账号新 liveId 输出新值供会话状态机建新场次；B 不重复维护另一套会话状态。

## 对外接口

```js
import { observe, parsePage, parsePassiveResponse } from './probes/r18/sources/tmall/index.mjs';
await observe({ planned_check_at, actual_check_at, evidence_ref });
parsePassiveResponse({ payload, page_url, response_url, captured_at,
  planned_check_at, actual_check_at, transport_attested: true, status: 200 });
```

`response_url` 只需 origin + pathname，不需保存带签名查询。`transport_attested` 只能由可信浏览器捕获层赋值；导入任意 JSON 自称 true 不构成来源证明。正常会话的捕获关联由 C/主控整合；本轮未执行真实已登录浏览器链路。

## 真实核验

证据：`docs/r18/evidence/tmall/public-page-check.json`。

| 项目 | 结果 | 解释 |
|---|---|---|
| 淘宝固定账号公开页 | BLOCKED | 2026-11-08T11:47:34.688Z，单次普通 GET，运行时 fetch 在收到 HTTP 响应前失败；NETWORK_ERROR。未重试。不能认定是平台验证码，也不能判停播。 |
| 淘宝已登录会话 | NOT_EXECUTED | 本子任务未获得用户正常登录会话。 |
| 淘宝新 liveId 真实发现 | NOT_EXECUTED | 未获得可信实时详情响应。 |
| 正常页面被动响应捕获 | NOT_EXECUTED | 解析函数完成，真实浏览器链路尚未验证。 |

## 本地验证

已实际执行 8 条针对性断言：有效合成 LIVE、非历史房间号、缺传输证明、过期捕获、推荐直播拒绝、正文推荐不误判、验证码 UNKNOWN、429 冷却原因，全部 PASS。它们是离线合成验证，不能替代真实平台验收。全量测试由 F/主控执行。

## 限制与下一锁

公开页面网络路径先被阻断。下一锁建议在可正常访问的平台浏览器环境中，由用户本人完成登录后，验证一次正常页面加载及其被动详情响应。不要升级到签名伪造、验证码破解、代理轮换或开发者 AppKey/TMC。

未复制第三方源码；复用本仓库现有 `classifyTmall` / `parseJSONOrJSONP`。没有保存 Cookie、token、原始响应正文或截图。
