# R3.19 抖音两账号 CDN 双域名授权实测执行方案

## 用户批准
2026-11-13（北京时间），用户明确回复“OK开始执行”，授权：原先两个已批准抖音账号，进行一轮只读 RPA；临时仅允许下列两条 CDN 的 JS/CSS 请求，其他第三方域名与媒体拦截。限制：不开启定时巡检、不正式考核，访问限制立即停机，保留 GitHub 证据。

## 前置事实
- 基线 PR #79：`8db56cb7f4235882c0df2c1a0512c3c44f4b1779`；正式 main 未改。
- 上次真实运行 #43249797533：两个主页/直播页均 HTTP 200，但身份双重核验 0/2，判定 UNKNOWN；核心 CDN 域名静态资源总阻断次数高。
- 两个目标由现有 `config/r316-douyin-rpa-targets.json` 按 key 引用，仅接受 `config/probe-targets.json` 的 `scopeApproved:true` 账号。目标名单不可扩充。
- **无有效 OFFLINE 校准**，任何失败都保持 UNKNOWN，不能计算开播率、满播率、完成率等正式 KPI。

## 唯一放行边界
- `lf-douyin-pc-web.douyinstatic.com`
- `lf-douyin-pc-web-back.douyinstatic.com`

以上只允许 HTTPS GET 的 Playwright `resourceType=script/stylesheet`，精确域名白名单，不放行字体、图片、XHR、媒体、WebSocket 等。
- `lf3-cdn-tos.bytegoofy.com`、其他 bytetos/douyinstatic 扩展域名和追踪/遥测域名**全部保持原阻断**。
- 核心 CDN 许可只在一次性工作流 `r319-douyin-approved-cdn-once.yml` 内以显式环境变量授予；代码在其他运行环境默认拒绝。
- 页面只读：不登录/不提供 Cookies/不修改账号/不购买/不尝试绕过安全验证。
- 遇 401/403/429、登录/验证跳转、挑战页面或导航超时立即终止剩余账号。
- 页内脚本运行可能触发额外请求；所有请求仍受同一白名单拦截，非 GET/HEAD 一律阻断，视频/音频和 WebSocket 拦截。
- 账号主页须先验证原始配置的个人主页路径与唯一可见抖音号才能查看其直播入口。

## 触发与证据
1. 新分支 `experiment/r319-douyin-core-cdn-approved-once-20261113`，独立 Draft PR，运行离线专项/全仓 CI。**未通过不得触发真实访问。**
2. 仅 workflow 文件更改且 commit message 包含标记 `[r319-cdn-rpa-once]` 才触发 RPA。仅 `github.run_attempt==1` 执行；无 schedule/dispatch。
3. 结果保留：脱敏两账号状态、主页与直播间 HTTP 返回码、身份核验布尔值、准许 CDN 请求计数及被拦截域名/类型计数。绝不将私有账号标识、房间号、完整 URL、Cookies 输出到公开回执。
4. 私有浏览证据只用 repo 公钥加密后存储于 Actions 输出；公开脱敏回执保留七天。正式 main/Pages 保持不变。

## 实测成功条件
- 两账号完成访问且无 challenge、没有越界资源允许。
- CDN 实际有 JS/CSS 请求通过（计数大于零）。
- 若抖音账号主页、显示 ID、直播间标题/描述与路径全部交叉核验，可标记 LIVE；否则只能 UNKNOWN。
- 即使两账号 LIVE，也只是瞬时观察：不得推导 OFFLINE、开播率、满播率、累计完成时长。
