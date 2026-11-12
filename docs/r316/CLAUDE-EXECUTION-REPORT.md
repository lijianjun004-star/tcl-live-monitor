# CLAUDE-EXECUTION-REPORT｜R3.16 京东 + 抖音现有链路

日期：2026-11-12（北京时间 21:52–22:20）。执行：Claude。范围只限京东和抖音，**不涉及天猫，不做新框架**。
本文是公开文件，不含内部房间号、店铺号、secUid、主播名或业务字段。逐房明细只在私有交付包里。

## 1. 基线

- main SHA：`68382b23f9acf8160c8d86ec154c0ef2ce35af32`，**与交接包一致，本轮未改动**。
- 创建分支：`experiment/r316-jd-douyin-current-chain-20261112`
- base SHA：`914930580bbd4fba0195a7763d063c76fb010642`（PR #75 head，堆叠在 #74 → #73 → main 上）
- Draft PR / head SHA：见 PR 描述（本文件随 head 一起提交，提交后的 SHA 无法写进自身）。
- 核对的 PR（均为 Draft、未合并）：#59 `ac79d00`、#60 `a101bf1`、#61 `f5983df`、#74 `c6110a7`、#75 `9149305`，四个 head 均与交接包一致。
- 一个结构性发现：R3.15 链（#73/#74/#75）直接基于 main，里面**没有**抖音 R3.6–R3.12 的代码（#59–#72 是另一条链）。本轮从 #69（`26fe751`）逐文件移植了抖音来源模块，见第 9 节。

### 现有功能矩阵（开工前，基于 #75 + main）

| 能力 | 京东 | 抖音内部来源 | 抖音公开 RPA |
|---|---|---|---|
| 来源读取 | main 生产 cron，HTTP，真实在跑 | 代码在 #60/#61/#67 链，不在 #75 | #63–#66 链，桌面 Chrome，直播间身份 0/2 |
| REA | #60、#73 有部分静态分析 | 同左 | — |
| 单次/自动开关 | #75 只有控制平面；`runnerReady=false` 写死 | 同左 | 无 |
| 状态持久化 | main 有 7 天 Artifact | 无 | 无 |
| 场次 | 只有每日 `session_count` | 无 | 无 |
| OFFLINE | 未校准，全部降级为 UNKNOWN | 同左 | 同左 |

## 2. 原系统

- checkedAt：2026-11-12T13:57:57Z（北京 21:57:57），GitHub Actions runner，run [43232328325](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43232328325)
- root：`http://101.96.215.251/`
- TCP：80 端口 **OPEN**；443 端口 **ECONNREFUSED**。这说明 R3.15 的 HTTPS 单次失败（`HTTPS_UNAVAILABLE_OR_CERT_UNVERIFIED`）原因是源站没有开 HTTPS，不是源站离线。
- HTTP：首页 200 `text/html`，677 字节。整站只有 HTTP，无登录、无验证码、无重定向。
- ChatGPT 环境的 `Connection refused` 和本容器的 403 都是各自出口网络的限制（本容器的 403 来自沙箱代理，不是源站返回的）。GitHub runner 可以正常访问；main 的京东生产任务今天 19:53 也读取成功（run 43213015727）。
- 页面是否打开：首页是 Vue 单页应用的空壳，只有一个入口脚本。页面导航（巡检、店铺管理、筛选）是通过读源码和对应接口核对的，**没有用浏览器点击 UI**。
- 京东筛选 / 抖音筛选 / 店铺管理：`/api/dashboard/filters`、`/api/capture/room-overview/filters` 均返回 200（JSON）。
- API（全部 GET，共 30 次请求，无凭据，间隔 1 秒）：

