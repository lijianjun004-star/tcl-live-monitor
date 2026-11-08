# Agent C — 正常浏览器会话与人工介入

执行日期：2026-11-08。范围：独占 `probes/r18/browser/session.mjs`；未安装依赖、未登录平台、未启动生产任务。

## 成果与接口

- `resolveProfilePath(profileDir)`：默认 `~/.local/share/tcl-live-monitor/r18/profiles/default`，在 checkout 外保存用户自己的 Profile；拒绝任何 Git 仓库内路径（包括符号链接所指位置）。Profile 不进入项目工作树，无 Cookie、密码或 session 内容写入报告。
- `openSession({profileDir,headless=false,playwrightModule,audit})`：可选动态导入 Playwright，以正常 `launchPersistentContext` 复用同一 Profile；缺依赖返回 `BLOCKED/BROWSER_DEPENDENCY_UNAVAILABLE`，浏览器启动失败返回 `BLOCKED/BROWSER_SESSION_UNAVAILABLE`。默认 headed 模式可供用户本人正常登录；本模块不接受登录密码或验证码参数。
- `classifyAccess({status,url,text})`：403/安全挑战为 `HUMAN_VERIFICATION_REQUIRED`，429/频控为 `PLATFORM_THROTTLED`，401/登录失效为 `AUTH_REQUIRED`。没有错误标志不代表获得可采信直播状态。
- `safeBrowserCheck({...})`：只导航一次 HTTPS 淘宝/天猫/京东/抖音公开页面，阻断后返回 `UNKNOWN` 并关闭会话，不循环重试。需要后续人工处理时，在用户自己的正常浏览器中完成；再次使用同一外置 Profile 才能恢复，不自动操作挑战或调用隐藏接口。
- `watchResponses(page,{onResponse,audit})`：被动监听本次正常页面自然加载响应；不发出额外请求。回调提供 `data/status/captured_at/response_url/page_url/url_summary`，原始 JSON/JSONP 只短暂在内存传递供身份校验。只有已知 livedetail 路径可返回无 query 的完整 endpoint，其余 URL 仅保留 origin。审计仅事件、时间、HTTP 状态、域名，不写 Cookie、URL query、headers、页面正文、profile 路径或响应体。
- 页面解析与身份核验交由 B 的 adapter；只有正常页面加载成功不设 `source_attested=true`。

## 实际执行证据

执行了 `node --check probes/r18/browser/session.mjs`，PASS。

执行 Node 内置 assert 冒烟检查：403、429、登录提示、普通直播文案、URL query 脱敏、仓库内 Profile 拒绝、不允许域名拒绝、可选浏览器依赖检查，共 8 项，PASS。最后一项实际返回：`BROWSER_DEPENDENCY_UNAVAILABLE`；这是依赖阻断证据，并非真实浏览器端到端通过。

| 核验 | 状态 | 说明 |
|---|---|---|
| 纯函数及接口冒烟 | PASS | 本地 Node 断言 |
| 持久化真实浏览器启动 | BLOCKED | 当前缺 Playwright 依赖 |
| 用户已登录淘宝会话 | NOT_EXECUTED | 未提供用户已登录 Profile；没有索取密码、验证码或 Cookie |
| 人工验证后的同会话恢复 | NOT_EXECUTED | 需要用户本人完成正常验证；没有模拟成成功 |
| 真实被动 livedetail 响应 | NOT_EXECUTED | 无真实浏览器会话，不以 fixture 冒充 |

## 限制与下一锁

本轮未以外部项目源码作为依赖，也未复制其代码。这里是可测的正常浏览器会话接口，不是已完成的淘宝登录或自动发现验收。下一锁是：在用户可交互且已安装正常浏览器的环境，用用户自己的外置 Profile，人工完成登录后只读打开固定账号页面一次，再保存脱敏状态/时间与身份核验结果；遇验证或频控立即停止。

## 主控集成复核后的增量

增加 `probes/r18/browser/tmall-session.mjs`，导出 `observeTmallSession(options)` 连接 B 的 `parsePassiveResponse`，以及纯函数 `resolveSessionEvidence`。仅实际浏览器 response 事件的调用层设置 transport attestation；所有候选在读取响应后使用新的实际时间核验。最终页面若有阻断，不进入候选解析回调。调用 `onPage` 前已等待已接收的响应处理结束，避免异步证据未完成。

同一 account、state、liveId 的 room 变化保留为同一场候选；同次页面出现不同 liveId 或 LIVE/OFFLINE 矛盾则返回 `UNKNOWN/CONFLICTING_EVIDENCE`；验证码、登录或频控响应覆盖所有有效候选。没有合格候选为 UNKNOWN。

追加 7 项 Node assert 检查 PASS：同 liveId room 变化、不同 liveId 冲突、LIVE/OFFLINE 冲突、认证阻断覆盖、无候选、真实依赖检查的 UNKNOWN 状态和具体 dependency failure。没有运行真实平台会话。当前只收集页面 DOMContentLoaded 前及其已经触发的响应，不宣称可以捕获页面加载很久后才发出的直播响应。
