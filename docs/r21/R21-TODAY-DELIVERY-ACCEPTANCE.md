# TCL 京东直播监控 R2.1｜2026-11-10 当日交付与执行验收

**交付类型：可运行的只读京东状态巡检试用版（非正式开播率考核版）**

## 核心结论

2026-11-10 20:23 北京时间，独立 GitHub Actions 通过已授权的 TCL 运营平台公开可读取端点完成一轮真实京东巡检，**发现 7 个内部京东房间，7 个当次均有 LIVE 证据**，其中内部房间 `19` / 内部店铺 `21` / 电视品类是原历史 6 房间名单以外的新发现。

这不是完整开播率：本轮 `catalog=PARTIAL_WITH_INTEGRITY_WARNINGS`、`scope=API_RESPONSE_NOT_PROVEN_EXHAUSTIVE`，房间目录不能证明全部齐全；正式排班尚未核实、公开京东主播身份尚未映射，也没有已验证的停播/未开播反例。**正式 `opening_rate_percent=null`**。

## 第一部分：真实执行证据

- 源站读取（一次，无重试）：[GitHub Actions #42815377261](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42815377261)
- 运行时间：2026-11-10T12:23:55Z（北京时间 20:23）
- **GitHub Workflow SUCCESS**；**源目录完整性 PARTIAL**，两者严格区分。
- 运行证据：该 Actions 的 artifact `r21-jd-one-shot-sanitized-evidence`，保留 7 天，包括 `r21-source-safe.json`（去敏报告）和 `r21-accepted.json`（严格验收后的展示报告）。
- 读取来源：沿用 `probes/tcl-jd-all.mjs` 的 **TCL_OPS_READ_ONLY**，仅对项目先前明确允许的 GET 接口进行读取，未登录、更改源站数据或购买。
- 本次没有调用依赖用户 Cookie 的京东第三方接口，也没有宣布 OSS 京东爬虫端到端通过。

### 七个实际发现的内部房间（北京时间 20:23 的快照）

| 内部 room ID | 内部 shop ID | 平台显示品类 | 本次状态 | 对外京东主播身份 |
|---|---|---|---|---|
| 1 | 1 | 空调 | LIVE | PENDING |
| 14 | 14 | 洗衣机 | LIVE | PENDING |
| 15 | 15 | 空调 | LIVE | PENDING |
| 16 | 17 | 全品类 | LIVE | PENDING |
| 17 | 18 | 电视 | LIVE | PENDING |
| 18 | 19 | 显示器 | LIVE | PENDING |
| **19（新增）** | **21** | **电视** | LIVE | PENDING |

这些 room/shop 编号**只属于 TCL 内部运营源**。它们不是京东外部主播 ID，也不是单场直播 `liveId`。房间 1 的品类与旧配置有冲突，暂以源站本次展示为准，并标记待复核；旧配置不能当作正确事实。

## 第二部分：本轮新增可交付代码

| 文件 | 作用 | 运行验证 |
|---|---|---|
| `probes/r21/accept-jd-ops-scan.mjs` | 真实源 15 分钟有效期、完整性警告、7 房间去重、三态安全准入 | 单测通过后可试用 |
| `probes/r21/accept-cli.mjs` | 将去敏扫源结果转成 `r21-accepted.json`，失败安全停止 | Actions 已实际运行成功 |
| `preview/jd/index.html` | 手机优先的独立网页：查看快照、导入 JSON、状态筛选、搜索、导出 CSV | 静态代码测试；手机真机尚未验收 |
| `tests/r21-accept-jd-ops-scan.test.mjs` | 7 房间、未知、时钟、跨日、重复、来源异常、防造率 | CI |
| `tests/r21-preview-static.test.mjs` | 自包含性、脚本语法、过期判定、CSV 安全等 | CI |
| `.github/workflows/r21-jd-real-source-one-shot.yml` | 仅触发一次（手动模式兼容），对源站有限的只读检查，无 cron | [真实运行 #42815377261](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42815377261) |
| `.github/workflows/r21-jd-quality.yml` | 全回归、开播率误报检查、交付 ZIP artifact | 见当日 Actions |

## 第三部分：交付如何使用

### 1. 立即查看手机面板（不需要安装工具）

- 打开 [R2.1 质量验收 Actions](https://github.com/lijianjun004-star/tcl-live-monitor/actions/workflows/r21-jd-quality.yml)
- 下载运行产物 `r21-jd-mobile-preview-delivery`，解压后打开 `preview/jd/index.html`；
- 该 HTML 自包含，可脱机查看 2026-11-10 的真实**历史快照**，超过 15 分钟会自动标记失效；
- 如果有更近期的 `r21-accepted.json`，在页面选“导入最新巡检 JSON”，房间状态会刷新；
- CSV 可以导出，但正式开播率列依然为 `NOT_VERIFIED`。

**提醒**：该 HTML 并非当前在线 Pages 站点。为了保护历史站点，本次没有修改正式 Pages/main，未冒称已经线上部署。GitHub Actions 的产物可用于下载或在独立测试环境手动托管。

### 2. 项目命令

```bash
node --test tests/*.test.mjs

# 一个已存在且由授权源生成的去敏巡检快照：
node probes/r21/accept-cli.mjs r21-source-safe.json r21-accepted.json

# 正式开播率准入（当前必然保持 null）
node probes/r20/jd-opening-rate-cli.mjs --as-of 2026-11-10T12:00:00Z --out r21-formal-readiness.json
```

## 第四部分：质量门禁

- 真实数据：只能描述“本次已发现并确认 LIVE 的 7 个内部房间”；不能外推全天、所有直播间、百分百开播或准时率。
- 源目录完整性：报告中 `API_RESPONSE_NOT_PROVEN_EXHAUSTIVE` 及 `PARTIAL_WITH_INTEGRITY_WARNINGS` 必须保留。
- 账号映射：公开京东账号 `public_jd_account_id` 未完成 7 个真实关联，不允许把内部 shop 编号作为平台 ID。
- 排班分母：`config/r20-jd-schedule-inbox.json` 当前为空；无正式排班不计算开播率。
- OFFLINE：未证明的源站停播间隔、爬虫请求失败、登录墙、验证码、超时都标 UNKNOWN。
- 云端自动化：当前只完成一次真实源检查和离线回归；**没有长期整点/5分钟自动巡检**，也没有持久化跨运行历史数据库。
- 隐私：正式网页不含 Cookie、Token、营业额、用户资料；GitHub 包只保存已限定字段的安全快照。

## 第五部分：验收矩阵

| 验收项 | 状态 | 证据或阻断 |
|---|---|---|
| 京东内部运营真实源 GET | PASS | #42815377261 |
| 发现第七个京东房间 | PASS | 房间19、店铺21 |
| 七房间单次 LIVE 状态 | PASS（单次） | 20:23 快照 |
| 目录全量覆盖 | PARTIAL | 源站未证明响应完整 |
| APP公开京东账号与内部房间对齐 | BLOCKED | 外部主播身份没有七个可信映射 |
| 京东第三方爬虫真实持续访问 | NOT_EXECUTED | 上游开源源码已研究，未拿到目标稳定主播主页 |
| 正式排班导入 | BLOCKED | 缺少项目已批准排班分母 |
| 可靠 OFFLINE 停播正例 | BLOCKED | 尚无有效校准 |
| 实际开播率/准时开播率 | BLOCKED | 分母与负例未齐全 |
| 手机 UI 自包含及数据导入 | 实现，自动测试待核 | 见质量工作流 |
| GitHub Pages 独立线上 URL | NOT_EXECUTED | 保护旧站；仅交付可部署 HTML |
| 无人值守云端巡检 | NOT_ENABLED | 尚未通过连续性与成本验收 |

## 第六部分：今天的交付边界

可交付、可复验：**京东内部直播状态读数 + 7 房间发现 + 去敏报告 + 质量门禁 + 手机只读面板**。

尚不能称为完成：**7/7 正式开播率、满播率、平台公开主播全量身份、全天无人值守上线**。这些需要经审核排班和真实源可靠负例，不能靠赶工编造。

当前所有工作在独立实验分支 `experiment/r21-jd-today-delivery`；原仓库 `main`、R2.0 草稿 PR 和既有站点保持不变，未经进一步上线验收不合并或覆盖。