| 路由 | HTTP | 类型 | 字节 | 条数 | 分页字段 |
|---|---|---|---:|---:|---|
| `/api/capture/rooms` | 200 | json | 4,137 | 17 | 无 |
| `/api/shops` | 200 | json（裸数组） | 2,902 | 19 | 无 |
| `/api/assistant/active-rooms` | 200 | json | 883 | 7 | 无 |
| `/api/dashboard/filters` | 200 | json | 3,967 | — | 无 |
| `/api/capture/room-overview/filters` | 200 | json | 5,028 | 17 | 无 |
| `/api/capture/room-overview/daily` ×17（每房近 8 天） | 16×200，1×超时 | json | 200–5,212 | 0–8 天 | 无 |
| `/api/capture/schedules`（京东 / 抖音，今日） | 200 | json | 25,119 / 2,584 | 67 / 7 | 无 |
| `/api/capture/inspection-events`（京东 / 抖音，昨今两天） | 200 | json | 515,359 / 3,460 | 345 / 2 | `total`=345 / 2，`limit`=500（本页完整） |

- 分页：目录类接口都没有 total、next 或 has_more 字段，只能写 `API_RESPONSE_NOT_PROVEN_EXHAUSTIVE`。只有巡检事件接口声明了总数。
- 数据条数：采集房间 17 个（京东 7、抖音 10），店铺 19 家（京东 7、抖音 10、天猫 2）。
- 阻断：无 401/403/429，无挑战页。有一次每日接口超时；22:09 的单次读取中同一房间正常返回。

## 3. 京东

- observed internal rooms：**7**。比仓库已审核的 6 个多 1 个，是 2026-11-09 新建、店铺号与房间号不同的电视间。已记为 `NEW_ROOM_PENDING_IDENTITY_REVIEW`，**未加入正式统计**。
- verified room-shop joins：**7/7**。房间号和店铺号是两套独立 ID，有 3 个房间两者不同；代码不把一个当另一个用。另有 1 个房间的品类字段与名称冲突（`CATEGORY_MAPPING_CONFLICT`），原样报告。
- 单次读取（北京 22:09，run [43234262023](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43234262023)）：**LIVE 6、OFFLINE 0、UNKNOWN 1**。
  - 6 个已审核房间全部 LIVE：分钟数据 1.5–2.5 分钟内更新，采集心跳在线，房间与店铺身份和 8 天历史一致。其中 3 个 status=1，3 个 status 缺失但分钟数据仍在推进（R0.7.1 规则）。
  - 新房间为 UNKNOWN（`CAPTURE_UNBOUND`）。
- real OFFLINE negative sample：**0 个通过，1 个被真实证据否定**。
  - 共检查了 8 天历史里所有"分钟数据提前中断"的情况，有 4 个候选。
  - 样本 A（11-11）：分钟数据 19:15 停止，当天只有约 2/3 的常态分钟数。但同一采集会话的视觉巡检事件一直持续到 23:50。也就是说**视频仍在被采集，只是分钟数据断了**。按"心跳在线 + 分钟不更新"的规则，这里会被判成停播，是一个**真实的假停播反例**。
  - 样本 B：今天 15:01 后没有分钟数据，排班显示到 24:00 都有人，19:53 起采集解绑、心跳消失。采集已经结束，但分不清是直播停了还是采集停了，所以保持 UNKNOWN。
  - 样本 C、D：中断发生在跨午夜前后。每日场次在午夜清零，按既有规则不判定。
  - 8 天 × 6 房里没有一天出现同日 `session_count=2`，因此没有平台自己切分的场次边界可以做交叉验证。
  - 结论：`offlineRuleValidated` 保持 false，代码里没有任何地方写死成 true。OFFLINE 候选一律 UNKNOWN。
- session evidence：
  - 来源**没有** liveId 字段。只有按北京日计算的 `session_count`，以及巡检事件里的内部采集会话号（不等于平台场次）。
  - runner 记录 `firstSeenLiveAt` / `lastSeenLiveAt`（都是采样时间）、当日场次数和"场次数增加"事件。
  - `exactStartAt` / `exactEndAt` 恒为 null。
