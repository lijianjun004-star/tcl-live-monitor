# TCL 抖音 R3.10｜空白元数据识别与真实取证结论

2026-11-11。基于 R3.9 修复版；所有改动在独立 Draft PR #66，禁止覆盖正式 `main`、Pages 或京东历史。

## 真实只读证据

- R3.9 [云端 Chrome run 43035121492](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43035121492)：两个已批准账号主页与直播间均 HTTP200，主页身份 2/2，直播链接 2/2；直播间身份二次验证 0/2，状态均 UNKNOWN。它证明新版入口识别比 R3.8 有改进，但**不能证明直播真的正在进行**。
- R3.10 [云端 Chrome run 43035926224](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43035926224)：
  - `tcl-douyin-flagship`：主页身份通过、房间号候选 `31878890513`，直播间 HTTP200；但房间 HTML 标题长度 **0**、Meta 描述长度 **0**、正文提取长度 **20**。因此缺少独立房间身份依据，仍 UNKNOWN。
  - `tcl-douyin-tv-official-live`：主页 HTTP200，但页面被访问限制判定，立即中止，本轮未访问房间。记录 UNKNOWN。**不重复访问以绕过限制**。
  - run 仍为 SUCCESS，表示受控程序已执行并保存脱敏证据，**不是**两个直播间识别为 LIVE，也不是风控问题已解决。
  - OPS 内部房间到公网账号的桥接仍 0，正式开播率/满播率继续 null。
- 运行所用 Ubuntu 自带 Chrome 156.0.8078.79，系统 Chrome 启动门禁 [run 43034898418](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43034898418) SUCCESS；无需重新下载 Chromium。此前独立大体积 Chromium 安装任务进度较慢，不作为正式运行依据。

## 代码纠偏

旧版将“无标题且无 Meta 描述”的房间归为 `ROOM_ACCOUNT_NAME_MISMATCH_OR_MISSING`，这并不严谨。
现在优先归类 `ROOM_PUBLIC_METADATA_EMPTY`，明确它是 **身份信息缺失**，不是证实了其他账号。
对于没有标题和 Meta 描述但未触发访问限制的房间，只在当前页面额外读取一次 DOM（1200 毫秒），不再次导航、不发新 API 请求；仍为空则继续 UNKNOWN。
新增真假值 `roomDomResampled` 及离线测试，不记录真实网页标题、正文、截图或任何身份凭据。

## 未完成的门禁

1. 本轮未在真实平台验证“DOM 再读取即可恢复房间 Meta”的效果；模拟测试通过不等于真实恢复。
2. 当前未取得一个有真人确认的 **LIVE** 真值样本及一个已下播真值样本；不能计算识别准确率。
3. 直播间真实视频状态、历史场次、精确时间及满播率均未校准。
4. 真正的运营身份映射（10 OPS 房 ↔ 12 公网账号）、京东与天猫扩展仍待真实证据。
5. 已遇到访问受限，**当前停止进一步真实 RPA 重试**；仅继续离线逻辑修复，等待合法访问恢复且有具体真值样本后再单次人工触发复验。

## 保护边界

不绕过验证码/登录墙/403/429，不复用未授权 Cookie，不跑生产 Cron、不部署、不合并 `main`、不覆写页面或七天历史。仅维护 Draft PR 供 Codex、Gemini、Claude 复验。
