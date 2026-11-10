# R2.8｜京东正式 main 真实恢复失败：Shell 语法修复

时间：2026-11-11 北京时间。基线 main：`550b380020ed1806c1aaaf0105edb363940d077c`。

## 真实失败（绝非京东源站失败）

- 已成功完成第一次 main 实源检查：Actions #42854763283。
- 由另一条 PR #43 合并产生的第二次 main 运行：Actions #42857860163，**失败**。
- 出错 job: `inspect`。
- 出错 step: `Restore latest 7-day rolling state from Actions artifact`。
- 原始错误：`line 23: syntax error: unexpected end of file`，shell exit 2。
- 因 restore step 失败，`source`、`accepted`、`state` 被跳过；不能据此说京东源站下线或采集器失败。
- 根因：在 Bash `if` 块中引入内嵌 `node <<'JS'` heredoc，GitHub YAML 反缩进后，shell heredoc delimiter 不在行首；导致 `if` 未正确闭合。

## 修复

将复核历史状态的嵌套 heredoc 改为单引号包裹的 `node --input-type=module -e`，避免 Bash 解析歧义，保留原始来源准入、JSON `validateState`、上次 run_id、房间数、检查数/事件数等审计数据。

新增真正执行 `bash -n` 的 Node 测试，先从工作流 YAML 的 `Restore` step 提取 shell 内容，并按 GitHub 多行 `run: |` 解缩进，再测试 Shell 语法。

- `tests/r28-restore-shell-syntax.test.mjs`，5 项新测试。
- `verify-restore-isolation` 保留原 R2.4/R2.6/R2.7 安全测试并加入上述 5 项。
- 不修改 GitHub cron、只读采集器 SHA、Artifact 名称、7天保留期限、Pages 或其他项目。

## 放行条件

1. 独立 PR 的完整既有/新增单测全部通过。
2. 切换到 Ready，再安全合并 main，精确 HEAD SHA 比对。
3. 合并标题标记 `[jd-main-smoke]` 触发一次受控 MAIN 真实扫描。
4. 日志必须出现上次 main run ID 和非零历史检查数；新 run 应上传 `r24-jd-main-state`（不能拿实验分支数据充当 main）。
5. 独立检查真正 `event=schedule` 自动运行次数；不得因为受控 push 成功而宣称 cron 已验证。

## 尚未完成

90 天详尽明细耐久保存、真实 JD OFFLINE 双负例、公开账号全量身份映射和满播率计算仍需单独验收。
