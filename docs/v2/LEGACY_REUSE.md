# V2 旧代码复用与变更清单（Step 1）

- 基线：`experiment/jd-tcl-ac-sku-live-20261120` @ `7dd3decd723238dfee37ba17952723f274e0b846`（= `main` 38b21a7 + 3 个 SKU 实验提交）
- V2 工作分支：`feat/v2-modular-architecture`
- 原则：**保核换壳**。已实测的判定规则通过 `import` 或原样移植复用，只在缺陷 A / B 两处定点修复；旧文件**一个都不删、不改**，旧工作流保持原有行为。

## 0. 核心结论

| 结论 | 说明 |
|---|---|
| 回归风险 | **低**。V2 只新增文件。改动的旧文件只有 `requirements.txt`（新增 `jsonschema`）和 `.gitignore`（新增 V2 输出目录） |
| 京东判活核心 | `src/single_room_probe.py` **零改动**。V2 直接 `import` 其中的纯函数（严格准入、门禁判定、状态判定），旧的 `probe_jd_single.yml` 照常可用 |
| 缺陷 A 修复点 | 旧 `collect()` 每间房单独启动一个浏览器，`goto` 超时 25s，固定轮询 7×1s，且不屏蔽字体。V2 改为共享浏览器、每间房 12s 总预算、屏蔽视频流和字体、命中 `getImmediatePlayToM` 匹配信号即提前返回 |
| 缺陷 B 修复点 | 旧 `observe()` 同时跑 PC 和 H5；H5 写请求采用白名单（只放行 `public_post_read()` 且 `on_sku` 的请求），其余 POST 一律记入 `non_allowlisted_writes_blocked`。V2 **删除 PC 变体**，并把白名单改成「不安全写黑名单 + 只读放行审计」 |
| 天猫/淘宝 | 已实测的游客模式分类器（`probes/lib/tmall.mjs` 等）从 JS 逐条移植到 Python，语义不变。Cookie 池为**可选**，未配置时走游客模式（用户已确认） |
| 未实测、只做钩子的部分 | 京东 `shop_discover`（实测移动店铺入口会跳到 App 下载页）、淘宝 `m.tb.cn` 短链落地参数、阿里 DOM 兜底。只输出脱敏摘要，**不编造字段名** |

## 1. `src/single_room_probe.py`（京东直播间判活，1155 行）——原样保留，V2 通过 import 复用

| 函数 / 常量 | 处理 | V2 使用位置 | 说明 |
|---|---|---|---|
| `canonical_room` / `ROOM_FRAGMENT` | 原样复用 | `platforms/jd/live_monitor.py` | 严格限定房间 URL 为 `https://lives.jd.com/#/<id>` |
| `eligible` / `source_label` / `redact_path` / `redacted_fragment_shape` | 原样复用 | 同上 | 端点与路由脱敏 |
| `decode_json` / `request_function_ids` / `strict_function_ids` | 原样复用 | 同上 | JSONP 解析，提取 `functionId` |
| `detail_request_rejection` | 原样复用 | 同上 | **严格准入**：只承认 `api.m.jd.com/api` 上唯一的 `getImmediatePlayToM` |
| `public_detail` | 原样复用 | 同上 | **唯一的状态来源**：`status` 1/2/3 分别对应 live/offline/replay，`secret≠0` 视为受限 |
| `final_evidence` | 原样复用 | 同上 | 多次响应状态冲突时判为 unknown，不确定时绝不猜测 |
| `is_network_gate` / `gate_state` / `GATE_TEXT` / `LOGIN_HOSTS` | 原样复用 | 同上 | 登录页、滑块文字、URL 改写三类门禁 |
| `ProbeDiagnostics` / `diagnose_target` / `live_detail_*` | 原样复用 | 同上 | 有上限的脱敏诊断 |
| `initial_result` | 原样复用 | 同上 | 每间房的诊断字段结构与旧 `result.json` 完全一致 |
| `snapshot` / `dismiss_app_prompt` | 原样复用 | 同上 | 打码截图、关闭 App 引导弹窗 |
| `collect()` | **保留不动，V2 另写修复版** | `JdLiveMonitor._collect()` | 缺陷 A。逐行沿用其中的 `on_response`、`inspect_response`、`on_socket` 处理逻辑，只改浏览器复用、总预算、提前返回、字体屏蔽四处 |
| `append_state_history` 等历史函数 | 原样保留，V2 不接入 | — | 仍供 `probe_jd_single.yml` 使用；V2 用快照差分代替 |
| `self_test()` | 原样保留 | `tests/v2/test_legacy_regression.py` | pytest 会直接调用它，确保无回归 |
| `main()` | 原样保留 | — | 旧单房间探针入口 |

