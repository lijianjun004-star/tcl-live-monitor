# TCL 抖音 R3.9｜RPA DOM 漏检修复与证据诊断（独立实验）

日期：2026-11-11（北京时间）。基线 R3.8 Draft PR #64 头提交 `490149d79c158dfb1e9806b4738145864d57e209`。本分支不合并 main、不部署 Pages、不启用 Cron。

## 证据与真实原因区别

R3.8 [运行 43028187403](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43028187403) 已证实 2/2 抖音公开主页 HTTP200、2/2 公开主页身份核验成功；0/2 找到旧选择器认可的直播入口。**不能证明两家未直播。**
代码审核证实旧 `inspectPublicPage` 仅匹配 `a[href]` 中完全无参数的 `https://live.douyin.com/<数字>`，且 `a.textContent` 必须包含「直播中」。可能漏掉有查询参数的合法直播链接、只有 `aria-label` 或 `title` 的链接，以及后置渲染的入口。**尚未通过真实现场确认哪一种造成这 2 次 UNKNOWN。**

## 修复

1. 只接受 HTTPS `live.douyin.com`、5–24 位数字房间号；允许合法 URL 的参数和末尾斜杠，但立即丢弃所有 query/hash，不能上传查询参数、Cookie。
2. 对锚点可见文本、`aria-label`、`title`、嵌套 accessibility label 识别明确的「直播中／正在直播／开播中」标记。仍要求抖音主页身份、实际房间页身份双核对后才标 LIVE。
3. 若初次没有合格链接，追加一次**同一页面内 DOM 重新读取**（约 1.2 秒），无重复导航、无额外抓取 API。
4. 新增脱敏 DOM 数字统计 `totalAnchors`、`liveHostAnchorCount`、`liveLabeledAnchorCount`、`visibleLiveTextMentions`、`liveRelatedButtons`、`domTextLength`、`validNormalizedAnchors`，帮助区分“数字直播链接但缺少标记”、“可见直播文字但没有链接”、“页面未加载”。这些统计不会自动升级为 LIVE。
5. 抖音 403/登录墙/验证码依旧立即停止。没有 Live anchor 仍是 UNKNOWN，不能当 OFFLINE；精确开/下播与正式满播率保持 null。

## 质量门禁

- 新增 `tests/r39-rpa-dom-signal.test.mjs` 对合法 URL 参数、文字替代、跨域、凭证链接、重复锚点、动态加载、未知状态、私密数据不落地等开展离线测试。
- 旧 R3.7 浏览器模拟测试全部保留。
- Github Actions 仅在 Draft PR 上跑离线测试；后续真实浏览器测试必须用独立的一次性工作流手动验证，且只检查已批准最多两个公开账号。

## 未解决

- R3.8 真实网页缺少合格直播入口的**真实原因未确认**。
- 10 个 TCL OPS 内部房间与 12 个公网账号之间真实身份 bridge 仍 0。
- 真实开播/下播负例、准确时长、连续性、满播率仍未验证。
- 没有授权对照“此时肯定正在直播”的账号真值，无法判断漏检率。

本次只针对抖音公开主页 RPA 样本识别能力，不更改京东 R3.5、Pages、7 天历史、正式考核或其他平台。
