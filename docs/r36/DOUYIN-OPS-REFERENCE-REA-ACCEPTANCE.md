# R3.6｜TCL OPS 抖音业务来源：受限只读证据核验

## 目标和重要边界
用户提供页面：`http://101.96.215.251/?start=2026-10-21&end=2026-10-21&platform=jd&category=全品类&shop_id=17`。
其参数**证明该链接筛选的是 JD，不是 Douyin**。不得将 JD 的内部 `shop_id=17` 解释为抖音账号或直播间 ID。

2026-11-11 实测：
- container direct HTTP TCP 连接拒绝；
- 第三方网页只读读取返回 403；
- 未得到目标站点的 HTML、JS Bundle 或真实抖音标签页，因此未完成 REA 对目标网站的静态 JS 分析。403 即停止，不通过代理、伪装账号、验证码规避或凭证重放访问。
- 已核对仓库既存 TCL OPS 调用代码 `probes/tcl-ops-data-shape.mjs`、`probes/tcl-ops-fetch.mjs`、`probes/lib/tcl-jd-all.mjs`：**确实曾使用** `/api/capture/rooms`、`/api/shops`、`/api/capture/room-overview/daily`、`/api/assistant/active-rooms`。不过这些代码不等于已核实目标的抖音数据结构。
- 已核对 `config/probe-targets.json`：12 个既有 Douyin 账号登记，既有 `probes/lib/douyin.mjs` 对公开主页 LIVE/UNKNOWN 的安全判定，**并非目标内部 `shop_id` 的身份对账**。
- 官方 REA 开源仓库：https://github.com/morluto/rea （`rea-agents`）；目前未下载到目标站点 JS，不应虚称 REA 已还原目标网站。

## 本独立实验提供的能力
- `probes/r36/douyin-ops-qa.mjs`：仅以 GET 查询**已经在本仓库中存在的**业务来源路径。读 /api/capture/rooms、可选 /api/shops、至多 4 个抖音房间的历史每日结构。禁止任何未知路径、POST、登录、重试或绕风控。
- 不先假设平台代码。只有真实目录条目 `platform=dy`、`douyin`、`抖音` 才作为抖音候选；输出汇总包括来源返回的各平台代码计数。
- 统计记录结构，不公开原始 JSON、session_key、账号、房间内部 ID、成交额、采集细节与店铺名称。**公共 GitHub 仓库中不保存敏感源响应。**
- 对于历史 `2026-10-21` 的 `minute_count`、`session_count`，只确认字段是否存在，不推断当前 LIVE/OFFLINE、精确开播／下播时间或真实满播率。
- 单次验收工作流由专用 QA 分支特定标记触发，仅运行一次。其他 push、PR 均无源访问。受限或 403 立即停止。

## 真实复刻门禁
A. **平台码、目标 JS/CSS、目标导航与页面结构证据**：目标页面可访问并允许只读分析后才能复刻 UI 到 1:1；目前 BLOCKED。
B. **抖音房间身份映射**：真实内部 `platform` 与 `live_room_id` 对应外部 secUid 及经核实的抖音账号，冲突先 UNKNOWN，不能自动合并。
C. **采集规则**：真实历史样本 / 采集心跳与来源 status 解释需在真人开播和停播例子上做负例实测，`UNKNOWN` 不得当 OFFLINE。
D. **巡检时序**：必须证明 GitHub 真实 schedule/独立调度；所有片段统计先标为观察区间而非精确满播率。
E. **发布保护**：`tcl-live-monitor` 的现有京东 R3.5 MAIN、Pages、7 天滚动数据不得改动。本分支只能 PR 草稿，不直接合并或覆盖。

REA 可在获得合法授权的目标 `/assets/*.js` 原始静态 JS 后（无破解访问），对下载的文件做静态分析。不能以已有 JD 采集器反推某个未知抖音 API 的确定参数。
