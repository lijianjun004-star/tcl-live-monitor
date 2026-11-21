# TCL Live Monitor V2 规格（唯一真相源）

版本：`schema_version = "2.0"`。本文件与 `schemas/*.json` 一起构成冻结契约；改字段必须同时改 Schema、SPEC 和测试，并升级 `schema_version`。

## 1. 范围与边界

| 项 | 规定 |
|---|---|
| 平台 | 京东 `jd`、天猫 `tmall`、淘宝 `taobao`（天猫和淘宝共用 `ali_live` 引擎） |
| 规模 | 单次运行最多 20 个目标；并发度有上限（`max_concurrency` 默认 4，最大 8） |
| 运行环境 | GitHub Actions `ubuntu-24.04` + Python 3.11 + Playwright Chromium 无头模式 |
| 访问方式 | 只做公开页面的被动观测：不登录京东，不手工构造 MTOP 签名，不重放请求，不下单、不加购、不领券 |
| 阿里 Cookie | **可选**。默认走游客模式（沿用已实测的 r329 方式）；只有配置了 `ALI_COOKIE_GROUP_<n>` 的组才带 Cookie |
| 证据 | 只落盘脱敏摘要。不保存 Cookie、令牌、请求体、完整 URL 查询串或原始响应体 |
| 判定原则 | `UNKNOWN` 不等于停播；缺样不扣满播率；单个 `live` 采样不代表整段都在直播 |

## 2. 四层结构与隔离规则

```text
config/targets(.example).json ──► [core] 校验
             │
             ▼
  B 寻路层  platforms/<p>/discovery.py   ──► resolved_rooms.json   (schemas/resolved_rooms.schema.json)
             │
             ▼
  A 监控层  platforms/<p>/live_monitor.py ──► monitor_snapshot.json (schemas/monitor_snapshot.schema.json)
             │
             ▼
  交付层    output/  差分推送 · Drive 同步 · docs/index.html · 证据包
```

| 规则 | 约束（由 `tests/v2/test_dashboard_and_layers.py` 静态检查） |
|---|---|
| R1 | `platforms/jd` 与 `platforms/ali_live` 之间严禁互相 import |
| R2 | `output/` 严禁 import `platforms/`，只读取契约 JSON |
| R3 | `core/` 严禁 import `platforms/` 或 `output/` |
| R4 | 每个平台的寻路策略（`*DiscoveryPolicy`）和监控策略（`*MonitorPolicy`）是两个不同的类，不得共用实例 |
| R5 | 层与层之间只通过契约 JSON 交接；每次交接前都先用 JSON Schema 校验，不通过则整轮以退出码 2 结束 |

## 3. 统一错误码

| 码 | 含义 | `live_status` | 是否触发熔断 |
|---|---|---|---|
| `OK` | 寻路层：已得到可用的 `room_url`；监控层：已证实正在直播 | `live` | 否 |
| `OFFLINE` | 平台接口明确返回未开播或回放 | `offline` / `replay` | 否 |
| `REDIRECTED` | 落到了其他房间或页面（URL 被改写、身份不符、App 下载页） | `unknown` | 否 |
| `LOGIN_REQUIRED` | 遇到登录墙、登录页重定向，或房间受限（`secret≠0`） | `unknown` | **是** |
| `CAPTCHA_X5SEC` | 遇到滑块、x5sec/punish 页、`RGV587`/`USER_VALIDATE` 等限流返回，或 HTTP 403/429 | `unknown` | **是** |
| `GROUP_CIRCUIT_OPEN` | 同组已熔断，本房间未发出任何网络请求 | `unknown` | — |
| `NAV_TIMEOUT` | 导航超时、运行期异常，或在预算内没有拿到判定信号 | `unknown` | 否 |
| `POST_AUDIT_BLOCKED` | 京东寻路未得到候选，且有未完成独立核对的接口被拦，或接口请求缺少可核对的身份、路径或方法 | `unknown` | 否 |
| `SCHEMA_MISMATCH` | 输入非法、响应结构不符、状态有歧义或有多个候选 | `unknown` | 否 |

细分原因写在 `reason` 字段里（取值匹配 `^[a-z0-9_]{1,64}$`），例如 `no_independent_room_match`、`ambiguous_live_candidates`、`app_download_landing`。

