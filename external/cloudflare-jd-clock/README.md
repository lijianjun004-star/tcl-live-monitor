# TCL 京东直播监控 R3.5｜独立免费调度（可部署候选，未上线）

北京时间 2026-11-11。只针对 \`lijianjun004-star/tcl-live-monitor\`。

## 1. 真实验收与目标

- 京东当前 MAIN \`f477fd8be6dc7c28cf15ccdcfcaa15ffc92c7e0c\` 经过 R3.4 合并，已通过一次备用 \`workflow_dispatch\` 的真实源扫描，恢复 49→56 条 checks。
- GitHub \`schedule\` 只有 3 次记录，均属于 PRIMARY；曾出现约 6 小时 42 分钟没有有效自动采样。GitHub 官方明确说明 schedule 可延迟或被丢弃。
- R3.4 已修复备份入队前后的 TOCTOU：共享锁下再次检查最新 MAIN Artifact，避免重复采集。
- **R3.5 目标**：在 GitHub 之外增加一条免费 Cron 时钟，只负责调用现有 GitHub backup Workflow；不在新服务内复制采集、存储或直播识别。
- 原有 GitHub 双 Cron 保留为后备；7 天历史继续；不启用 90 天归档、不改 Pages 和练播房。

## 2. 为什么使用 Cloudflare Workers Free

比较官方英文文档：

| 候选 | 判断 |
|---|---|
| 继续只用 GitHub Actions schedule | 已有真实漏触发；增加 GitHub Cron 仍属同一调度平台，不能独立补时钟 |
| Cloudflare Workers Cron Free | 可独立定时触发 \`scheduled()\`，Workers Free 100,000 次请求/日、每账户 5 个 Cron Triggers、10ms CPU/次；本项目使用 1 个 Cron、约 168 次 Cron/日上限，远低于数量上限 |
| cron-job.org 等外部服务 | 可考虑，但需要第三方存放可写 GitHub Actions 的凭据，且另有账户/计划限制 |
| Vercel Hobby Cron | 需独立核实计划限制；不作为未经验证的分钟级候选 |

Cloudflare Worker 只发一次 HTTPS POST，计算很轻；但仍有供应商自身延迟/停机和第三方 GitHub API 配额/鉴权风险，**不构成严格分钟级 SLA**。

**目前没有与 Cloudflare 账户的授权连接，本轮仅实现源代码、配置和离线 CI；不擅自创建账户、部署或写入令牌。**

## 3. 调度机制（与现有业务对齐）

Worker Cron（UTC）：

\`4,9,14,19,34,49,59 * * * *\`

Cloudflare 文档：Cron 按 UTC 执行。Worker 内按 UTC+8 计算北京时间，运营窗口只允许 **06:30～次日 02:00**，窗外完全不调用 GitHub。为避免积压，超过原定触发时间 4 分钟的事件自动跳过。

每次合法事件发出：

\`POST https://api.github.com/repos/lijianjun004-star/tcl-live-monitor/actions/workflows/jd-r33-backup.yml/dispatches\`

Body \`{"ref":"main"}\`。所需 fine-grained GitHub Token：仅这一仓库，**Actions: Write**，其余权限遵循最小权限原则，不要给予 Contents: Write，不要把 token 放入 Git、对话或 URL。

已有 R3.4 备用工作流完成：
1. 运营窗口过滤、MAIN-only Artifact 校验；
2. 可信样本短期内防重复；
3. 获取共享监控执行锁后第二次新鲜度复核；
4. 仅在必要时实际读取 TCL OPS 京东内部信号并滚动保存 \`r24-jd-main-state\`（7 天）。

**本轮将原 8 分钟防重门槛调整为 4 分钟。** 原本每隔 5 分钟的高优先级采样，会因前次成功 5 分钟内而被当作“重复”，有效采样可能变成 10 分钟。新门槛允许 5 分钟间隔，仍阻止主 cron 与错峰备用相距约 2 分钟产生的重复源扫描。

注意：时间表是**请求采样的机会**，不是保证 5 分钟内返回有效直播状态；只有实际日志可测真实完成率。

## 4. 可执行部署步骤（账户连接后由获授权部署者执行）

本目录 \`external/cloudflare-jd-clock\`。

1. 使用现有 Cloudflare 账户的 **Workers Free**；确保同意该服务条款且无需付费升级。
2. 在 GitHub 账户创建短有效期 Fine-grained PAT：仅 \`lijianjun004-star/tcl-live-monitor\`，Repository permission **Actions: Read and write**；个人保存，不要发到聊天。
3. 在本目录执行 \`npm install\`，再以 **\`npx wrangler secret put GH_ACTIONS_TOKEN\`** 将令牌写入 Cloudflare Worker Secrets（不能写在 \`wrangler.jsonc\` 或 \`package.json\`）。
4. 执行 \`npx wrangler deploy\`；使用单独 Worker 名 \`tcl-jd-independent-clock-r35\`，不触碰用户其他 Worker。
5. Cloudflare Cron Trigger 配置中核对 UTC 表达式 \`4,9,14,19,34,49,59 * * * *\`，无公开 HTTP Worker 路由（\`workers_dev:false\`）。
6. 先核实 Worker Cron Invocation Logs 有实际触发与 GitHub dispatch 接受证据，再核实 GitHub \`jd-r33-backup.yml\` 的 \`workflow_dispatch\` 真正启动、从 MAIN Artifact 恢复、重复跳过或成功采集/回写。
7. 运行不少于一个完整北京运营日，计算计划次数、实际 dispatch 次数、成功采集次数、超时/漏触发次数和最大连续缺样间隔；保持来源 UNKNOWN 与停播分离。

部署或变更 Workers 需要用户授权与 Cloudflare 账户；在未授权之前，真实部署状态始终标记 NOT_EXECUTED。

## 5. 验收门禁与安全要求

- \`node --test tests/*.test.mjs\`（MAIN 历史回归）
- \`cd external/cloudflare-jd-clock && node --test tests/*.test.mjs\`（独立时钟、鉴权、边界、请求错误）
- PR 上线前不包含任何 PAT / Cookie / 密码 / Workers 实际账户 ID。
- 不修改已有 GitHub Pages 文件，不覆盖现有直播监控 MAIN 源采集器 SHA，不启用 90 天归档。
- 未取得对真实京东公开页面的可信 OFFLINE，继续只记录内部 LIVE / UNKNOWN，不输出正式开播率、准确满播率。
- 如果 Cloudflare 免费配额或存储配置不允许，停止，不自动升级为付费计划。

## 6. 官方来源

- GitHub schedule 延迟/丢弃：https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- GitHub workflow_dispatch 最小权限：https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- GitHub concurrency：https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- Cloudflare Cron UTC：https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare Workers Free 配额：https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