- manual run_once：**真实 PASS**，但入口是 push 触发的验收 harness，不是正式的 `workflow_dispatch`（原因见第 11 节）。harness 用的是同一套 planner 和 runner：读取 1 次，共 10 个请求，然后退出。同一次投递重放一次：0 个请求，结果 `SKIPPED_DUPLICATE_RUN`。
- auto switch integration：**已接线**。
  - R3.15 的 `runnerReady=false` 改成了 runner 模块里冻结的 `RUNNER_READY`。
  - 控制分支 `r315-runtime-control` 里的 `sourceAccessApproved` / `adapterReady` 仍全部为 false，本轮**没有改动**。
  - 因此真实的小时任务和手动任务目前仍会返回 BLOCKED，要等人工审核后打开开关。
  - harness 验证：自动开关 OFF 时，定时槽结果为 SKIP，不访问来源。
- remaining blockers：
  - 没有真实停播负例（样本 B 需要京东公开直播页的 liveId 才能判定）。
  - 跨运行状态持久化没有实现（需要私有存储，见第 11 节）。
  - 新房间需要人工审核。

## 4. 抖音

- internal rooms：**10**
- internal shops：**10**
- joins：**10/10**
- capture bound：**1**
- 本轮 10 个房间号与 11-07、11-11 两次观测的集合相同，没有房间丢失。
- 单次读取（22:09）：10 × UNKNOWN。
  - 9 个未绑定采集。
  - 唯一绑定的房间心跳在线，排班显示 17:00–24:00 正在进行，但**当天 0 分钟数据**（历史上每天也只有 1–7 分钟）。
  - 结论：**抖音内部来源不能用来判定直播状态**。
- public candidates：配置里已批准的 12 个账号，加上 11-07 核过身份的 12 个候选。
  - 10 个内部店铺名与已批准的 12 个账号**没有一个完全一致**。
  - 内部店铺名对应的是 11-07 的候选和 R0.9.9 台账里的 D 级名称线索。
- verified public accounts（本轮）：**2/2**
- verified public live rooms（本轮）：**2/2**（见第 6 节）
- four-layer bridges：**VERIFIED 0、CANDIDATE 1、CONFLICT 0、NO_EVIDENCE 9**
  - CANDIDATE 的那一个：
    - 第 1 层（房间 → 店铺）来自来源接口。
    - 第 3、4 层（公开账号 → 当前直播间）本轮双重核验通过，直播间号与 11-07 相同。
    - 第 2 层（店铺 → 公开账号）只有两条依据：店铺名与公开账号的平台显示名完全一致；同一时刻排班显示"进行中"、公开账号也在播。按规则，名称加时间重合**只能算 CANDIDATE**。
  - 还有 1 个房间的名字里包含某个已批准账号名的子串。这不算证据，记为 NO_EVIDENCE。
- LIVE：内部房间 0。公开账号有 2 个 LIVE，但因为没有 VERIFIED 桥接，不计入任何内部房间。
- OFFLINE：0
- UNKNOWN：10
- conflicts：0
- remaining blockers：
  - 第 2 层需要权威绑定记录（抖店或运营后台的账号绑定），名称不能代替。
  - 内部采集基本不产出分钟数据。

## 5. REA

- HTML bytes：677
- JS bundles：入口 1 个，modulepreload 2 个
- JS bytes：入口 `index-CuDyARyw.js` **106,391** 字节，与交接包的纠正一致；两个预加载块分别为 65,412 和 101,208 字节。历史上的"约 34.8 MB"是结果 JSON 的大小，不是 JS。
- SHA-256：
  - `index-CuDyARyw.js` `dee718304c160936a13b73082df2786a8e9ec6ca799269279c4528526f631b9c`
  - `_plugin-vue_export-helper-aqmeJzU_.js` `320d86936ba02207b6bd1c56f48dba4bd326b7d8cb4233c1dcedc47181c0a215`
  - `Button-DHQcNEVE.js` `3f565a2d5a68d256447f451d6b1b59c32f596c5ae2775875c2d5ffb11bd8477b`
  - 首页 `2e86ef84e45dd0d5b25bac9e1130fd2c96c2a9f025c9bb75ad9796f50042e905`
- 入口里引用了 41 个懒加载块；API 包装器不在入口里，而在 `api-*.js` 块中。
- routes：
  - 前端源码里能看到 40 多个 `/api/...` 路径。
  - 本轮实测只读成功 8 类：rooms、shops、active-rooms、dashboard/filters、overview/filters、daily、schedules、inspection-events。
  - 源码中的写操作（POST/PATCH/PUT/DELETE）一律没有调用。
