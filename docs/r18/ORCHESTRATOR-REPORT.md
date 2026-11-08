# R1.8 主控执行报告

编号 TCL-R18-20261108。用户指令“开始执行”及所附接力包授权本次实现、测试、独立分支和草稿PR；未授权生产合并或发布。

## 实际结果

基于实时核验的 R1.7 head `b940f90ba2c901cdbb8aea334304c0183959f1b1` 实现可运行的独立安全实验。main `b0861d9fc4d5ba19db62dbc0658dae7b8bfa2ddc` 与 #27/#28 均未改动，既有核心文件未修改；AI_CONTEXT.md / AGENTS.md 在本基线不存在。详细状态与 Actions 基线见 BASELINE-DIFF.md。

独立分支：`experiment/r18-safe-oss-session-monitor`。草稿 PR 将以 `feat/r17-tmall-account-session-follow` 为 base，只评审R1.8增量；不以main作为合并目标。

最终本地全回归：**297 项通过 / 0 失败 / 0 跳过**，包含旧版251项、新增46项。命令 `node --test --test-reporter=tap tests/*.test.mjs`，原始证据 `evidence/tests/final.tap`。这些全部是离线/合成/本地集成测试，不替代平台实测。

实现统一 schema、固定账号归属、新liveId换场、同liveId换房不拆场、双有效OFFLINE确认及UNKNOWN中断、时间窗口、手动/整点幂等、源请求并发锁、可配置冷却、原子事务/备份/校验/恢复/迁移。报告可在移动端打开；无来源默认UNKNOWN。新增CI仅离线回归与无来源报告artifact，没有生产cron、平台请求或发布。

## 子智能体实际分工

| 执行者 | 做了什么 | 结论及产物 |
|---|---|---|
| A，兼许可证研究 | 实时基线、保护历史、5开源仓库固定版本及许可取证 | 基线一致；MIT附加条款/AGPL/不完整授权逐项记录。subagents/A-baseline.md、OSS-LICENSE-REVIEW.md |
| B | 淘宝公开页与被动响应adapter、固定身份与动态场次校验 | 真实公开GET在HTTP前NETWORK_ERROR，BLOCKED。subagents/B-tmall-source.md |
| C | 外置持久化Profile、人工登录边界、自然响应观察与淘宝接线 | 入口返回缺浏览器依赖，真实会话NOT_EXECUTED。subagents/C-browser-session.md |
| D | 统一schema、已有JD/Douyin代码审核和一次公开检查 | JD首页/抖音空页面均不具备目标证据；UNKNOWN。subagents/D-jd-douyin.md |
| E | 调度、场次状态机、持久化、冷却及并发保护 | 单机离线验证通过，跨Actions持久化未执行。subagents/E-scheduler-store.md |
| F | 独立回归、故障注入、安全审阅与复验 | 发现并推动修复账号覆盖绕过/错误原因覆盖等问题。subagents/F-qa.md、TEST-MATRIX.md |
| 主控 | 隔离分支、契约协调、CLI/HTML报告/离线CI、集成复验与交付 | 完整测试297通过；最终提交、PR和Actions以交付索引为准 |

主控没有声称启动外部 Gemini 服务；Gemini请求数0。六个子智能体实际并行工作，各自独占目录，不修改相同核心文件，不提交或切换分支。

## 真实路径验收

| 路径 | 状态 | 说明 |
|---|---|---|
| 淘宝公开页面 | BLOCKED | 一次正常GET，HTTP响应前网络失败；不是停播证明 |
| 淘宝正常持久会话 | NOT_EXECUTED | 没有已登录用户会话，浏览器依赖不足 |
| 淘宝真实liveId发现 | NOT_EXECUTED | 没有取得真实有效响应 |
| 淘宝真实换场 | NOT_EXECUTED | 未观测真实场次变化 |
| 淘宝回放 | NOT_EXECUTED | 本轮未获取回放 |
| 京东目标直播状态 | BLOCKED | 返回/跳转首页，无目标状态证据 |
| 抖音目标直播状态 | BLOCKED | 公开主页空正文，无目标状态证据 |
| 24小时连续运行 | NOT_EXECUTED | 未启动常驻服务 |
| 跨Actions长期持久化 | NOT_EXECUTED | 仅有单机存储和CI artifact |

汇总上述9项：PASS 0、FAIL 0、BLOCKED 3、NOT_EXECUTED 6。环境浏览器能力另单列BLOCKED，不冒充真实会话测试。

## 风险与安全审计

- 不进行正式巡检、不改main/其他仓库，不合并历史草稿，不启用生产cron/Pages。
- 真实平台请求均一次，阻断即停，无验证码破解、指纹伪装、代理轮换、受保护API主动签名或重放。
- 无第三方源码复制。开源参考仅做结构研究，README附加使用限制和不完整授权保留审查意见。
- source_attested是可信采集代码约定，不是平台加密认证；不提供任意外部JSON导入来虚构实时状态。
- Profile外置，持久化仅白名单证据摘要。未存储Cookie、password、原始响应、登录页面截图；正则扫描见evidence/security-scan.json，不能等同于专业秘密扫描器保证。
- 本地Store崩溃源锁可能需要管理员确认后解除；备份可能比主状态少一个事务，显式恢复须披露该差异。文件系统实验未证明跨主机/Actions持续可靠性。
- 浏览器接线只收集本次自然导航已触发响应，晚到响应覆盖率及真实登录恢复未验证。

## 验收决定与下一锁

**实验底座离线验收通过；生产门禁未通过。** 接力包要求至少一个真实平台状态成功，目前0，不能建议合并、启用无人值守或正式发布。

下一步只解一个锁：准备可用正常浏览器，由用户自己登录外置Profile，再显式执行一次固定账号页面+自然响应检查，验证当前liveId归属。遇验证/登录失效即停，保留摘要证据；不要求用户电脑常驻。复验命令见README.md，阻断见BLOCKER-LOG.md。ZIP包含代码、子智能体报告、原始测试输出和证据；不含运行时Profile或凭据。
