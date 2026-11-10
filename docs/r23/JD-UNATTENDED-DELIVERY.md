# TCL 京东 R2.3｜无人值守巡检执行与验收

日期：2026-11-10（北京时间）。目标：在关掉手机和个人电脑后，GitHub 云端按规则巡检 TCL 京东内部直播房间，跨运行延续状态与历史记录。当前工作独立于 `main` 与历史 Pages。

## 运行方式与限制

- 采样窗口：**北京时间每天 06:30 至次日 02:00**，06:30 与次日 02:00 均属于边界有效时段。
- GitHub cron（UTC）：`0,5,10,15,30,45,55 * * * *`；整点附近 **55、00、05、10 分钟**采样，其他 **15、30、45 分钟**采样。
- GitHub Actions 的 cron 是**尽力调度**，可能延迟或漏执行；绝不承诺严格 5 分钟 SLA。采用单组 `concurrency` 避免同一仓库多次运行并发写入状态。
- 来源：已经验收的 `TCL_OPS_READ_ONLY` 公开可读的内部运营状态来源（`probes/tcl-jd-all.mjs`）。本期不访问京东隐藏 API，不使用 Cookie、账号密码或绕过风控。
- 采集一次后使用 `probes/r21/accept-cli.mjs` 严格验证。源失败、超时、目录不全和未提供可靠 LIVE 时仅记录 UNKNOWN。
- 状态机 `probes/r23/jd-history.mjs` 按房间 ID 处理本次 LIVE、UNKNOWN 与跨运行事件；绝不推断实际开播或下播时间，也不计算没有可靠依据的停播次数。
- 当 LIVE 变 UNKNOWN 时事件名称为 `LIVE_SIGNAL_LOST_NOT_OFFLINE`，明确**不是“已下播”**；当 UNKNOWN 后再次 LIVE 时记录 `LIVE_SIGNAL_RETURNED`，不冒充新场次。

## 保存方案（第一期）

单次运行读取上一次 GitHub Actions artifact `r23-jd-state`，并写入本次同名的新产物：

- `r23-state.json`：按账号保留最新状态、首次/最后一次发现 LIVE 的观测时间、最近 **7 天巡检明细**、最近 **90 天状态变化事件**（以实际云端采集为准）。
- `r23-summary.json`：手机端将来只读展示用的脱敏摘要，正式开播率始终 `null`。
- GitHub artifact 有效期：**7 天**。每次正常运行将历史继承到下一份 artifact；若中断超过 7 天、artifact 被删除或平台清理，恢复能力可能中断。**这还不等于具有 90 天强耐久保障的正式数据库。**
- 仓库为公开仓库，artifact 仍可能被有权限的第三方下载，因此只记录内部房间 ID、品类、非人员级状态与观测时间，不写主播姓名、账号口令、Cookie、成交额、原始接口 body。
- 一次完整巡检只做少量既有 GET 请求，实际运行时长及 GitHub 免费额度需要持续验收，不能保证长期零费用。
- 来源目录在真实检查中仍标为 `PARTIAL_WITH_INTEGRITY_WARNINGS`；只能说“发现七个内部房间”，不能说公司只有七个。

## 可复验执行记录

- [2026-11-10 23:02 北京时间，首次 R2.3 实际云端运行](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42840097590)：7 个内部房间 7 个本次 LIVE、0 个 UNKNOWN，源目录 PARTIAL，7 个新状态事件已上传 artifact。
- CI：`.github/workflows/r23-jd-quality.yml`，`node --test tests/*.test.mjs`（包括状态恢复、误判、时间范围、七个账号与无百分比）。
- 账号身份：`config/r21-jd-crosswalk-review.json` 中七个房间的京东公开身份全部 PENDING，实际开播率不可计算。
- 正式排班：`config/r20-jd-schedule-inbox.json` 尚无项目审核通过的班次。

## 激活门禁

**GitHub 的 schedule 事件只在默认分支 `main` 生效。** 在 `experiment/r23-jd-unattended-monitor` 分支中的 `schedule` 写法**不会产生持续的 GitHub 定时巡检**；必须将经过验收的最小工作流在默认分支注册，或使用一个独立且已经配置默认分支的专用调度仓库。前者会修改 `main` 的 workflow 文件，应经过保护原有 Pages 的发布门禁。

在自动定时启用前至少核实：

1. 同一分支真实运行 **两次**，第二次实际下载上一轮 `r23-jd-state` 并成功追加而不是重新初始化；
2. GitHub 完整离线测试全部通过；
3. 启用范围只影响 `.github/workflows`，不覆盖 Pages 旧站文件，生产 cron 启用后仍只读；
4. 真实云端定时运行至少经历一次无人参与的 scheduled 事件；
5. 7 天 artifact 滚动存储和免费额度、失败告警、90 天强耐久性均需额外长期验收。

## 交付标准

本阶段能证明 **读取 LIVE + 保存跨运行结果 + 记录信号变化** 的工程能力；不能宣称已经准确识别下播、已完成开播率/满播率计算或 90 天正式持久化承诺。

项目安全边界：不伪造 LIVE、OFFLINE 或时间，不使用假身份账号，不购买，不合并其他草稿 PR，不部署到 CloudBase 或覆盖旧的 GitHub Pages。