京东游客寻路沿用冻结码 `SCHEMA_MISMATCH`。商品页加载成功，审计和读取完整且未观察到直播入口或候选时，`reason` 为 `no_live_entry_in_guest_h5`。店铺页在同等条件下未观察到候选时，使用 `no_live_candidate_in_guest_shop`。这两种结果的直播状态均为 `unknown`。已复核的评论、上传、日志、令牌和地址接口以及非 API 写请求的拦截不单独触发 `POST_AUDIT_BLOCKED`。接口名单截断、读取不完整、入口可见但缺少场次号和候选冲突各自记录原因。H5 审计内的 `observed_from` 和 `observed_until` 以 UTC 标示商品页采样时间。

京东商品页的 `h5.response_diagnostics.public_api_http_errors` 记录公开接口返回 HTTP 4xx/5xx 的总次数。`public_api_http_error_samples` 最多保留前 10 条，每条只含 `function_id`、`http_status` 和 `host`。无法安全识别的接口名称记为 `null`。

天猫 F 轮使用固定店铺入口的两次真实观测校准下播规则。单次快照记录直播详情的状态枚举、公开场次号的取值类型和身份匹配结果。复核报告将这些字段与较早已确认在播的同一入口对照，给出该店铺的校准结论。开播、下播观测之间的实际切换时刻仍属于未知区间。

### 3.1 京东监控层映射（基于 `single_room_probe` 的结果字段）

| 条件（按顺序判断） | 码 / reason |
|---|---|
| 登录主机、登录文案，或 HTTP 401 | `LOGIN_REQUIRED` / `login_wall` |
| 详情 `secret≠0` | `LOGIN_REQUIRED` / `restricted_room` |
| 滑块或安全验证文案，或 HTTP 403/429 | `CAPTCHA_X5SEC` / `challenge` 或 `http_access_restriction` |
| `page_gate_reason == url_or_fragment_changed`，或 `target_room_mismatch_count > 0` 且未匹配 | `REDIRECTED` |
| `room_id_matched` 且 `live_status == live` | `OK` |
| `room_id_matched` 且 `live_status ∈ {offline, replay}` | `OFFLINE` |
| 状态冲突（`conflicting_detail_states`）或 `target_schema_mismatch_count > 0` | `SCHEMA_MISMATCH` |
| 其余情况 | `NAV_TIMEOUT` / `navigation_timeout_or_error` 或 `signal_not_observed_within_budget` |

### 3.2 阿里监控层映射（基于移植的 `classifyTmall`）

| 分类器结果 | 码 / reason |
|---|---|
| `LIVE` | `OK` |
| `OFFLINE` | `OFFLINE`（`offline_rule_validated=false` 保留在 diagnostics 中） |
| `IDENTITY_MISMATCH` / `ROOM_MISMATCH` / `CONFLICTING_ROOM_NUMBERS` | `REDIRECTED` |
| `apiRet` 命中 `SESSION_EXPIRED` / `NEED_LOGIN` | `LOGIN_REQUIRED` |
| `apiRet` 命中 `RGV587` / `USER_VALIDATE` / `ILLEGAL_ACCESS` / `FLOW_LIMIT` / `TRAFFIC_LIMIT` | `CAPTCHA_X5SEC` |
| 导航落到 `login.(m.)taobao/tmall.com` | `LOGIN_REQUIRED` |
| 导航落到 `sec.taobao.com`，或路径/查询串含 `punish` / `captcha` / `_____tmd_____` / `x5sec` | `CAPTCHA_X5SEC` |
| `API_ERROR`（其他）、`MISSING_BROADCASTER`、`UNRECOGNIZED_STATUS`、`AMBIGUOUS_STATUS`、解析失败 | `SCHEMA_MISMATCH` |
| 预算内没有 livedetail 响应 | `NAV_TIMEOUT` / `signal_not_observed_within_budget` |

## 4. 目标配置契约（`schemas/targets.schema.json`）

注入方式：优先读环境变量 `V2_TARGETS_JSON`（GitHub Secret，内容为整份 JSON）；其次读 `--targets <path>`。`config/targets.example.json` 只放占位值。

| 平台 | `mode` | 必填字段 | 说明 |
|---|---|---|---|
| jd | `direct` | `live_id`，或 `short_link`（`3.cn`）+ `short_link_role ∈ {clip, control}` | `canary:true` 只能用于此模式 |
| jd | `sku_discover` | `sku_id`，或 `short_link` + `short_link_role = product` | 只走 H5（`item.m.jd.com`） |
| jd | `shop_discover` | `shop_id`（`vender_id` 可选） | **未实测校准**，见 §7.3 |
| tmall / taobao | `anchor_entry` | `account_id`、`display_name`、`account_group` | 入口为 `h5.m.taobao.com/taolive/video.html?userId=`，已实测 |
| tmall / taobao | `short_link` | `short_link`（`m.tb.cn`）、`display_name`、`account_group` | **未实测校准**，见 §7.4 |