## 2. `experiments/jd_sku_live/resolve.py`（`3.cn` 短链解析）——原样移植到 `platforms/jd/short_link.py`

| 函数 | 处理 | 说明 |
|---|---|---|
| `permitted` / `route_shape` / `identifiers` / `url_gate` | 逐字移植 | 只认京东域；`lives.jd.com/#/<id>` 片段优先级最高 |
| `GATE_JS` / `ENTRY_JS` / CDP `Fetch` 拦截 | 逐字移植 | 只放行 GET/HEAD，屏蔽媒体；寻路阶段用 CDP，与监控层的拦截完全独立 |
| `resolve()` | 逐字移植，外加一层错误码映射 | 新增 `map_resolve_status()`：`resolved`→OK，`login_wall`→LOGIN_REQUIRED，`challenge`/`http_access_restriction`→CAPTCHA_X5SEC，`navigation_*`→NAV_TIMEOUT，`external_redirect`→REDIRECTED，其余→SCHEMA_MISMATCH |
| 原文件 | 保留不动 | 作为历史实验参考 |

## 3. `experiments/jd_sku_live/discovery.py`（SKU 被动寻路）——移植并定点修复（缺陷 B）

| 函数 / 规则 | 处理 | V2 位置 | 说明 |
|---|---|---|---|
| `Evidence`（`record` / `link` / `payload`） | 逐字移植 | `platforms/jd/discovery.py` | 候选 live_id 只来自 `liveId`/`liveRoomId` 字段、`lives.jd.com` 路由、`liveid` 参数这三类结构 |
| `ACCESS_JS` / `PRODUCT_JS` / `LIVE_UI_JS` / `HYDRATION_JS` / `LINKS_JS` | 逐字移植 | 同上 | |
| `func_id` / `sku_page_url` / `landing_route` / `json_value` / `jd_host` | 逐字移植 | `platforms/jd/policy.py`、`discovery.py` | 重复或冲突的 `functionId` 一律视为无法识别 |
| `PROHIBITED_FUNCTION` ∪ `PRIVATE` | **改写为分类黑名单** | `policy.py::classify_unsafe_function` | 原有词表完整保留，拦截强度不降。按类别拆成 order / cart / auth / telemetry / state_change / privacy。`add`、`pay`、`pin`、`log` 四个短词改为按词元匹配，避免 `loadData` 被误判为含 `add`、`shipping` 被误判为含 `pin` |
| `public_post_read` / `EXPLICIT_READS` | 改为**审计标签** | `policy.py` | 不再决定放行与否，只在审计里标注 `known_read` |
| `observe()` 中的 PC 变体（`item.jd.com`） | **废弃** | — | 缺陷 B-1：PC 详情页会静默跳转（`redirected_elsewhere`） |
| `observe()` 中的 H5 拦截闭包 | **替换** | `JdDiscoveryPolicy` | 缺陷 B-2：`api.m.jd.com` 上带合法 `functionId`、且不在黑名单里的 POST 一律放行并审计；没有 `functionId` 的 POST、非 API 主机的写请求仍拦截 |
| `discover()` | 简化 | `JdDiscovery._sku_discover()` | 只跑 H5；候选必须唯一才输出，多个候选判为 SCHEMA_MISMATCH（`ambiguous_live_candidates`） |
| 原文件 | 保留不动 | — | |

## 4. `experiments/jd_sku_live/run.py`（编排）——拆解进 V2 各层

