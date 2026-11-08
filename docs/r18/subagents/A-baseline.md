# Agent A / G｜基线保护与开源研究

任务编号：TCL-R18-20261108-A。领域：仓库安全、开源许可证。总负责人：主控 `/root`；当前执行者：`a_baseline_license`。来源版本：接力包 R1.8 + 实时仓库 R1.7 `b940f90ba2c901cdbb8aea334304c0183959f1b1`。预算：公共 GitHub 只读请求，未调用 Gemini、未使用付费模型 API。状态：本子任务 PASS；最终整合代码的 secrets 审计由主控在提交前执行。

## 实际执行

- 读取 git 状态、提交链、全部现有工作流、R1.7 说明与状态机；初始工作树干净，没有未追踪生产改动。
- 主控独立实时核实 main / #27 / #28 / Actions；详见 `../BASELINE-DIFF.md`。
- 通过公开 GitHub REST 和固定提交 raw URL 读取 5 个开源仓库 README / LICENSE / 元数据及相关架构模块，证据存放 `../evidence/oss/`。
- 仅记录源码文件的符号、内容摘要哈希和 URL；未把第三方源码复制入业务代码；README / LICENSE 原文仅作为审核证据保存。

## 依赖链

main → 既有 R1.1—R1.5 草稿链 → R1.6 #27（11287d3）→ R1.7 #28（b940f90）→ R1.8 实验分支。#27 的 base 为 `feat/r15-tmall-first-session-log-15min`；#28 的 base 为 `feat/r16-tmall-hourly-manual-safe`。R1.8 基于 R1.7 head，保留整条历史，无须修改 main。

## R1.7 已实现

- 固定 accountId 2050532947、动态 liveId 场次状态机、room 变化不单独触发新场次。
- 新 liveId 替换旧场次、连续两次有效 OFFLINE、UNKNOWN 中断离线链、非精确结束窗口。
- 显式手动公开页被动监听入口；未验证来源默认 UNKNOWN。
- 独立本地 JSON 账本、离线 CI、安全无来源报告。

## R1.7 未实现 / 未验收

- 真实可验收淘宝 LIVE / OFFLINE / 新 liveId 来源；已有异常流量拦截记录。
- 正常登录 Profile 的持久化与人机协同恢复。
- 跨独立 Actions run / 跨天的可靠持久化存储。
- 24 小时真实运行、无人值守巡检、生产调度。

## 开源研究结论

见 `../OSS-LICENSE-REVIEW.md`。冷却/恢复、Profile 隔离、人机登录接管、审计、统一监控接口等思想可独立重新实现。taobao_scraper 额外“非商业”措辞不能忽略；fideo AGPL 与未确认授权的 Chrome 插件代码不进入本轮项目。

## 安全保护与限制

本 Agent 仅写指定 docs 文件，未提交、切分支、修改核心代码、调用生产监控、读取 Cookie、启动平台登录或部署。未执行整合后代码 secrets 扫描，不将本报告当作最终安全通过证明。许可证判断是工程筛查，不宣称商业授权已完成。