Schema 之外的业务规则（由 `core/config.py` 校验）：`key` 唯一；最多 1 个 canary 且必须是京东；每个 `account_group` 最多 `per_group_max`（≤7）个目标；目标总数不超过 `max_targets`（≤20）；京东 `direct` 模式的 `live_id` 不得重复。

## 5. B → A 交接契约（`resolved_rooms.json`）

每个目标一行，结果按配置顺序输出。

| 字段 | 类型 | 说明 |
|---|---|---|
| `target_key` / `platform` / `account_group` / `discovery_mode` | — | 原样取自配置；京东的 `account_group` 为 `null` |
| `code` / `reason` | 错误码 / 字符串 | 本轮寻路的结果 |
| `source` | `static` \| `fresh` \| `cache` \| `none` | `static`：无需联网（直连 `live_id`、`anchor_entry`）；`fresh`：本轮联网解析成功；`cache`：本轮失败，降级使用上一次有效结果；`none`：失败且无缓存 |
| `live_id` | 字符串 \| null | 京东为房间号；阿里 `anchor_entry` 为 `null`，由监控层从 livedetail 响应中取得 |
| `room_url` | 字符串 \| null | 只允许两种规范形式：`https://lives.jd.com/#/<id>` 或 `https://h5.m.taobao.com/taolive/video.html?userId=<id>` |
| `resolved_at` / `cache_age_seconds` | — | 使用缓存时给出缓存的年龄 |
| `verification` | `config` \| `resolved_link` \| `candidate_unverified` \| `entry_page` \| `none` | `candidate_unverified` 表示来自 SKU/店铺页的候选，必须等监控层 `room_id_matched` 后才算证实 |
| `audit` | 对象（≤40 键） | 脱敏审计：`function_ids`、`blocked`、`landing_route`、`candidate_count` 等 |

不变式：`source ∈ {static, fresh}` ⇔ `code = OK`；`source = cache` ⇒ `code ≠ OK` 且 `room_url` 非空；`source = none` ⇒ `room_url = live_id = null`。监控层只对 `room_url` 非空的行发起网络请求，其余行直接继承寻路层的错误码。

## 6. A → 交付层交接契约（`monitor_snapshot.json`）

| 字段 | 说明 |
|---|---|
| `canary` | `{target_key, passed, code, live_status}`。`passed` 沿用旧判定式：`room_id_matched ∧ page_loaded ∧ ¬login_or_captcha_blocked ∧ live_status=live`；未配置 canary 时为 `null` |
| `summary` | `total/live/offline/abnormal`、`by_code`、`by_platform`、`circuit_open_groups`（如 `ali:group_1`、`jd:anonymous`）、`max_detect_ms`、`median_detect_ms` |
| `rooms[]` | `target_key, platform, display_name, account_group, live_id, room_url, code, reason, live_status, observed_at, elapsed_ms, detect_ms, online_count, item_title, item_price, keywords_hit, thumbnail, discovery{code,reason,source,mode}, diagnostics` |

不变式（Schema 强制）：`code=OK` ⇒ `live_status=live`；`code=OFFLINE` ⇒ `live_status ∈ {offline, replay}`；其他码 ⇒ `live_status=unknown` 且 `thumbnail=null`。

京东从已准入的 `getImmediatePlayToM` 响应提取在线人数、商品标题和价格。阿里从与已核验场次匹配的成功 `livedetail/4.0` 响应提取在线人数，从同场 `itemlist/1.0` 响应提取商品标题和价格。缺失值为 `null`，原因记录在 `diagnostics.business_evidence.fields`。`keywords_hit` 只匹配 `item_title`。

## 7. 平台引擎设计

### 7.1 京东网络策略（寻路与监控完全独立）

