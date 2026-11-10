# R2.6 京东 MAIN 首次巡检验证｜审查说明

日期：2026-11-11（北京时间）
主仓库：`lijianjun004-star/tcl-live-monitor`

## 历史证据

- R2.3 实验分支通过两次真实云端单次扫描，包括跨运行 Artifact 状态恢复。
- R2.4 MAIN Artifact 隔离 PR #39 已合并。
- 当前本轮 REST 实查 `event=schedule` 返回 **0 条**；不能假装 GitHub 定时已经正常执行。
- 主分支 R2.3 定时工作流以前只接受 schedule/workflow_dispatch 的 `inspect`，无法通过 push/PR 回归直接验证 MAIN 状态产物。

## R2.6 改动目的

**在一次受控 MAIN 合并上让 `inspect` 真正执行，以确认主分支整个链路。**

严格准入：仅在满足以下全部条件时允许额外一轮源站只读检查：
1. push 事件；
2. 目标 ref 是 `refs/heads/main`；
3. 变更包括 `.github/workflows/jd-r23-scheduled.yml`；
4. 合并提交标题含 `[jd-main-smoke]` 精确标识。

旧 `schedule`、`workflow_dispatch` 条件保留不变；PR 不执行真实源扫描。
该标识只有本次合并使用，后续普通 commit 不会额外启动真实源检查。

## 凭据与源站

仍沿用现有 read-only 请求和固定测试过的 R2.3 采集器 SHA；不新增账号，不登陆平台，不绕过验证码，不修改业务后端。
Runner 在 Actions job summary 写入 trigger、分支、是否存在 MAIN 历史、数据是否通过来源准入及 Artifact 名称。不会展示凭据或原始返回体。

MAIN 状态产物 `r24-jd-main-state` 与实验分支 `r23-jd-state` 严格隔离。第一次运行无旧 MAIN 记录，必须从空基线开始。失联为 UNKNOWN 而非 OFFLINE。

## 预期真实验收

- GitHub `push` 事件触发 `inspect`，且来源确认、历史落盘、上传 Artifact 均成功。
- GitHub `run_id`、job logs、上传 Artifact 与 SHA 实证可复核。
- 正式 PAGE 文件没有变化。
- 在此基础上等待真正 `schedule` 事件并核实连续两轮定时运行。**MAIN push 冒烟通过 ≠ schedule 已证明。**

## 尚不能声称

- 没有连续稳定 cron 样本，不宣称全天稳定驻守；
- 暂无独立京东 OFFLINE 负例；也不能算满播率；
- 仍只保留 7 天 Artifact，并非 90 天耐久存储；
- 当前源站列表覆盖和公众主播账号对应关系尚未完成。

官方定时限制：
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
