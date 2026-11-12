# TCL 抖音 R3.18｜静态资源与双身份识别修复（离线候选）

## 证据来源
- 上一轮**唯一**获授权实测：GitHub Actions [#43249797533](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43249797533)，HEAD `aadbd55e`。
- 公共脱敏回执 Artifact #13957728378：两个已批准账号的主页/直播页均 HTTP 200；`liveBadgeSeen=true`；但 `profileIdentityVerified=false`、`roomIdentityVerified=false`，均为 `UNKNOWN`。
- 本轮只分析报告与公开回执，**不再次访问抖音，不启动 RPA，不扩展账号范围**。

## 资源拦截
累计 3165 次请求被阻断，以下为前三名：
| 域名 | 次数 | 本轮分类 |
|---|---:|---|
| `lf-douyin-pc-web.douyinstatic.com` | 1170 | 可能是页面核心 JS/CSS，**候选**（待真实请求类型审计） |
| `lf-douyin-pc-web-back.douyinstatic.com` | 928 | 同上，**候选** |
| `lf3-cdn-tos.bytegoofy.com` | 928 | 第三方混合 CDN，**不得整体放行** |
| 其余域名合计 | 139 | 维持阻断 |

前三合计 3026（95.6%）。次数包含重试，不是唯一资产个数；因只存在域名聚合，**无法确认 3026 次是 JS/CSS 还是图片/媒体/追踪请求**。不能把“CDN 阻断”断言为身份核验失败的唯一原因。

## 本轮离线代码变化
- `probes/r318/douyin-static-policy.mjs`：将两条核心 CDN 仅列为 JS/CSS **候选域名**，默认仍完全阻断。第三方 `bytegoofy.com`、追踪/媒体/WebSocket 保持阻断；不添加自动开关，不扩大任何生产网络权限。
- `probes/lib/douyin.mjs`：补充 `profileIdentityEvidence`，在页面标题变化时，仅当实际跳转完成的个人主页路径**精确等于经授权的账号路径**、页面中**唯一显示的抖音号**与配置完全一致，才验证个人主页身份。否则 `UNKNOWN`。直播间必须独立验证身份、页面路径必须与已核对的直播入口一致，才能使用 LIVE。
- `probes/r316/douyin-rpa-two-once.mjs`：仅主页身份已核验，才会访问其直播入口；网页 Service Worker 禁用，所有第三方资源仍拒绝；公开日志仅新增诊断布尔值，没有账号 ID。
- `tests/r318/douyin-static-identity.test.mjs`：合成案例验证错误账号、跳转、多个抖音号、直播间伪匹配、未校准下播与 CDN 默认拒绝。

## 与原系统隔离
修复仅在 `fix/r318-douyin-static-evidence-offline-20261113`，基于独立分支 `experiment/r317-douyin-approved-rpa-once-20261112`；本分支名称不符合原 RPA workflow 的 push 触发条件，也不含定时器。**不合并 main、不修改 Pages，不将 UNKNOWN 转换为 OFFLINE。**

## 必须继续的验收
1. 全仓 CI、专项与安全门禁通过。
2. 补充精确资源类型与实际依赖链的离线证据；现有回执仅聚合到域名，因此“必要资源”仍不能得到认证。
3. 如需下一次真实抖音访问，须获得**单独明确授权**，限定两个已有 scopeApproved 账号、一次只读访问，重定向/挑战/401/403/429/超时立即中止。只有在审批通过后，才能在新的独立实验分支提交精确 JS/CSS 许可，并逐项验证。
4. 生产身份桥接仍需要真实独立证据；未经四层关联审核不得产生正式 KPI。`offlineRuleValidated=false`，满播率保持 `null`。

本文件描述了离线代码准备情况，而非真实平台已恢复身份验证。