- fields：
  - daily 的日行有 `date, session_count, minute_count, latest_minute_ts, latest{…}, metrics, current_cnt_*`；meta 里带区间合计。
  - schedules 的槽位有 `start_at, end_at, status(ended/running/future), live_room_id, shop_id`，另有人员字段。
  - inspection-events 有 `capture_session_id, started_at, rule_name, severity, status(open/closed)`，另有人员和视频字段。
  - 所有来源都**没有** liveId 或公开账号 ID。
- blocked resources：无
- claims NOT made：
  - 没有完成 1:1 逆向。
  - 没有执行前端代码。
  - 没有证明目录是全量的。
  - 没有证明 `latest.status` 的含义。

## 6. RPA

- run [43233269273](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43233269273)，北京 22:04
- 方式：手机视口、无登录、不提供 Cookie、不改 UA、无 stealth、无代理
- targets attempted：2（1 个已批准账号 + 1 个桥接候选账号；都在用户确认的 TCL 名称范围内，只监控不考核）
- HTTP status：主页 200/200，直播间页 200/200
- challenge：无（0 次停止）
- verified profile：2/2（平台显示名和抖音号都一致）
- verified room：**2/2**（直播间页标题与账号名一致）
- ops bridge：0 VERIFIED（1 个 CANDIDATE）
- LIVE：2
- UNKNOWN：0
- stop reasons：无
- 两个直播间号都与已知值相同。日志里的 `LIVE_ROOM_ID_CHANGED` 是标签误报：当时没把已知房间号传进判定函数。已修正，不影响 LIVE 判定。
- **对 R3.10 阻断的解释**：R3.8–R3.10 用桌面 Chrome，直播间页标题和描述为空，核验 0/2。本轮用手机视口，2/2 通过（11-07 也是手机视口，7 个账号各 7 轮通过）。阻断很可能来自浏览器形态。但本轮没有用桌面视口做同时段对照，所以这只是推断，不是结论。

## 7. Tests

- dedicated（`tests/r316/`）：**25/25**
- full repo：`tests/*.test.mjs`、`tests/r315/*.test.mjs`、`tests/r316/*.test.mjs` 合计 **337 项：336 通过，1 跳过，0 失败**。跳过的是 R3.15 原有的 Chrome 专用测试，在 `r315-chrome-local-smoke` 里执行。
- 覆盖：平台 ID 命名空间、重复房间、缺失店铺、分页未尽、目录变少（10 → 8 仍保留 10 行）、HTTP 500 / schema 失败、UNKNOWN 不转 OFFLINE（含样本 A 的反例形态）、旧状态损坏、手动 run_once、自动 OFF、自动 ON 但来源未批准、自动 ON 且来源通过、重复投递幂等、超时、401/403/429。
- 改动了 1 个既有测试：R3.15 的 `runnerReady: false` 断言改为"必须是 runner 冻结常量，不得来自状态文件或环境变量"。这是本轮任务要求接线带来的合同变化。
- skipped / failed：见上，0 失败。
- workflow syntax：CI 门禁会解析全部 workflow YAML；本地已解析通过。
- privacy scan：三次真实运行的日志里，没有内部 ID、secUid、抖音号、会话密钥、Cookie 或人员字段。CI 另外扫描私钥、会话密钥值和文档中的 ID。

## 8. Actions

| Run ID | Workflow | Event | Conclusion | Evidence |
|---|---|---|---|---|
| 43232328325 | R3.16 TCL OPS read-only extraction | push | success | 30 次 GET 的元数据；正文已加密 |
| 43233269273 | R3.16 Douyin public visitor observation | push | success | 2/2 主页和直播间双重核验 |
| 43234262023 | R3.16 run_once acceptance harness | push | success | 京东 6 LIVE/1 UNKNOWN；抖音 10 UNKNOWN；幂等 0 请求；自动 OFF 时为 SKIP |
| 43213015727 / 43150312229 等 | jd-r23-scheduled（main，未改动） | schedule | success | 用作历史 LIVE 证据 |
| （PR 门禁） | R3.16 offline gate | pull_request | 见 PR | 离线测试 + 语法 + 隐私扫描 |

