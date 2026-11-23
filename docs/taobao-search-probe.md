# 淘宝直播搜索页监控：第一阶段可行性测试

用户 2026-11-23 确认的方案：

| 项 | 决定 |
|---|---|
| 入口 | `https://tbzb.taobao.com/search?liveSource=pc_live.anchor&searchQuery=TCL&spm=tbpc.anchor.nav.dsearch` |
| 运行位置 | GitHub Actions `ubuntu-24.04` + **Google Chrome**（`channel="chrome"`，默认在 Xvfb 虚拟显示器上有头运行） |
| 登录状态 | 专用小号的 Cookie，存 GitHub Secret `TAOBAO_SEARCH_COOKIE`；Cookie 值不进日志、回执或证据 |
| 在播判定 | 搜索接口数据 **与** 卡片按钮（`进入` = 在播，仅 `主页` = 未开播）一致才定状态，不一致记为未知 |
| 范围 | 固定白名单 `config/taobao-search-whitelist.json`，按主播 ID 匹配 |
| 频率 | 可行性通过并校准后，北京时间 08:00–00:00 每 30 分钟一次 |
| 后续 | 这一期只接开播/下播提醒（沿用 `diff_push` + `WEBHOOK_URL`） |

## 为什么先做可行性测试

2026-11-23 在云端（机房 IP、无头 Chromium）实测：扫码登录成功后，搜索接口
`mtop.mediaplatform.live.search.result` 连续 3 次返回 `RGV587_ERROR::SM`（风控），第 4 次起登录状态被作废、跳回完整登录页。
GitHub Actions 同样是机房 IP，换成 Google Chrome 能否通过，只能实测确认。

## 一次性准备（用户操作）

1. 注册或准备一个**专用小号**，不绑支付、不下单。
2. 在你自己电脑的 Google Chrome 里用这个小号登录 `https://tbzb.taobao.com/`，打开上面的搜索链接确认能看到结果。
3. 取 Cookie：按 F12 → Network → 刷新页面 → 点任意一条 `h5api.m.taobao.com` 请求 → Request Headers → 复制 `cookie:` 后面的整串值。
4. 仓库 Settings → Secrets and variables → Actions → New repository secret：名称 `TAOBAO_SEARCH_COOKIE`，值粘贴第 3 步的整串。
5. **不要**把 Cookie 发到聊天、Issue 或提交里。

## 运行

工作流 `taobao-search-probe.yml` 只能在 `main` 上手动触发，并且必须勾选 `authorized_probe`。每次只打开一次搜索页，不重试、不点击。

| 退出码 | 含义 |
|---|---|
| 0 | 搜索接口成功，回执里有卡片、接口字段形态和白名单核对结果 |
| 3 | 遇到登录或风控（`LOGIN_REQUIRED` / `CAPTCHA_X5SEC`），立即停止 |
| 5 | 预算内没拿到可用的搜索响应 |
| 2 / 4 | 配置错误 / 运行期故障（例如 Chrome 启动失败） |

产物 `taobao-search-probe-<run_id>`（保留 7 天）：`receipt.json` 和 `search.png`。

## 校准（第一次成功后）

1. 从回执的 `api_candidates[].status_fields` 和 `cards[]` 对照，找出代表在播的接口字段及取值，写入白名单的 `api_live_rule`，例如 `{"field": "liveStatus", "live_values": [1], "not_live_values": [0]}`。**字段名以实测为准，以上只是格式示例。**
2. `TCL冰箱旗舰店`、`TCL洗衣机官方旗舰店` 的候选 ID 在 `whitelist_results[].id_candidates`，用户确认后改为 `verified`。
3. 校准前所有店铺都判为未知（`api_live_field_uncalibrated`），不会推送。

## 后续阶段（可行性通过后）

- 接入 V2：搜索结果转为 `monitor_snapshot`，开播/下播事件走 `diff_push`，推送带直播间链接。
- 加 30 分钟定时；同一账号一旦遇到登录或风控即熔断，当轮不重试，并推送一条 `CAPTCHA` 告警提示更新 Cookie。
