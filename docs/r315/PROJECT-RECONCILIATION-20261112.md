# TCL 直播监控项目核对｜资料、代码与运行证据对账

核对日期：2026-11-12  
仓库：`lijianjun004-star/tcl-live-monitor`  
本报告仅依据用户上传的三份项目资料、当前 GitHub 源码/PR/Actions 日志及当前对话已明确的业务要求。没有访问旧 HTTP 业务源、没有访问真实平台、没有触发生产任务。

## 1. 核对结论

**当前项目处于“已有可用的京东历史巡检链路 + 抖音内部数据来源实验 + 多条未合并身份/RPA/REA草稿 + R3.15离线安全修复”的状态，不是已经完成三平台真实直播场次识别。**

| 能力 | 已有证据 | 实际成熟度 |
|---|---|---|
| 京东内部来源只读采集 | main 上的 R2.3/R3.3 workflow，历史真实 schedule 成功 | 有真实运行，但采样间隔不稳定、来源 PARTIAL |
| 抖音内部房店目录 | R3.6/R3.11/R3.14 单次真实来源读取 | 10 房/10 店/10 配对，目录不完整、只有 1 房 bound |
| REA | 读取到 1 个 JS bundle（106,391 bytes），但日志明确写目标静态 JS 访问受阻 | 有限静态资源观察；未完成目标系统完整逆向 |
| RPA | R3.8/R3.9 真实公开访客浏览器单次观测 | 页面可访问，但直播间身份未验证，UNKNOWN |
| 公开账号映射 | 12 个批准账号候选 + 内部店铺名称候选 | 0 条四层可信桥接 |
| 真人/数字人分类 | 上传资料里有业务规则和回放抽样建议 | 尚未接入状态/场次数据模型 |
| 10 分钟中断计数 | 需求存在 | 当前未实现可信计数 |
| R3.15 新采集链路 | 离线 reader/aggregate/RPA policy/hourly gate | 尚未接入真实业务来源与自动调度 |
| 24–48h 自动运行 | 无 R3.15 schedule 工作流 | 未开始 |

## 2. 用户资料中的业务规则

### 2.1 平台真人/数字人运营规则（来源：执行验收总结.txt）

| 平台 | 用户提供的内部业务情况 | 系统应如何使用 |
|---|---|---|
| 淘宝/天猫 | 使用麦兔数字人，数字人形象固定；真人主播会轮换 | 观察主播轮换、数字人形象和混合时段；不以单一画面直接判定 |
| 京东 | 数字人形象通常固定，不中途换人 | 轮换是“含真人内容”的强证据；固定形象仅是数字人候选 |
| 抖音 | 用户确认 TCL 抖音直播业务不使用数字人 | 这是 TCL 业务规则，不等同于平台全局规则 |

文件明确提出：
- 不同真人出镜可以增强真人内容判定，但仍要排除真人录播；
- 一直只有一个人但没有数字人特征，结果应待确认；
- 无完整回放时为 UNKNOWN；
- 回放首轮每 30 分钟抽帧，发现人物变化后再检查前后 5–10 分钟；
- 场次时间与内容类型分开记录；不需要识别主播真实姓名。

**补充冲突/更新点：** 当前对话较新的业务说明为“数字人只会下播后开启，不会在上播使用”。该说法涉及“真人主播结束后数字人接续”还是“直播间下播后另行启用”，现有上传资料不能消除语义歧义。系统不应先把它写成硬编码，需在后续业务规则确认后按时间段建模。无论如何，真人/数字人是内容分段属性，不能直接替代 LIVE/OFFLINE 状态。

### 2.2 RPA/开源研究边界（来源：区分真人数字人直播.txt）

资料列出的 Taobao Scraper、OpenBrowser、Fideo Live Record、kktbur、Chrome 插件是研究候选，不是已集成依赖。资料同时明确：
- 可研究正常浏览器会话复用、持久化 Cookie 管理、频率控制、缓存、退避重试、人工完成验证码后继续；
- 不采用伪造设备指纹、隐藏自动化身份、破解验证码、绕过访问控制、伪造签名、盗用 Cookie/凭证；
- Fideo Live Record 的 AGPL-3.0 及签名请求实现不应直接移植到闭源商用代码；
- Taobao Scraper 文档所述反封禁模块和非商业限制不应直接作为 TCL 商业生产基础。

当前 R3.7/R3.8 实际采用公开访客模式，没有实现资料所述的持久化登录会话。开源研究与实际工程集成必须区分。

### 2.3 抖音来源数据（来源：完善直播监控.txt，并由 Actions 复核）

