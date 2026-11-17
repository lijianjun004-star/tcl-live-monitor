# R3.6 抖音监控复刻｜真实来源/REA 对账与独立安全适配

日期：2026-11-11（北京时间）；目标仓库 `lijianjun004-star/tcl-live-monitor`。

## 一、用户提供 URL 的真实含义

`http://101.96.215.251/?start=2026-10-21&end=2026-10-21&platform=jd&category=全品类&shop_id=17`

这是 **2026-10-21、京东、内部 shop_id=17** 的参考页，不是抖音房间 URL；不得将其 `shop_id` 转成抖音 `secUid` 或房间 ID。

本地容器直接 HTTP 拒绝连接；另一个只读浏览器工具收到 403。不得绕过登录、验证码、风控。与此同时，仓库另外两个隔离实验 PR 的原生 GitHub runner 已记录真实只读证据，如下。

## 二、其它已有的独立 R3.6 证据（必须区分）

- PR [#60](https://github.com/lijianjun004-star/tcl-live-monitor/pull/60) 的云端 API 只读核验 [#43015295953](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015295953) 报告：
  - 原站 GET 已知 `/api/capture/rooms` 发现 `jd=7,douyin=10`。
  - `roomsFound=10`, `shopsFound=10`, `linkedRooms=10`，**捕获会话绑定 `boundRooms=1`**。
  - `testedDailyRooms=4`，每日结果 `days[]` 4/4 符合；
  - `catalogScope=API_RESPONSE_NOT_PROVEN_EXHAUSTIVE`；`realTimeStatus=UNKNOWN`，`offlineValidated=false`，`fullCloneVerified=false`。
  - 不保留原始接口 body、认证信息，公共仓库只保存匿名化摘要。
- PR [#60](https://github.com/lijianjun004-star/tcl-live-monitor/pull/60) 的原站 JS / REA 云端任务 [#43015670761](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015670761)：实际获取 1 份 106391 字节的同源 JS，使用官方 `morluto/rea` 工具分析。仅能确认抖音、店铺等字符串/模块存在，不代表已提取完整界面及后台算法。
- 其进一步只读 JS 字段核验 [#43016108653](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43016108653) 发现 `店铺管理`、`直播间`、`排班`、`日期` 标签与计时器迹象；**未证明**前端请求图和抖音状态协议精确字段。
- PR [#59](https://github.com/lijianjun004-star/tcl-live-monitor/pull/59) 的公开访客核验 [#43015156078](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015156078)：2 个账号公开主页 HTTP200，存在真实直播入口，但直播间身份未完成二次校验，因此 2 UNKNOWN / 0 VERIFIED LIVE。
- 主仓库 `config/probe-targets.json` 共有 **12 个已批准抖音账号**，其中 4 个 `scoringEligible=true`，其余只监控不可自动入考核。
- **10 个内部 OPS 房间 与 12 个公开抖音账号之间没有经验证的一对一映射**，不能按排序、店铺名字或数字碰巧相同强行匹配。

## 三、本 PR #61 新增的互补模块

`probes/r36/douyin-ops-parity.mjs`：

1. 仅复用已由现有项目代码证实存在的 GET 来源：`/api/capture/rooms`, `/api/shops`, `/api/assistant/active-rooms`, `/api/capture/room-overview/daily`；这个纯模块使用注入的 read-only reader，**不会发出网络请求**。
2. 对来源中真实返回的 `dy`/`douyin`/`抖音` 平台值进行有限识别，严格隔离 JD 同数字 roomId；不假装已经独立验证所有别名。
3. 只保留内部 roomId、shopId、品类枚举、捕获绑定真假、采样状态和时间；不序列化 `bound_session_key`、主播身份、商业数据、Cookie/Token 或原始 API body。
4. `minute_count + fresh last_minute + live status + fresh heartbeat + captureBound` 才将 **TCL OPS 内部来源**标记 LIVE；这个 LIVE 不等于平台公开页面交叉验证成功。
5. 来源失败/目录缺失/绑定失效/超时/采集停顿一律 UNKNOWN；OFFLINE 只能形成候选，不转为正式 OFFLINE，也不写准确上下播时间或正式满播率。
6. 店铺关联只凭 OPS 来源 `shop_id` 精确匹配，**绝不能推导**公开抖音账号 `secUid`、显示 ID 或直播房间 ID 与 OPS 的关系。
7. 当总数、分页、数据不完整时拒绝宣布全部直播间已找到。输出 `exhaustive=false` 与 `formalOpeningRatePercent=null`。
8. 使用 `tests/r36-douyin-ops-parity.test.mjs` 的 18 个专项测试，加上完整原有回归，在 GitHub 独立 CI 验证。只做离线验证、不得向原站自动轰炸。

## 四、下一阶段“复刻完整性”门禁

| 项目 | 证据状态 |
|---|---|
| 原始链接的平台、日期、shop_id 解析 | 已确认 |
| 源站抖音内部房间/店铺数量与日数据结构 | 已有只读证据，目录不一定完整 |
| 静态 JS 的 REA 分析 | 已经执行，只有部份字符串与语义证据 |
| 公共抖音账号双向身份验证 | 2 个样本未通过直播间身份交叉验证 |
| 10 内部房间 ↔ 12 公共账号映射 | 未验证 |
| 抖音 LIVE/OFFLINE 真值与实际起止时间 | 未验证 |
| 原站抖音 UI 1:1 像素/交互复刻 | 未验证 |
| 真人分钟数/满播率正式考核 | 不可计算 |

## 五、安全边界与合流建议

- 本 PR 为 **独立草稿，不合并 main**。京东 R3.5、7 天历史、所有 Pages 与其他仓库绝对不动。
- 推荐将 PR #60 的 **真实 API schema/REA**、PR #59 的 **公开账号/直播间证据**、本 PR 的 **安全状态归一化** 作为三条独立证据链，逐字段复核，再建立统一源适配层。
- 未拿到授权截图或前端网络结构时，不宣称已 1:1 还原原站布局及实际业务逻辑，不让 UNKNOWN 产生考核扣分。
- 用户此前已确定三平台：京东/天猫/抖音；本轮仅做抖音独立实验，不扩其他平台。
