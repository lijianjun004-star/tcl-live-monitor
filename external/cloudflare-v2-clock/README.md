# V2 巡检外部定时器（Cloudflare Workers 免费版）

## 为什么需要

`v2-monitor.yml` 设计为北京时间 08:00–24:00 每半小时一轮，但 GitHub 只是"尽力"发送定时事件。2026-11-21～22 本仓库的实际记录：

| 定时任务 | 设计频率 | 实际 |
| --- | --- | --- |
| jd-r23-scheduled | 每小时 7 次 | 11-21 全天 4 次 |
| jd-r33-backup | 每小时 7 次 | 11-21 全天 4 次 |
| v2-monitor | 每半小时 1 次 | 合并后约 19 小时内 3 次（北京时间 19:44、02:49、05:37） |

改 cron 分钟或加密频率无效（jd-r23 已错开整点）。本目录的 Worker 从 GitHub 外部每 30 分钟调用一次 `v2-monitor.yml` 的手动运行接口。仓库公开，Actions 标准运行器不计费；Cloudflare Workers 免费版每天 10 万次请求，这里每天最多 33 次。

## 它做什么，不做什么

- 北京时间 08:07、08:37 …… 23:37、00:07，共 33 个时间点，各发一次 `POST /repos/lijianjun004-star/tcl-live-monitor/actions/workflows/v2-monitor.yml/dispatches`，参数 `ref=main`、`engine=live`、`fail_on_canary=false`、`continue_main_state=true`。
- `continue_main_state=true` 让这次运行像定时运行一样，接上最近一次成功运行的状态和推送基线，不会重复推送。
- 定时事件晚到 10 分钟以上就跳过，不补发；窗口外不发请求。
- 不读取任何直播间，不保存状态，代码里没有令牌，日志不打印令牌和返回内容。
- GitHub 自己的定时任务保留不动，作为后备。两者撞在一起时，`v2-monitor.yml` 的并发锁会让后来的排队。

## 部署步骤（只用网页，不需要命令行）

### 第 1 步：生成 GitHub 令牌

1. 登录 GitHub，打开 Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。
2. Token name 填 `tcl-v2-clock`。Expiration 选 1 年，并在日历上记下到期日。
3. Repository access 选 **Only select repositories**，只勾 `lijianjun004-star/tcl-live-monitor`。
4. Permissions → Repository permissions → **Actions** 选 **Read and write**。其他权限不动（Metadata 会自动设为只读）。
5. 生成后令牌只显示一次。复制后直接用于第 2 步，**不要发到聊天、邮件或任何文件里**。

### 第 2 步：建 Cloudflare Worker

1. 注册或登录 Cloudflare（免费版即可，不需要绑定域名）。
2. 进入 **Workers & Pages** → Create → 创建 Worker（从 "Hello World" 模板开始）。名称填 `tcl-v2-clock`，先点 Deploy。
3. 打开这个 Worker，点 **Edit code**。删除编辑器里的全部示例代码，粘贴本目录 [`worker.js`](worker.js) 的完整内容，再点 Deploy。
4. 进入 Worker 的 **Settings → Variables and Secrets** → Add。类型选 **Secret**，名称填 `GH_ACTIONS_TOKEN`，值粘贴第 1 步的令牌，保存。
5. 进入 **Settings → Triggers**（或 Cron Triggers）→ Add Cron Trigger。表达式填 `7,37 * * * *`，保存。Cloudflare 按 UTC 计时，代码会自己换算成北京时间并只在 08:00–00:10 之间发请求。
6. 可选：在 Settings → Domains & Routes 里关闭 workers.dev 地址。这个 Worker 只靠定时器运行，不需要网址。

Cloudflare 网页的菜单名称可能会调整，找不到时按上面的英文关键词搜索。

也可以用命令行部署：在本目录运行 `npx wrangler secret put GH_ACTIONS_TOKEN`，再运行 `npx wrangler deploy`（读取 `wrangler.jsonc`）。

### 第 3 步：确认生效

- 部署后的下一个 :07 或 :37（北京时间 08:00–00:10 之间），GitHub 仓库 Actions 里的 **TCL V2 monitor** 应出现一条触发方式为 `workflow_dispatch` 的运行。
- Cloudflare Worker 的日志（Logs / Cron Events）里，每次应有一行 `{"component":"tcl-v2-clock","accepted":true,...}`。
- 如果显示 `GITHUB_DISPATCH_HTTP_401` 或 `403`：令牌过期、复制错误或权限不对，重新做第 1 步，再更新第 2 步第 4 项的 Secret。

## 停用

在 Cloudflare 删除 Cron Trigger 或删除整个 Worker；再到 GitHub 删除 `tcl-v2-clock` 令牌。仓库这边不用改，GitHub 自己的定时任务照常作为后备。

## 测试

```bash
node --test external/cloudflare-v2-clock/tests/*.test.mjs
```

测试会检查：每天 33 个发送时间点、北京时间窗口、迟到跳过、请求目标和参数，以及这些参数都在 `v2-monitor.yml` 中声明过。
