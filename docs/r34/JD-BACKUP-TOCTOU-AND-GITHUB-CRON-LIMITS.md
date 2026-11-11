# R3.4 京东主备并发竞态修复与调度边界｜英文官方资料交叉验证

日期：2026-11-11（北京时间）。

## 真实依据

- 正式 MAIN：`ccd69f0298d2892f9ed6e5089fa463a774da2f9f`
- [R3.3 真实备用来源采集 run 43004000966](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43004000966) 已恢复 42→49 checks，并上传 7 天 Artifact `13847671402`。
- [R3.3 真实备用防重复 run 43004194554](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43004194554)：前次成功样本仅 1 分钟，正确跳过源采集。
- 迄今观察到的 `event=schedule` 为 3 个，都是 PRIMARY，不包括真实自然触发的备用。不能将 `workflow_dispatch` 当 `schedule`。
- 正式历史来源仅 TCL OPS 内部京东信号：7 个部分目录房间，不是完整店铺账号映射、官方 JD OFFLINE 或真人分钟数证明。

## 全局英文官方检索——关键结论

1. GitHub Actions `schedule` 可延迟或被丢弃，默认分支 cron 本身不提供 5/15 分钟严格 SLA。来源：
   https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
2. GitHub `concurrency` 同一组一次只运行一个工作流，但默认只能有一个待运行；同组新待运行会替换旧待运行。来源：
   https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
3. `workflow_call` 可复用源，但被调用的工作流执行环境继承调用者上下文；作业并发组必须避免按工作流名产生互相取消。来源：
   https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
4. Cloudflare Workers 免费版存在定时器资源额度，官方包含每账户最多 5 个 Cron Triggers、100000 次请求/日等限制；其独立调度仍需要账户与部署授权。当前用户不希望新增开发者账号/费用，所以**仅列作需要另行明确授权的备选，不擅自部署**。
   https://developers.cloudflare.com/workers/platform/limits/
   https://developers.cloudflare.com/workers/platform/pricing/

## 本次可直接修复的 race

此前：
`备用预检读到上次样本已过 8 分钟 → 进入共享监控并发队列 → MAIN 正好完成更新 → 备用获得执行机会但仍使用队列前旧决策 → 重复扫 JD 并写新 Artifact`。

R3.4：
- `workflow_call.inputs.backup_mode` 仅备用调用传入 true；原 MAIN 工作流默认 false，保持当前运行。
- 被调用的完整监控流程继续处于原有常量串行组 `r23-jd-stateful-monitor`，不修改现有 `cancel-in-progress: false`。
- 取得运行机会后重新恢复**最新同仓库 MAIN Artifact 的完整状态与摘要**。
- 限制被调用的备用功能仅可在 MAIN 分支与当前指定仓库运行。
- 只在备用运行中通过稀疏 checkout 提取与调用者相同提交的 `probes/r33/jd-backup-freshness.mjs`；原采集器仍从固定 SHA `267b6709...` checkout，避免重复维护备用判定代码。
- 在 JD 源采集、验收、状态写入、上传、最终门禁上全部加条件：
  `inputs.backup_mode != true || steps.lock_recheck.outputs.should_run == 'true'`。
- SECOND gate 返回 false → 安全跳过源站和上传，完整工作流不应伪装为一次新采样。
- 来源历史 false/缺失、时间超过 8 分钟 → 允许补检；错误/不完整历史 → 失败封闭，UNKNOWN 不当 OFFLINE。
- 没有更改原 MAIN cron、错峰备用 cron、7 天保留、Pages 或其他项目。

## 需要如实区分

**离线单测通过 ≠ GH Actions 真实运行证实锁后决策。**
必须取得 PR 全量 CI 与至少一次受控 `workflow_dispatch` 的真实 MAIN 结果，核对来源扫描与状态上传；然后单独观察自然备用 `schedule`。

此修复只解决旧状态导致的二次重复读取，**不能消除 GitHub 自身未触发的 cron 事件**。无法承诺严格 5/15 分钟 SLA。若未来需要固定时效，必须另选可验证的独立计时/外部调度源，并获授权后才能部署。用户不要求 90 天归档。