| 策略 | 放行 | 拦截 |
|---|---|---|
| `JdDiscoveryPolicy`（寻路） | 京东域及其静态 CDN 的 GET/HEAD/OPTIONS；`api.m.jd.com` 上带唯一合法 `functionId`、且不在不安全黑名单里的 POST（**放行并审计**） | 媒体与字体；外部主机；非 `api.m.jd.com` 的写请求；没有 `functionId` 的 POST；命中黑名单的 `functionId`（order / cart / auth / telemetry / state_change / privacy，无论 GET 还是 POST）；登录/验证主机的主文档导航 |
| `JdMonitorPolicy`（监控） | 其余全部 | 媒体（`.flv/.m3u8/.mp4/.ts/.m4s/.aac/.fmp4`）、字体（`.woff/.woff2/.ttf/.otf/.eot` 及 `font` 资源类型）；可选屏蔽图片 |

审计输出 `function_ids.{attempted, allowed, blocked}`、`blocked_by_category`，以及放行 POST 中的 `unknown_read`（即 `public_post_read()` 未识别的只读接口）。

### 7.2 京东监控时序（缺陷 A）

每间房 `room_budget_seconds`（默认 12s）：共享同一个浏览器，每间房新建独立上下文 → `goto(wait_until="domcontentloaded")`，导航超时取「预算 − 2s」→ 每 0.5s 检查一次门禁 → 一旦收到与房间号匹配的 `getImmediatePlayToM` 响应，就设置信号并**提前返回** → 截图（可选，耗时不计入 `detect_ms`）。

### 7.3 京东 `shop_discover`（未实测校准，只做钩子）

1. 第一跳：打开 `https://shop.m.jd.com/?shopId=<shop_id>`（已实测的入口形式），使用 `JdDiscoveryPolicy`。
2. 被动捕获 `functionId ∈ SHOP_FUNCTION_HOOKS`（默认 `batchGetShopInfoByVenderId`）的 JSON 响应，交给沿用的 `Evidence.payload` 遍历器；同时只记录脱敏后的顶层键名摘要，供后续校准。
3. `vender_id` 只用于按**值**匹配（响应中任意位置出现该值即记为 `vender_id_seen`），不假设任何字段名。
4. 落到 `wqs.jd.com/downloadApp/download.html` 判为 `REDIRECTED` / `app_download_landing`（已实测会出现）。
5. 第二跳：候选唯一时输出 `verification=candidate_unverified`，交给监控层用 `getImmediatePlayToM` 核验。

### 7.4 阿里引擎

| 组件 | 规定 |
|---|---|
| Cookie 池 | 读 `ALI_COOKIE_GROUP_1..3`（原始 `k=v; k2=v2` 字符串）。组内只要有天猫目标，就把同一份 Cookie 同时注入 `.taobao.com` 和 `.tmall.com`；纯淘宝组只注入 `.taobao.com`。每组一个独立的浏览器上下文。Cookie 值不进入任何日志、`repr` 或证据 |
| 组级熔断 | 组内任意房间（无论寻路层还是监控层）返回 `LOGIN_REQUIRED` 或 `CAPTCHA_X5SEC`，该组立即熔断；组内剩余房间直接标记 `GROUP_CIRCUIT_OPEN`，**不发出任何网络请求**。组内串行执行，房间之间间隔 `inter_room_delay_seconds`；不同组可以并行 |
| 辅助商品接口 | 商品列表要求登录时，商品字段降级，同组后续请求停止访问该商品接口。已核验的主接口在播状态和场次号保留，同组下一家店仍可独立观测房间详情。 |
| `anchor_entry` | 寻路层无需联网（`source=static`）；监控层打开入口页，被动捕获 `mtop.mediaplatform.live.livedetail/4.0`，`live_id` 取自响应 |
| `short_link` | 寻路层打开 `m.tb.cn` 链接，只从落地 URL 中读取已实测的参数 `userId`，并记录脱敏后的路由形态；其他参数名留作可扩展钩子（`SHORT_LINK_PARAM_HOOKS`），默认为空 |
| DOM 兜底 | 只用于识别门禁（滑块、验证、登录文案）；不从 DOM 推断 LIVE |
| 京东熔断 | `limits.jd_circuit_breaker=true`（默认）时，京东匿名访问共用一个熔断组 `jd:anonymous`，canary 最先执行。京东按 `max_concurrency` 并发：熔断一旦打开，排队中的房间不再发出请求（`group_circuit_open`）；已在请求中的房间立即取消（`aborted_after_group_trip`，`diagnostics.aborted_in_flight=true`）。因此熔断后最多还有 `max_concurrency − 1` 个房间可能已经发出过请求 |

## 8. 寻路失败的缓存降级