R3.6真实运行 [#43015295953](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015295953) 输出：
- 内部抖音房间 10；
- 内部店铺 10；
- 内部房店关联 10/10；
- 已有采集绑定 1；
- 每日数据结构抽查 4 房；
- `catalogScope=API_RESPONSE_NOT_PROVEN_EXHAUSTIVE`；
- `realTimeStatus=UNKNOWN`；
- `offlineValidated=false`；
- `fullCloneVerified=false`。

R3.14 / R3.13 后续核验将 10 房 10 店的内部配对复核到 10/10，但没有发现明确的公开 secUid / 外部抖音账号 ID 字段。四层可信桥接仍为 0。参见 [R3.13 私有工作台报告](https://github.com/lijianjun004-star/tcl-live-monitor/blob/experiment/r313-private-bridge-review-20261112/docs/r313/PRIVATE-FOUR-LAYER-WORKBENCH.md) 和 [R3.14 PR #72](https://github.com/lijianjun004-star/tcl-live-monitor/pull/72)。

## 3. REA 证据更正

R3.6 的 [#43015670761](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015670761) 与 [#43016108653](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43016108653) 日志必须按字段准确解读：

- `jsBundlesRead=1`；
- `jsBytes=106391`；
- 资源 SHA-256 已记录；
- `hasCaptureDailyLiteral=false`；
- 日志明确输出 `R36_REA_TARGET_BLOCKED: no freely accessible static JS; no reverse engineering result claimed`；
- `R36_REA_REAL_ASSETS_PASS bytes=34801751` 是对 `r36-rea-private-result.json` 结果文件做 JSON 可解析性检查时打印的文件字节数，**不能称为已获取 34.8 MB 的目标 JS 资源**。

因此准确结论是：已读取/分析有限的页面 HTML 和一个静态 JS bundle；目标站点完整前端业务代码仍受访问限制，REA 未完成完整逆向，不能称为 1:1 复刻完成。

## 4. RPA 实际运行证据与网络策略缺口

- [R3.6公开访客样本 #43015156078](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015156078)：两个批准账号页面 HTTP 200，但 profile 有 LIVE 标记、room page 身份未交叉验证，状态 UNKNOWN。
- [R3.8真实云端 RPA #43028187403](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43028187403)：真实浏览器单次、两个批准账号、未建立 OPS 桥接，正式开播率/满播率为空。
- [R3.9真实系统 Chrome DOM #43035121492](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43035121492)：修复延迟 DOM 观察并得到候选直播入口，但 room identity / OPS bridge 仍未通过，结果 UNKNOWN。

代码审查发现两代 RPA 策略存在相反问题：
1. R3.7 `context.route` 对 GET/HEAD 子资源直接 `continue()`，导航只检查 HTTPS 和 host，没有对全部子资源使用严格 host/resource allowlist；不能直接视为完整网络隔离。
2. R3.15 `rpa-network-policy` 只允许精确的顶层 document URL，并阻断脚本、样式、XHR、fetch 等全部子资源。它适合离线 fixture 测试，但真实抖音 SPA 需要脚本/样式/页面数据才能渲染，不能把该 fixture PASS 当作真实 RPA 可用。

正确方案需要明确允许的公开页面和必要的第一方静态资源范围，并配合 OS/容器层 egress 防火墙与 UDP/WebRTC 限制审计；不允许隐藏接口签名、验证码绕过、stealth、代理轮换。未完成该设计和实测前，不运行真实站点 RPA。

## 5. 京东当前真实链路

### 5.1 调度配置与真实触发差异

main 上：
- `.github/workflows/jd-r23-scheduled.yml` cron：`2,7,12,17,32,47,57 * * * *`；
- `.github/workflows/jd-r33-backup.yml` cron：`4,9,14,19,34,49,59 * * * *`；
- 这是每小时多次的尽力调度，不是“一小时一次”；
- workflow 将实际采集代码 checkout 到固定 SHA `267b6709a8563ef779cda6b11c97b9684c4e1c16`，变更采集器时必须明确同步更新 pinned SHA，不能以 main 最新源码通过测试就假定生产 cron 已采用。

最近 300 条 Actions 记录样本中，main 上两条 JD schedule workflow 合计观察到 9 次成功 schedule run；相邻真实运行最大间隔 480 分钟（8 小时），另有 402、335、247 分钟等间隔。真实记录从 2026-11-10T22:08:28Z 到 2026-11-12T04:21:36Z。这个样本足以证明“定时配置不等于按计划成功执行”，但不等于全历史统计。

### 5.2 状态识别与场次边界

main 上 `probes/lib/tcl-ops.mjs`：
- 最新分钟数据新鲜度 3 分钟；
- 心跳新鲜度 2 分钟；
- 超过 3 分钟无新分钟且采集代理仍活跃时，仅生成 OFFLINE candidate；
- 只有 `offlineRuleValidated=true` 才能提升为 OFFLINE；
- main 的 JD `evaluateRoom` 固定传入 `offlineRuleValidated:false`，所以当前不会确认 OFFLINE。

固定 SHA 的 R2.3 `jd-history.mjs` 只允许 `LIVE/UNKNOWN` 状态，历史状态丢失会转 UNKNOWN，`actual_started_at` / `actual_ended_at` 永远为空，正式开播率为 null，verified offline counter 为 0。它是保守的“发现 LIVE 信号”记录，不是精确场次系统。

`trackSessionGap` 有一个候选会话差异函数，但当前 JD `scanJdSource` 和 R2.3 历史状态机没有把它接入完整场次统计，也没有实现“停播至少 10 分钟才计一次”的时间阈值。因此 10 分钟中断指标尚未实现。

### 5.3 时间采样精度

- 小时采样无法捕捉小时内开始又结束的直播；
- 小时采样无法识别 10 分钟中断；
- 即使 5 分钟采样，精确上下播时间也只能缩小为区间，除非有平台可信事件时间戳；
- 不应把 `minute_count` 增量直接当成墙钟直播时长。

## 6. R3.15 当前实现边界

当前 R3.15 FIX 分支已修复 Gemini 七项 P1–P3，并额外修正平台命名空间与分页问题：
- 同一数字 ID 可在不同平台命名空间中重复；只有同平台重复才拒绝；
- 增加 page/currentPage/totalPages/pageSize/hasNextPage 等未消费分页证据检查；
- 旧状态不可信或过期时允许重新采集候选，但不恢复该状态、不覆盖旧 Artifact。

最新代码 head：`fbf7e20505871f52505e11fb9ad1b05564697bf2`。
最新 [离线质量 CI #43211088304](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43211088304)：R3.15专项 74 tests / 73 pass / 1 skip / 0 fail；原仓回归 151/151 pass。
最新 [Chrome 离线 fixture #43211088250](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43211088250)：2/2 pass。

但：
- `source-aggregate.mjs` 不发网络请求，只调用注入的 reader，且固定输出 `sourceAccess=PARTIAL`、所有房间 UNKNOWN；
- `readonly-reader.mjs` 要求 HTTPS、经过审核的 origin/platform/date/room ID 和每条路由 schema validator；
- 已知 TCL OPS 原来源 HTTPS 单次无凭据探测 [#43206574214](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43206574214) 得到 `HTTPS_UNAVAILABLE_OR_CERT_UNVERIFIED`，没有 HTTP status；
- R3.15 没有真实 JD/Douyin adapter、没有 schedule workflow、没有跨运行互斥锁和完整 Artifact 下载校验闭环；
- R3.15 Chrome 测试只对本地合成页面运行，不是抖音线上页面；
- R3.15 仍没有真实 LIVE/OFFLINE、场次、数字人/真人分段输出。

## 7. PR 结构与合并风险

当前主仓 main SHA：`68382b23f9acf8160c8d86ec154c0ef2ce35af32`。

- #59/#60/#61：分别基于 main 的 R3.6 实验 PR；
- #62–#68：一组堆叠的身份/RPA/目录/私有导出实验；
- #69：基于 #67 的复验修复；
- #70–#72：在审计/私有身份工作台链上堆叠；
- #73：Codex R3.15，Draft，基于 main；
- #74：本次修复，Draft，base 为 R3.15 原实验分支 #73 的分支。

这些 PR 都不能批量合并。尤其 #68 私有导出与 #72 私有候选资料必须保持私有，不得作为公开 artifact。#74 只证明离线修复和 fixture 通过，不能合并成正式监控。

## 8. 当前建议执行顺序

1. 先明确并冻结业务规则：真人/数字人切换事件含义、数字人分段是否跨场次、真人轮换的证据等级、回放可用性。
2. 为 JD/Douyin 分别建立来源 schema 和 ID 命名空间，不得把内部 room/shop 与公开账号/直播 room ID 混用。
3. 修复 RPA 网络策略的“过宽”和“过窄”两端问题，先完成 OS egress/UDP 审计，再运行真实公开页面单次测试。
4. 为旧 HTTP 来源确认安全授权和隔离策略，或提供可信 HTTPS 地址；未经用户明确批准不访问 HTTP 来源。
5. 实现真实 source adapter、持久化互斥锁、Artifact API metadata + 下载 bytes + SHA-256 独立验证。
6. 在独立默认分支试运行 24–48 小时；只有真实 schedule 事件可计入时效指标，手动 dispatch 不可填补漏失计划槽。
7. 最后再做场次、开播率、满播率、≥10 分钟中断计数的真值校准与验收。

## 9. 本轮审查范围

- 读取用户上传的三份 TXT；
- 读取 GitHub main、PR #59–#74、关键代码与 workflow；
- 核对 JD schedule 最近运行记录；
- 核对 R3.6/R3.8/R3.9/R3.13/R3.14 真实 Actions 证据；
- 未访问原 HTTP 业务 API；
- 未访问抖音/京东/天猫真实平台；
- 未修改 main、Pages、生产 cron、数据库或历史数据。
