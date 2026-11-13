# TCL 直播监控 R3.21｜Claude/Gemini 复验问题整改（只读/离线）

## 输入与检验
- Gemini 原始 ZIP：`Gemini-R320-PR81-独立复验结果包.zip`，SHA-256 `50f7b420b914f55fc78fca9fdb3e6673fc70abb6047bae6689c8b9cc9bf4d16b`，内部 **6/6** SHA256 清单匹配。
- Claude 原始 ZIP：`TCL_R320_Claude_Offline_Review_20261113.zip`，SHA-256 `c6807bb5f60504e355ad519e777d6c3bddfb6787ef8423c51a2a7977f63d8810`，内部 **27/27** SHA256 清单匹配。
- 实际基线：Draft PR #81 HEAD `1ff11c713652d9e34879bcb5402b7afe8cadaca6`；PR #80 HEAD `146ada63634fd5954d9aed4a7d8105ba004e20a2`，其已消费的 R3.19 workflow job `if: ${{ false }}`。
- Gemini 评级：`INCONCLUSIVE`，因旧 R3.20 ZIP **未包含完整源码**，其离线环境无法访问 GitHub；不是对源码的 PASS。
- Claude 评级：对 R3.20 的既有修复 `PASS_WITH_LIMITS`，但发现 **P1 WebSocketStream 实际浏览器可建立旁路 TCP**、**P2 推荐卡片冒充本人 header**、**P2 主播放器结束却判 LIVE** 等，真实 RPA 准入 `FAIL`。

## R3.21 修复
1. `probes/r320/network-guard.mjs`：在页面初始化阶段冻结阻断 `WebSocketStream`、`WebTransport`、`mozRTCPeerConnection`（原有 WebSocket/Worker/WebRTC/SW/Beacon 继续受限）；保留无自动重定向的 `route.fetch({maxRedirects:0})`。
2. 同模块新增 `hostClass` 和安全 `stopEvidence`：HTTP 状态、白名单主机分类、资源类型、方法、是否主框架跳转，**不含 URL、账号、直播间号、路径、query**；拒绝主框架访问登录/验证网关或第三方地址立即整轮停止。
3. `probes/r316/douyin-rpa-two-once.mjs`：删除用于本人直播入口及直播间归属两处通用的 `main header` 选择器（这会将推荐卡片错误视为本人）；只接受明确 `data-e2e` 归属区域。将安全停机证据加入公开脱敏回执。
4. `probes/lib/douyin.mjs`：个人主页提示“直播中”，但直播间主播放器明确“直播已结束”时强制 `UNKNOWN`；不自动升级为 OFFLINE。
5. `tests/r321/*.test.mjs`：新增静态/合成对抗测试与仅 localhost 的真实 Chromium 浏览器测试（WebSocketStream egress 和推荐卡片 DOM）。CI 需要全仓 + 浏览器通过。
6. `.github/workflows/r316-offline-gate.yml`：运行新测试；成功后导出**精确 PR HEAD 的完整源码 ZIP**与 `COMMIT_SHA.txt`、`SHA256SUMS.txt`，作为仅供独立复验、7 天过期的 GitHub Actions artifact，补齐 Gemini 的可复验输入。**源码包是仓库公开已跟踪内容，可能含原本已公开的测试 ID；请独立复验方严守脱敏边界。**

## 未解除的阻断
- **旧运行 Re-run 风险**：Claude 发现 3 个历史抖音 workflow 仍为 active，历史运行可从 Actions UI 重新运行；仅修改新分支不能更改历史 commit 的行为。当前 GitHub 连接没有可用的 workflow disable 动作。本轮**不**调用 Re-run，也不假称已经远程禁用。建议仓库管理员在 Actions 页面禁用旧 R3.16、R3.17、R3.6 真实 RPA workflow，并记录禁用结果。
- **可用性 P2-4**：继续采用“任何非预期 HTTP 3xx/4xx/5xx 整轮停机”的最保守方案，不擅自放宽，可能导致实测较早停止。
- **route.fetch 访问模式变化**：由 Playwright 的 Node APIRequestContext 发请求，可能与浏览器本体 TLS/HTTP 行为不同（Claude 在 localhost 观察到 HTTP/1.1、无 ALPN）。这可能影响真实页面行为，不允许宣称浏览器真人访客等价。
- 账号直播入口 `data-e2e` 选择器仍未在真实抖音页面核实；缺证据就保持 `UNKNOWN`。
- Chromium 对所有网络出口的完整穷尽验证未完成，仍需独立验证、正式授权才可进入下一轮真实页面观测；**绝不绕过 403、Captcha 等访问限制**。
- 未校准真实下播，`offlineRuleValidated=false`，正式开播率/完播率 **null**。
- PR #81 和本 PR 均为 Draft；`main`、GitHub Pages、生产巡检和定时器保持不变。

## CI 检验标准
1. 新增 7 项离线对抗测试，且全部覆盖于全仓回归。
2. 新增 2 项真实 Chromium 本地测试与先前 2 项一起执行，总计 4 项、0 失败。
3. 全仓 CI 无失败，工作流 YAML 与既有隐私扫描无回退。
4. Artifact 精确 `PR head sha`，可通过独立 SHA256SUMS 验证，供 Gemini/Claude 本地验证。
5. 无真实 Douyin 网络访问、无 PR 合并/Pages 发布。