## 9. Files changed

- 新增
  - `probes/r316/source-extract-once.mjs`
  - `probes/r316/douyin-rpa-two-once.mjs`
  - `probes/r316/one-shot-runner.mjs`
  - `probes/r316/one-shot-cli.mjs`
  - `config/r316-douyin-rpa-targets.json`
  - `.github/workflows/r316-source-extract-once.yml`
  - `.github/workflows/r316-douyin-rpa-once.yml`
  - `.github/workflows/r316-run-once-harness.yml`
  - `.github/workflows/r316-offline-gate.yml`
  - `tests/r316/one-shot-runner.test.mjs`
  - `tests/r316/privacy-and-workflow.test.mjs`
  - 本文件
- 修改
  - `probes/r315/runtime-switch.mjs`：编译期就绪状态支持按平台设置
  - `probes/r315/runtime-switch-cli.mjs`：使用 `RUNNER_READY`
  - `.github/workflows/r315-switchable-one-shot.yml`：增加 runner 步骤，逐房明细加密输出
  - `probes/lib/tcl-jd-all.mjs`：`evaluateRoom` 附带当日 `session_count`
  - `tests/r315/runtime-switch-workflow.test.mjs`
- 移植（来源提交保留在 git 记录中，内容未改）
  - `probes/r36/douyin-ops-parity.mjs`、`probes/r36/douyin-evidence-gate.mjs`、`probes/r311/douyin-catalog-reconcile.mjs`，以及对应的 4 个测试文件，均来自 PR #69 head `26fe751`
  - 原因：#75 链里没有抖音内部来源代码，而任务要求"抖音 10 房跑通"。

## 10. Security

- main modified: NO
- Pages modified: NO
- production cron modified: NO（本分支新增的 workflow 都没有 schedule；R3.15 原有的 schedule 只在默认分支生效，本分支是 Draft）
- database/history modified: NO（没写控制分支，没写 Artifact 历史）
- captcha bypass: NO（RPA 0 次遇到挑战）
- credentials exposed: NO
- 原系统只用 GET，路由在白名单内，没有调用任何写接口。
- 接口正文用仓库 RSA 公钥加密后才离开 runner，私钥不在仓库，也不在 CI。

## 11. NOT EXECUTED

1. `r315-switchable-one-shot.yml` 的正式 `workflow_dispatch` 手动入口：NOT EXECUTED。GitHub 只能触发默认分支上存在的 workflow，而本轮禁止改 main。run_once 用同一套代码，通过 push 触发的 harness 真实执行，并已如实标注。
2. 正式的自动小时运行：NOT EXECUTED（控制开关全部 OFF，且 workflow 不在默认分支）。
3. 跨运行状态持久化（上一轮房间清单、场次的恢复）：NOT IMPLEMENTED in workflow。runner 和 CLI 支持，但仓库是公开的，内部 ID 不能放进公开 Artifact，需要私有存储或仓库 Secret 加密。目前缺失房间的保护依赖京东已审核基线，以及抖音历史 10 房阈值告警。
4. 京东真实 OFFLINE 负例校准：NOT PASSED（0 个通过，1 个被否定）。
5. 京东公开直播页 / liveId 交叉：NOT EXECUTED（来源里没有 liveId，没有公开链接）。
6. 抖音四层桥接 VERIFIED：0。第 2 层缺权威证据。
7. 桌面视口与手机视口在同一时段的 RPA 对照：NOT EXECUTED。
8. 抖音内部房间 OFFLINE：NOT EXECUTED（内部来源不产出分钟数据）。
9. 正式开播率、满播率：null。排班数据已确认存在，但没有接入计算。
10. 用浏览器点击原系统页面：NOT EXECUTED，只核对了源码和接口。

## 12. ZIP

- filename / SHA-256：见交付消息（ZIP 包含本文件，本文件无法写入 ZIP 自身的哈希）。
