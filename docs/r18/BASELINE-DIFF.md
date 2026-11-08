# R1.8 基线实时核验与差异

核验日期：2026-11-08 UTC。仓库：`lijianjun004-star/tcl-live-monitor`。

| 项目 | 接力包预期 | 实时结果 | 差异 |
|---|---|---|---|
| main | b0861d9fc4d5ba19db62dbc0658dae7b8bfa2ddc | 相同 | 无 |
| PR #27 head | 11287d3bd652243f8b64aa61d9c661a373be8caf | 相同，open / draft / 未合并 | 无 |
| PR #28 head | b940f90ba2c901cdbb8aea334304c0183959f1b1 | 相同，open / draft / 未合并 | 无 |
| PR #28 base | feat/r16-tmall-hourly-manual-safe | 相同 | 无 |

main 和 PR heads 通过 `git ls-remote` 及主控 GitHub 连接器读取交叉核实；PR 状态来自 GitHub REST `pulls/27`、`pulls/28`。

R1.7 最近两次离线 Actions 均 success：
- https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42460948115
- https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42460930611

## 派生决定

实验分支 `experiment/r18-safe-oss-session-monitor` 从 R1.7 head `b940f90ba2c901cdbb8aea334304c0183959f1b1` 派生，保留 R1.7 和之前提交。R1.8 草稿 PR 应以 `feat/r17-tmall-account-session-follow` 为 base，避免把此前草稿链重复呈现为本轮新增。

本轮不修改 main、不合并 #27/#28、不改其他仓库、不部署 Pages、不启用生产 cron。

## 目录、上下文与工作流

已读取现有 `.github/workflows`、`probes/`、`tests/`、`docs/`。基线仓库无 `AI_CONTEXT.md` 或 `AGENTS.md`；没有可恢复的额外本地上下文。初始 `git status --short` 为空。现有 17 个工作流均无 `schedule`；公开平台检查为手动，R1.1—R1.7 增量 CI 为离线回归。现有手动工作流不等于真实源已验收。
