# TCL 直播监控 R3.7｜RPA 只读浏览器取证实验（先抖音，后京东/天猫）

日期：2026-11-11（北京时间）｜独立草稿，基于 R3.6 PR #62 的已验收 HEAD `b1ffdecc061eddd111cbb672f2cf864b820965fc`。

## 阶段结论
**RPA 可以作为辅助取证层，不能取代跨平台身份核验及正式上下播真值校准。**
本轮只实现可注入浏览器的最小公共主页/直播页读取原型，进行**离线模拟**，不访问真实平台，不启动 GitHub schedule，不部署生产站。

## 技术选择
- Playwright：模拟正常浏览器访问已批准的公开账号主页及主页上真实的「直播中」入口，读取可见 DOM 字段。不调用受限私有接口，不绕过反爬、验证码或登录，且不存储登录态。
- R3.6 已有 `probes/lib/douyin.mjs`：对公开主页标题+抖音号与房间标题+描述做二次交叉核验；不擅自放宽规则，正常访问失败保留 UNKNOWN。
- R3.6 PR #62：四层 identity bridge `OPS room → OPS shop → public secUid → public room` 仍必须由**三类来源证据真实复核+人工审定**；单次 RPA 样本绝不能自动形成 bridge 或核定满播率。

## 新增文件
- `probes/r37/rpa-safe-douyin.mjs`
  - `approvedDouyinRpaTargets`：最多 2 个现有配置中已批准的抖音账号；域名/路径/账号 ID/HTTPS 严格白名单
  - `inspectPublicPage`：仅在临时内存读取 title、描述、抖音号与直播入口，最终输出只保留状态和最小元数据
  - `runDouyinRpaReadOnly`：Playwright 可注入浏览器，禁用 Service Worker、下载与所有非 GET/HEAD 请求，并约束文档跳转目标
- `tests/r37-rpa-safe-douyin.test.mjs`：离线模拟合规访问、403、验证码、跨身份、错房间、无直播入口、日志脱敏、POST 禁止、停止条件、房间变化等
- `.github/workflows/r37-rpa-readonly-offline.yml`：只执行 Node.js 离线单测与回归；无 Cron、无线上 Playwright、无 Pages。
  
## 默认安全门禁
| 项目 | 规则 |
|---|---|
| URL | 只允许公开 `https://www.douyin.com/user/<secUid>` 和 `https://live.douyin.com/<digits>` |
| 范围 | 每次最多 2 个明确已批准账号；不枚举全站 |
| 请求 | 浏览器上下文阻止 POST/PUT 等非读取操作及跨白名单文档跳转 |
| 账号 | 不输入密码、不复制 Cookie、不保存 browser storage state |
| 受限 | 验证码/403/429/登录墙直接停止，状态 UNKNOWN |
| 业务 | RPA LIVE 仅是公开网页双验证的**观察结果**，非 OPS 身份绑定证据 |
| 事件 | 不推断精准开/下播、不用 UNKNOWN 扣分、不计算正式满播率 |
| 交付 | 独立实验分支、Draft PR；不合并生产、不开正式巡检 |

## 如何未来执行一次真实 RPA 验证
在获得运行范围及平台访问条件确认之后，才新增明确的 `workflow_dispatch` 手动任务，安装 Playwright Chromium，
在隔离浏览器中对最多两个已批准公开账号**只读观测一次**，记录匿名化结果。
受限即停止；不上传会话数据与截图；保留 HTTP 状态和按规则输出的证据摘要。

**本轮尚未实施上述真实浏览器访问；当前测试不是实际平台准确率验证。**

## 零新增费用的客观限制
- GitHub Actions `schedule` 最短 5 分钟，但可能延迟或丢弃触发，正式可靠性需要独立验收。
- Cloudflare Browser Run Free 按 2026-10-14 官方限额，每天浏览器运行总计 10 分钟，多个房间 5/15 分钟高频查验无法保证持续免费。
- Power Automate 无人值守桌面 RPA 需要授权机器与付费许可，不作为零成本首选。
- 启用后需计算 67 间 × 每天多次的浏览器分钟总量及 GitHub Actions 账单/配额，不可宣称“永久免费且全量高频”。

官方资料：
- https://playwright.dev/docs/auth
- https://playwright.dev/docs/api/class-browsercontext
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://developers.cloudflare.com/browser-run/limits/

## 后续三道实证门禁
1. 获得至少一组**已确认的 OPS 内部房间与公开账号对应记录**，并复核身份原始证据，而非凭内部店铺名猜测。
2. 在**仅两账号人工触发**的真实浏览器环境完成“公开主页→直播间详情”的双验成功一次；403/验证码即暂停。
3. 取得真实真人开播/下播负例及多轮样本，完成 OFFLINE 真值校准和场次边界误差报告，再考虑扩展京东/天猫及云端排程。

**不触及京东 R3.5 / Pages / 已有 7 天历史数据。**