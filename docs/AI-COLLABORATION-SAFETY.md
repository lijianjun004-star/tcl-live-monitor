# 三模型协作与安全发布规范（草稿）

日期：2026-11-16。范围：本仓库的 AI 开发行为与发布决策；规则模板可用于其他项目，但**不会自动改变其他仓库设置**。

## 角色
| 角色 | 操作 |
| --- | --- |
| ChatGPT | 拆分需求、对照验收证据、提出风险与发布建议 |
| Codex | 独立分支开发、离线测试、生成报告与 Draft PR |
| Claude（Web + GitHub MCP 只读） | 独立查看代码和 PR 证据、提出问题；不能假定已具备写入权限 |
| 仓库所有者 | 明确批准每次正式代码合并、发布及线上覆盖 |

## 保留自动化，禁止混淆“刷新”与“发布”
- **继续运行**：京东/天猫/抖音的已批准巡检；巡检完成触发 `refresh-results-site.yml`；`tcl-live-results` 已有 `publish.yml` 定时/事件刷新。这种刷新用已批准的代码从现有采集日志生成数据页面。
- **需所有者逐次确认**：影响生产代码、工作流、部署参数、数据收集规则或站点程序的新版本合并和部署。
- 严禁直接在现有 `github-pages` 环境设置所有者审批，以免挡住已批准的例行数据刷新。
- 若未来需要真正的生产代码部署门禁，请创建**单独的** `production-code` 环境和专用部署工作流；不要让数据刷新作业引用该环境。配置前先核对审批人、触发者和 GitHub 套餐权限。

## 每个开发任务的路径
1. 只读核对 `main` SHA、现有分支及相关 PR/Actions，避免覆盖他人工作。
2. 从最新已确认的 `main` 创建独立分支；必要时拆为小 PR。
3. Codex 编写修改、补测试；允许自动运行非部署测试。不得用 `push to main` 做试验。
4. 提交 **Draft PR**，填写起始 SHA、改动路径、实际测试结果、风险和回滚方案。
5. ChatGPT / Claude 独立复验；失败项保持阻断，未知项标 NOT RUN。
6. PR 转为可合并状态前，仓库所有者针对该次代码版本明确批准。**不得以“自动开发已授权”为由自动合并或自动发布。**
7. 生产发布后再核对 Pages / Actions、版本 SHA 和真实访问结果；结果仍需实测，不得由 CI 推断成功。

## 推荐 GitHub 强制设置（尚未实施）
在 `Settings → Rules → Rulesets` 对 `main` 建立 Active branch ruleset：
- Require a pull request before merging（至少必须通过 PR）。
- Block force pushes / Restrict deletions。
- 不为机器人、Codex 或 Claude 配置绕过权限；核查管理员绕过选项。
- Required status checks：**只有当该检查对所有相关 PR 实际可用且稳定后**再启用；否则可能把正常 PR 永久卡住。
- Required approvals：个人仓库只有所有者时不应盲选“1 人审核”，因为 GitHub 的作者不能批准自己的 PR；如有第二位具备适当权限的真人审核员，再配置。
- 不启用 auto-merge；对 GitHub App 授予最小仓库及必要权限。

**重要**：文档、Agent 指令、PR 模板只是行为约定，不能替代 GitHub 规则与环境级防护。本次不修改任何 Ruleset、Environment、Actions、`main` 或线上站点。

## 复验清单
- [ ] GitHub 仓库 `main` 保护规则在 Settings 中实际生效（不是仅在文档中说明）
- [ ] 临时分支能提交代码、打开 PR；直接向 `main` 推送被拒绝
- [ ] 自动测试能运行且不发布正式版本
- [ ] Claude 只读复验仍可读取指定仓库，访问范围经 GitHub 安装设置核验
- [ ] 现有巡检定时工作流正常，结果页面自动刷新未被阻塞
- [ ] 任一正式代码合并/发布都要求所有者的明确批准
