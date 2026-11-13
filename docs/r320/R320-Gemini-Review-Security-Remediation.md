# R3.20｜Gemini PR #80 独立复验后的离线网络安全修复

## 来源与原始复验结论
- 输入：用户上传的 `Gemini-R319-PR80-独立复验结果包.zip`，SHA-256 `c7f60f5d2ca50a69d53b7b065b7232f08bc0dc4f2ace599803ea4c3d77cf305e`，包内 6 项校验均通过。
- Gemini：对 Claude R3.19 的解释评级 `PASS_WITH_LIMITS`，但对未推送的 Claude 补丁 `a7a396f` 评级 `FAIL`；找出 2 P1、2 P2、1 P3 缺陷。17 项 Claude 沙箱测试通过并不等于 Chromium 网络防泄漏通过。
- GitHub 实际代码：PR #80 前次 HEAD `4b0353a2d8bf32b9d39842afc4139d657d289210`，并未包含 Claude 本地补丁。**本轮从 GitHub 实际 HEAD 独立修复，而非伪称导入 Claude 补丁。**

## 已在 PR #80 实验分支先行禁止重复运行
- 原 `r319-douyin-approved-cdn-once.yml` 的 `jobs.rpa.if` 已改为 `if: ${{ false }}`，去除一次性 CDN 环境变量；禁用提交 `146ada63634fd5954d9aed4a7d8105ba004e20a2`。
- **不再触发任何真实抖音访问**，本轮改动只属于独立的修复分支和离线测试。

## R3.20 代码整改
1. `probes/r320/network-guard.mjs`：统一拒绝登录/验证子域、路径和查询参数；拦截异常/无 Location 3xx；使用 `route.fetch({maxRedirects:0,maxRetries:0})` 逐请求获取首跳响应；任何 3xx、401/403/429 和异常在 `route.fulfill` 之前停止，**不允许 `route.continue` 和自动下一跳**。
2. `probes/r316/douyin-rpa-two-once.mjs`：接入上述首跳拦截器、同一运行停止标志与脱敏聚合计数；禁用浏览器 WebRTC、Web/SharedWorker、WebSocket、EventSource、beacon。原 Service Worker 仍禁用。
3. `probes/lib/douyin.mjs`：只考虑明确来自账号个人资料区域的唯一直播入口，不因历史 `roomId` 与新场次动态 ID 不一致而拒绝；直播间需从主播区域再次链接到已批准个人主页。缺乏主页 DOM 归属或直播间归属证据时维持 `UNKNOWN`。
4. `ENDED_RE` 只使用主播放器明确标记的结束状态文本，不能从推荐流/侧栏全文推断下播。未验证 OFFLINE 规则仍不允许正式下播或 KPI。
5. `tests/r320/network-identity-offline.test.mjs` 离线对抗性测试，`tests/r320/browser-redirect.test.mjs` 仅 localhost Chromium 浏览器测试，用独立本地 HTTP 重定向接收服务器验证泄漏 0 次。

## 风险与限制
- **安全优先的 fail-closed 行为可能让真实抖音身份认证继续为 UNKNOWN**，且真实 DOM 区域选择器尚未经用户授权的页面实测验证；不能把 CI 通过当作真实平台成功。
- 不将 `HTTP_403_RESOURCE` 判定为下播。正式开播率/满播率仍为 `null`。
- `route.fetch` 的真实浏览器效果以 CI 本地模拟服务器证据为准；即使通过，也不推定所有 Chromium 网络通道已 100% 封堵。
- 原 PR #80 Draft 不合并，本 PR 也保持 Draft，`main` 与 Pages 不动。
- 不合并、不部署、不定时巡检、不启动新 RPA；任何再一次真实抖音访问均须用户新增授权。
