# 交接：把 V2 天猫巡检放到用户自己的电脑上跑（给 Codex）

更新：2026-11-23。用户已选择方案 A：用自己长期开着的电脑，作为 GitHub Actions 自托管运行器（self-hosted runner）跑 V2 的 live 任务。由 Codex 在这台电脑上执行。本文件是唯一的任务说明，先读完再动手。

## 1. 为什么要换到这台电脑（已核实的事实）

| 事实 | 证据 |
| --- | --- |
| GitHub 的定时任务大量漏发：jd-r23 每小时设 7 次，11-21 全天只跑 4 次；v2-monitor 约 19 小时只跑 3 次 | Actions 运行记录；已用外部定时器解决（`external/cloudflare-v2-clock/`，PR #120） |
| GitHub 海外运行器打开 TCL电视官方旗舰店店铺页，被直接转到 `tcldq.world.tmall.com/…/_____tmd_____/punish`（页面标题"验证码拦截"）。用户经手机远程画面操作 916 次，淘宝没有放行 | [运行 45086892501](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/45086892501) |
| 手机到云端的拖动转发本身是通的：练习滑块远程拖动通过 | [运行 45083249032](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/45083249032) |
| 同一时段，天猫 9 家店的一轮读取：5 家在播、3 家被跳转、1 家状态不明确，没有出现验证 | [运行 45086338141](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/45086338141) |

所以，问题出在运行环境（海外机房、无界面的自动浏览器），不在代码或拖法上。目标是让同一套 V2 代码在用户家里的网络和正常的 Chrome 上运行。

## 2. 要达成的结果（验收标准）

1. 这台电脑注册为本仓库的自托管运行器，标签为 `tcl-pc`，北京时间 08:00–24:00 在线。
2. 仓库变量 `V2_RUNNER=self-hosted` 时，`v2-monitor.yml` 的 `live` 任务在这台电脑上运行；不设这个变量时，仍在 `ubuntu-24.04` 上运行，现有行为不变。
3. 在这台电脑上手动触发一轮（`engine=live`）：证据文件和 `v2-state` 正常上传，结果站能刷新。
4. 在这台电脑上跑一次 `experiments/tmall_shop_path/shop_path.py`（店铺页 → 直播入口 → 直播页）。如实记录：店铺页是否还出现验证；出现时用户在电脑上用鼠标完成，或开启 `HUMAN_VERIFY=1` 用手机完成，淘宝是否放行；能否拿到当前场次的 `liveId`。
5. Cloudflare 外部定时器上线后，连续一天的运行都落在这台电脑上，`CAPTCHA_X5SEC` 的次数和 GitHub 运行器做对比。

以上每一项都写进本文件末尾的"执行记录"，附运行链接。没有做到的写明原因，不能写成已完成。

## 3. 仓库侧改动（在独立分支上做，开 PR）

1. `v2-monitor.yml` 的 `live` 任务：
   - `runs-on: ${{ vars.V2_RUNNER == 'self-hosted' && fromJSON('["self-hosted","tcl-pc"]') || 'ubuntu-24.04' }}`
   - 给 `live` 任务加 `defaults: run: shell: bash`。Windows 上用 Git Bash；现有步骤用到了 `[[ ]]`、`sha256sum`、`jq`。
   - "Install Chromium" 只在 Linux 上加 `--with-deps`。
   - 下载 cloudflared 时按 `RUNNER_OS` 选文件（Windows 用 `cloudflared-windows-amd64.exe`），并把实际路径写入 `HUMAN_VERIFY_TUNNEL`。
   - 新增 `V2_HEADED: ${{ vars.V2_HEADED }}` 环境变量。
2. `src/v2_run.py`：`BrowserFactory(headless=env.get("V2_HEADED") != "1")`。用户的电脑设 `V2_HEADED=1`，用有界面的正常浏览器。
3. 测试：`tests/v2/test_schedule_workflow.py` 增加对上面 `runs-on` 和 `defaults` 的断言；`pytest tests/v2` 和 `node --test tests/*.test.mjs` 必须全部通过。

## 4. 电脑侧步骤（Windows；macOS 同理，换成对应安装包）

1. 建一个专用的 Windows 本地账户（非管理员）来跑运行器，不要用日常账户。
2. 安装：Git for Windows（自带 Git Bash、sha256sum）、Python 3.11、GitHub CLI（`gh`，`scripts/restore_v2_state.py` 要用）、jq。
3. 按 GitHub 仓库 Settings → Actions → Runners → New self-hosted runner 的页面指引下载并配置运行器，标签加 `tcl-pc`。
4. 有界面浏览器需要已登录的桌面会话。用这个专用账户登录桌面，用 `run.cmd` 前台启动运行器，不要装成系统服务。
5. 电源设置：08:00–24:00 不睡眠、不休眠；Windows 更新避开这个时段。
6. 在仓库 Settings → Variables 设 `V2_RUNNER=self-hosted`、`V2_HEADED=1`。需要手机远程验证时，再设 `HUMAN_VERIFY=1`。

## 5. 安全要求（必须遵守）

- 本仓库是公开仓库，GitHub 不建议公开仓库使用自托管运行器。至少做到：
  - Settings → Actions → General：来自外部协作者的 fork PR 工作流一律需要批准（Require approval for all outside collaborators）。
  - 只有 `v2-monitor.yml` 的 `live` 任务使用 `tcl-pc` 标签；不要给任何由 `pull_request` 触发的工作流加这个标签。
  - 专用账户，非管理员；这个账户里不保存与巡检无关的个人资料。
- 不把 Cookie、密码、令牌写进仓库、日志或聊天。
- **不做反检测伪装**：不修改浏览器指纹，不隐藏自动化特征，不使用"stealth"类插件，不自动拖滑块、不自动画线、不自动识别验证码。验证只能由用户本人完成。
- 不提高访问频率：保持每 30 分钟一轮，遇验证即停的熔断规则不变。

## 6. 回滚

删除仓库变量 `V2_RUNNER`，`live` 任务就回到 `ubuntu-24.04`。停止电脑上的运行器，并在 Settings → Runners 里移除它。

## 7. 执行记录（Codex 填写）

| 日期 | 项目 | 结果 | 运行链接 |
| --- | --- | --- | --- |
| | | | |