- 缓存文件 `state/resolved_cache.json`，以 `target_key` 为键，存 `{fingerprint, platform, live_id, room_url, resolved_at, discovery_mode, last_live_id}`。
- `fingerprint` 是目标身份字段的 SHA-256。配置一旦改动，旧缓存就不再匹配，避免张冠李戴。
- 本轮寻路成功：覆盖该键。本轮失败：**不删除、不清空**；指纹匹配就降级为 `source=cache`，否则为 `source=none`。
- 每间房独立 `try/except` 并设超时。单间异常记为 `NAV_TIMEOUT` / `runtime_exception`，不影响其他房间。
- 缓存超过 `cache_stale_hours` 仍然使用，但在 `audit.cache_stale=true` 中标出。

## 9. 交付层

| 模块 | 规定 |
|---|---|
| 差分推送 `output/diff_push.py` | 对比 `state/monitor_snapshot.json`。事件类型：`NEW_LIVE`、`PRICE_CHANGE`、`KEYWORD_HIT`、`CIRCUIT_OPEN`、`CAPTCHA`、`CANARY_FAILED`。每条事件计算指纹，在 `notify_dedupe_hours` 内不重复推送；同一轮的所有事件合并成一条消息。推送返回 `rejected` 或 `transport_error` 时，**不更新** `state/monitor_snapshot.json`（`state_snapshot_advanced=false`），下一轮会重新产生这些事件 |
| 通道 `output/notifiers.py` | `WEBHOOK_URL`（+ 可选 `WEBHOOK_KIND`、`WEBHOOK_SECRET`）。支持钉钉（可加签）、飞书（可加签）、企业微信、Bark。未写 `WEBHOOK_KIND` 时按主机名自动识别。URL 不进入日志 |
| Drive 同步 `output/gdrive_sync.py` | OAuth 2.0 刷新令牌（`GDRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN`）。令牌响应里的 `scope` 必须**恰好是** `https://www.googleapis.com/auth/drive.file`，否则拒绝执行。报告压缩包永久保留；带 `appProperties.tcl_live_monitor=thumbnail` 且创建时间超过 24 小时的缩略图，调用 `DELETE files/{id}` **永久删除**（不进回收站） |
| 看板 `output/dashboard.py` | 输出单文件静态页 `docs/index.html`：深色、竖屏，顶部统计，按平台/状态筛选，双列卡片，一键跳转直播间。数据内嵌为 JSON，渲染只用 `textContent`。默认**不发布**到 Pages（含目标清单） |

## 10. 证据包（`v2-evidence/`）

沿用旧规范：`run_summary.json`、`control_live_result.json`、`SHA256SUMS.txt`。新增 `resolved_rooms.json`、`monitor_snapshot.json`、`thumbs/*.jpg`。JSON 写法为 `indent=2, ensure_ascii=False, allow_nan=False`；`SHA256SUMS.txt` 每行 `<sha256>  <相对路径>`，ASCII 编码，可用 `sha256sum --strict --check` 校验。

`run_summary.json` 字段：`repository, head_sha, branch, event, run_id, run_attempt, started_utc, completed_utc, schema_version, engine, targets_total, by_platform, by_code, positive_live_control, verdict, contract_validation, max_detect_ms, median_detect_ms, stability_across_runs="not_measured"`。

`verdict` 取值：`canary_passed` / `canary_failed` / `no_canary` / `runtime_error`。退出码：`0` 正常；`2` 配置或契约校验失败；`3` 设置了 `--fail-on-canary` 且 canary 未通过；`4` 运行期故障（如 Chromium 无法启动），此时只写出 `run_summary.json`。

## 11. 环境变量与 Secrets

| 名称 | 必需 | 用途 |
|---|---|---|
| `V2_TARGETS_JSON` | 是（或用 `--targets`） | 目标清单 |
| `ALI_COOKIE_GROUP_1/2/3` | 否 | 阿里小号 Cookie |
| `WEBHOOK_URL`、`WEBHOOK_KIND`、`WEBHOOK_SECRET` | 否 | 推送通道 |
| `GDRIVE_CLIENT_ID`、`GDRIVE_CLIENT_SECRET`、`GDRIVE_REFRESH_TOKEN`、`GDRIVE_FOLDER_ID`（可选） | 否 | Drive 同步 |
| `GITHUB_*` | 否 | 证据元数据；缺失时记为 `local` |

所有 Secret 只从环境变量读取，绝不写入代码、配置示例、日志或证据。