| 规则 | 处理 | V2 位置 |
|---|---|---|
| `INPUTS` 中硬编码的 3 条短链 | **移出代码** | 改由 `V2_TARGETS_JSON` Secret 或 `--targets` 文件注入；示例文件只放占位值 |
| `run_control()` 中的阳性对照判定 | **判定式逐字保留** | `core/canary.py`：`room_id_matched is True and page_loaded is True and login_or_captcha_blocked is False and live_status == "live"` |
| `run_control()` 起子进程跑探针 | 替换 | 改为进程内调用 `JdLiveMonitor`，避免每间房重启浏览器 |
| `interpret()` 的 verdict 枚举 | 保留 | `platforms/jd/discovery.py::sku_control_verdict`，作为 SKU 寻路的对照审计 |
| `persist()` + `SHA256SUMS.txt` | 格式逐字保留 | `core/evidence.py`：`indent=2, ensure_ascii=False, allow_nan=False`；每行 `<sha256>  <name>`，ASCII 编码 |
| `run_summary` 字段 | 保留并扩展 | 原有字段名不变；`os.environ[...]` 改为 `.get(..., "local")`，本地运行不再因缺环境变量崩溃 |

## 5. 天猫 / 淘宝 JS 实现——语义不变移植到 `platforms/ali_live/`

| 源文件 | 函数 | V2 位置 | 说明 |
|---|---|---|---|
| `probes/lib/tmall.mjs` | `classifyTmall` / `pickBest` / `statusEnum` / `parseJSONOrJSONP` | `ali_live/classifier.py` | LIVE 要求 `roomStatus=1 && streamStatus=1` 且身份匹配；`Number(null)` 等强制转换不能证明 OFFLINE |
| `probes/r329/tmall-receipt.mjs` | `isAccessLimit` / `isLimitUrl` | 同上 | `RGV587` / `USER_VALIDATE` / `punish` / `_____tmd_____` / `login.*` / `sec.taobao.com` |
| `probes/r334/tmall-network.mjs` | `isLiveDetailUrl` / `responseLimit` / `endpointEvidence` | 同上 | 只认 `h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/4.0` |
| `probes/r329/tmall-daily-once.mjs` | 游客移动端上下文、遇限立停、房间间隔 3s | `ali_live/live_monitor.py` | 「遇限即停整轮」细化为「按组熔断」 |
| `tests/r334/tmall-classifier.test.mjs` | 全部用例 | `tests/v2/test_ali_classifier.py` | 逐条移植 |
| 原 `.mjs` 文件 | 保留不动 | — | |

## 6. 不在本次范围（不动、不 import）

| 文件 / 目录 | 原因 |
|---|---|
| 抖音相关 `probes/*douyin*`、`probes/r3xx/*`、`config/*douyin*` | 不在京东/天猫/淘宝范围内 |
| `probes/tcl-jd-all.mjs`、`probes/lib/tcl-ops.mjs`、`jd-r23-scheduled.yml` | 内部运营源巡检，属于正式生产链路，V2 不触碰 |
| `external/cloudflare-jd-clock` | 外部时钟中继 |
| `.github/workflows/*` | 按用户红线不写工作流；V2 工作流以 `ci/v2-monitor.yml.proposed` 形式提供，由 Codex 核对后落盘 |
| `config/probe-targets.json` | 不改。其中天猫字段可按 `accountId→account_id`、`displayName→display_name`、`roomNumber→room_number` 映射进 V2 Secret |

## 7. 参考但不在基线上的实测结论（来自其他实验分支，只读）

| 来源 | 结论 | 对 V2 的影响 |
|---|---|---|
| `experiment/jd-shop-entry-721631` | 移动端 `shop.m.jd.com/?shopId=` 最终落到 `wqs.jd.com/downloadApp/download.html`；PC 店铺页上没有直播链接 | `shop_discover` 识别出这个落地页就判 REDIRECTED（`app_download_landing`），不伪造候选 |
| `experiment/jd-living-live-id-20261120` | `living_live_id` 不能指向在播的新场次，已停止用作寻路入口 | V2 不使用该字段 |

## 8. 未能独立核验的输入

| 项 | 状态 |
|---|---|
| Run `44729352378` 存在且结论为 success；它是该工作流 3 次运行中的第 3 次 | ✅ 已通过 GitHub API 核验 |
| 「后两轮 33s」「`non_allowlisted_writes_blocked: 21`」「`redirected_elsewhere`」的具体数值 | ⚠️ 证据包存放的域名被本会话的网络代理拒绝，**未能下载核验**。代码中确实存在这几个字段，数值以交接单为准，请在下一轮审计时对照证据包确认 |
