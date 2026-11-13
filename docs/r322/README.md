# R3.22：观察回执、历史与离线查看

状态：本地实现和非浏览器测试完成；未推送 GitHub、未合并、未部署、未进行本轮真实平台访问。
负责人：ChatGPT/Codex；独立子任务负责账本模块与代码复查；未调用外部 Gemini/Claude。新增费用：0。

## 版本与证据
- PR #82 基线：7c825a543cc7d74145bf33dd5f5c94bd209e251d。GitHub Git Tree 与原始源码 ZIP 的 149 个文件逐一按 Git blob SHA-1 比对，149/149 一致。
- 当前 main：68382b23f9acf8160c8d86ec154c0ef2ce35af32。此 PR 分支与生产 main 不是同一版本，不可直接覆盖。
- 当前分支不存在 probes/r23/，但历史工作流引用该目录；不能把本包当作可直接替换 main 的生产部署包。
- PR #82 的既有 CI 43432047189 / job 131907692010 成功，包括 Chromium localhost 安全步骤。本次只是读取结果，未重跑，不代表 R3.22 通过远端 CI。

## 新增行为
1. 导入 schemaVersion=319 的脱敏观察回执，生成 schemaVersion=322 历史。
2. 账号键、平台和时间去重；冲突拒绝；乱序排序；真实与合成数据隔离。
3. LIVE 需要本人主页和直播间身份确认；未经明确验证的 OFFLINE 降为 UNKNOWN。
4. UNKNOWN/未执行不结束场次，不累计直播时长；只列首次/最后观察到直播和可信下播观察点。
5. 超过 15 分钟的相邻采样间隔标缺样；正式满播率和精确起止时间不计算。
6. 以最新回执时间保留 7 天数据，截断后明确提示。没有常驻清理器，也没有自动巡检。
7. 生成不含脚本、外部请求和账号链接的响应式静态 HTML。最近观测不是当前实时状态。
8. 文件锁避免并发写入；无效输入不覆盖历史；输出目标类型与符号链接父目录别名检查。
9. CI 配置加入 R3.22 测试，源码 SHA256 清单改成相对路径（仅本地修改）。

## 实际运行
在本包 source/ 内执行：

```bash
node probes/r322/import-receipt.mjs --receipt qa/r322/real-history/receipt.json --state out/history.json --html out/index.html --evidence-kind real
node --test tests/r322/*.test.mjs
```

out/index.html 是可直接打开的离线快照；JSON 是可重新载入的历史文件。它们没有云端同步或自动刷新。回执的真实/合成标记由导入者声明，不构成来源签名验证。当前只接通现有抖音公开回执格式；平台字段可以隔离数据，但尚未完成京东/天猫专用采集器适配。

状态文件原子替换，HTML 为可再生成的衍生文件；两文件不是一个原子事务。极端情况下状态提交成功、视图提交失败，程序返回 VIEW_COMMIT_FAILED_LEDGER_SAVED_RETRY_SAME_RECEIPT；再次导入相同回执可幂等重建。进程崩溃遗留锁时应先确认无运行中的写入者，再人工处理锁文件。

## 本次验收
- 新增 19/19 通过。
- 全仓 420 项：415 通过，0 失败，5 跳过（浏览器类测试按原默认门控跳过）。
- 28 个工作流 YAML 可解析。
- 单独启用的既有浏览器回归 4 项：当前环境未能完成。首次因 ESM 找不到预装 Playwright，接入本地依赖后 Chromium 启动报 socket() Operation not permitted。记录失败日志，不把它们算作通过，也没有变更网络隔离来绕过限制。
- 本地 Node 24.22.1、Playwright 1.62.1、系统 Chromium 156；不是 CI 的 Playwright 1.56.1 / Chromium 141。新页面未完成浏览器视觉、iPhone/Android 真机验收。

## 历史真实数据与演示
- qa/r322/real-history/ 来自既有 R3.19 脱敏产物，回执时间 2026-11-13 16:22 北京时间：1 UNKNOWN、1 NOT_RUN、0 已确认场次。这是历史证据导入，不是本轮新的平台观测。
- qa/r322/demo/ 是独立合成示例，演示 LIVE → UNKNOWN → LIVE；不会混入真实历史。

## 工作流阻断
浏览器确认 four-platform-identity-check.yml 可运行。点击停用确认时自动审批拒绝：该持久变更可能影响共享自动化，用户尚未明确授权具体工作流及范围。操作已取消，未通过其它接口重试。
待用户明确批准停用（启用状态仍需逐项回读）：
- four-platform-identity-check.yml
- public-status-probe.yml
- r099-field-verify.yml
不包括京东生产定时任务和离线测试任务。

## 官方资料复核
GitHub 当前英文文档明确写明：工作流被禁用时，不能重跑该工作流或其作业；需要先启用。因此旧 Claude 报告中“文档未明确 Re-run 是否阻止”的信息已可更新，但本轮没有通过真实重跑验证。
https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows
Playwright 文档说明 Service Worker 请求可能绕过普通 route 拦截；现有测试继续保留 serviceWorkers:block。
https://playwright.dev/docs/api/class-browsercontext

## 下一步
先明确停用上述三个旧探针工作流的授权并回读状态；在独立分支审查本次变更，完成浏览器回归和页面视觉验证；随后在已授权的一个直播间范围内只读实测，遇访问限制立即停止。真实连续场次、准确下播、无人值守采样频率与正式满播率仍未验收。
