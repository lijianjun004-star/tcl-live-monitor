# R3.1｜京东无人值守巡检：明确取消 90 天归档

日期：2026-11-11（北京时间）

## 本次用户变更
用户明确：“**不需要90天，继续执行**。”

**生效要求：只保留 7 天滚动状态，不再创建每日 90 天归档。**
这是对历史 R2.9/R3.0 每日归档方案的需求替换，旧文件 `docs/r29/JD-DAILY-90D-AND-MAIN-RESTORE.md` 和 `docs/r30/JD-DAILY-SUCCESS-GATE.md` 仅为历史参考，不能作为当前交付目标。

## 保留的真实已验证能力
1. MAIN 首次真实巡检：run `42854763283`，发现 7 个京东内部房间，6 LIVE、1 UNKNOWN。
2. MAIN 跨运行恢复：run `42858497130`，从 MAIN 状态 `42854763283.1` 成功恢复并继续写入，checks 由 7→14，生成新 MAIN Artifact。
3. 历史恢复与异常三态保持严格规则，UNKNOWN 不是 OFFLINE。
4. GH Actions 默认分支工作流保留 `schedule: 2,7,12,17,32,47,57 * * * *`、`workflow_dispatch` 和经标签授权的一次性 MAIN 冒烟路径。
5. 不修改已存在的 GitHub Pages 文件，不触碰练播房项目。

## 本轮删减与持续性口径
- 删除 Workflow 中 `dailycheck` / `dailyupload` 两个 90 天归档步骤；
- 删除最终巡检门禁对每日归档的依赖；
- 仅保留 `r24-jd-main-state` Artifact 的 `retention-days: 7`；
- 删除旧归档专用回归测试及其调用，新增 7 天唯一保留测试；
- 对读取前次状态、对抗式混淆测试和真实 Bash 语法检查不放宽；
- 保留未来追溯历史所需的代码级状态事件窗口，但**不能声称存在 90 天持久数据**。

## 已经存在的 90 天旧 Artifact
在变更生效前，MAIN run `42859806872` 曾上传 `r27-jd-daily-2026-11-11`，Artifact ID `13784423047`，标注到期日期为 2027-02-08。**本次仅停止继续生成，并未删除该历史文件**；如需删除，必须另行明确授权并确认 GitHub 连接器支持。

## 下一个阻断：真正的 schedule 自动触发
本轮检查事件 `schedule` 记录数仍为 0。此前的 MAIN 连续两轮是受控 `push`，不能冒充 `schedule`。
本次撤销每日归档不会直接修复 GitHub 定时任务是否触发，但能够减少无需求数据和减少失败点。
GitHub Cron 属 best effort，可能延迟或者漏触发；应以 `event=schedule` 的实际运行记录与读取 `r24-jd-main-state` 的日志为准。无真实证据前不宣称长期稳定自动驻守。

## 本次验收标准
- `node --test tests/*.test.mjs` 全量回归；
- 特别 `tests/r31-jd-seven-day-only.test.mjs` 检查没有任何每日归档写入；
- GitHub PR CI 真实运行成功，不能只信文本匹配；
- MAIN 只改工作流、测试和本需求说明，不部署 Pages；
- `event=schedule` 若仍为 0，明确标记未验证。
