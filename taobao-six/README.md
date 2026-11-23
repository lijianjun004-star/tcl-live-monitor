# TCL 淘宝直播监控

手机和微信打开 CloudBase 看板。本地一台装有 Google Chrome 的机器负责采集，开播窗口墙也显示在这台机器上。要连续监控，需要保持采集进程运行、网络可用、主机处于唤醒状态。仅查看看板的手机不需要登录淘宝。

| 模块 | 文件 | 用途 |
|---|---|---|
| 本地 | monitor_local.py、search_page.py、cards.js、wall.py | 登录、轮询搜索页、计时、推送、平铺窗口 |
| 名单 | expected_shops.json | 由人工基准提取的 20 个店名，用于识别缺卡；额外发现的店铺也会计入 |
| 已核实的六家店 | verified_shops.json | 同标签页模式按完整店名逐家核对，输出开播、未开播或未知 |
| 后端 | cloud/ | 两个 Node.js HTTP 云函数、部署配置及后端测试 |
| 手机 | web/index.html | 可上传到静态托管的单文件看板 |
| 部署 | CLOUD.md | 数据库权限、云函数环境变量、HTTP 路由和手机页面上传步骤 |

## 手机通过 Codespaces 核对六家店

名单来自人工确认，涵盖 TCL电视官方旗舰店、TCL集团官方旗舰店、TCL空调官方旗舰店、TCL冰箱旗舰店、TCL洗衣机官方旗舰店、TCL智能家居旗舰。每次运行都从淘宝主播卡片重新判断开播状态。

在有真实 Google Chrome 和私有 noVNC 桌面的 Codespace，解压到项目目录。从该目录的终端运行：

```bash
python -m pip install -r requirements.txt
DISPLAY=:1 python monitor_local.py --same-tab --once --local-only
```

在手机打开该 Codespace 的私有 6080 桌面，按淘宝页面提示完成登录。确认搜索框是 TCL，选中「主播」并看到店铺卡片后，回到启动脚本的终端按回车。保持 Chrome 标签页开着，脚本在这个标签页读取第一轮。使用已有会话时，将文件解压到原项目目录，并保留原来的 `chrome_profile/`。

只有匹配完整店名的主播卡片参与计数。同一卡片有可用的「进入」按钮算开播，仅有「主页」这个状态按钮算未开播。缺卡、门禁或相互矛盾的结果标为未知。有未知时，已确认开播数是下限。此模式只输出本地观测，原全页模式负责云端看板和视频墙。

需要连续观察时，在同一条命令里去掉 `--once`。终端进程和 Codespace 运行期间，每约两分钟核对一次。按 Ctrl+C 结束。

### 六店结果写入手机看板（需另行确认后启用）

把 `--local-only` 换成 `--push`，并设置 `CLOUDBASE_UPDATE_URL` 与 `CLOUDBASE_API_TOKEN`。终端输出不变。只有六家都得到明确结果、每家开播店都有唯一核实的直播间链接时，才生成新快照并写入 `runtime/six-latest.json` 后推送；缺店、登录或验证提示、链接有歧义时保留上次有效快照，并在标准错误输出原因。推送失败会在下一轮重试同一份有效快照。全页模式与六店模式写同一个看板文档，同一云环境只启用其中一种推送。离线测试：`python -m unittest discover -s tests` 与 `node --test cloud/test/status.test.js cloud/test/six_snapshot.test.js`。

## 第一步　在本地验证全页采集

准备 Python 3.10 或更新版本，以及通过官方渠道安装的桌面版 Google Chrome Stable。在解压后的目录打开终端。首次使用建议新建虚拟环境。

**Windows PowerShell**

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe monitor_local.py --login
.\.venv\Scripts\python.exe monitor_local.py --local-only --once
```

**macOS 或 Linux**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python monitor_local.py --login
python monitor_local.py --once --local-only
```

在弹出的专用 Chrome 窗口里按淘宝页面提示手动登录。看到 TCL 主播卡片后，回到终端按回车。下次启动会使用程序旁的 `chrome_profile/`。同一份配置目录一次只运行一个采集器。确认登录态是否可复用，以第二条运行命令能否实际读出名单为准。[Playwright 持久化配置](https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch-persistent-context)

完整快照要求基准名单都出现、每张卡片可判定，且在播卡片有可验证的直播间链接。「进入」需为有效红色或红橙色控件；只有「主页」的有效卡片计为未开播。解析从同一按钮取链接；按钮没有直接地址时，在临时页正常点击对应店铺的「进入」核对去向。输出保留淘宝域名、直播间路径和明确的 liveId。

`expected_shops.json` 可按现场复核结果编辑。店铺更名或正式退出时先核实，再更新名单；单次少读会使整轮标为未知。6 家开播仅是此前人工观测，每次运行均重新统计。可用 `--expected-shops 路径` 指定另一份店名数组。

## 第二步　部署后端和手机 HTML

按 [CLOUD.md](CLOUD.md) 的顺序创建文档集合 `tcl_live_status`，部署两个函数，绑定 HTTPS 地址，设置函数环境变量，并上传 `web/index.html`。静态托管与函数使用不同域名时，先把 HTML 中的 `READ_API` 改为完整读接口 URL。

手机端公开读取店名、状态、时间和直播间地址。写入令牌只配置在采集机和写函数；数据库服务端凭据只配置在腾讯云函数中。部署静态资源时只上传 `web/`，浏览器登录目录、运行状态、截图均保留在本地。

## 第三步　验证推送并开启长期轮询

**Windows PowerShell**，使用上一步生成的写接口和令牌。在新的终端窗口里要重新设置环境变量，或使用本机的进程管理器注入。

```powershell
$env:CLOUDBASE_UPDATE_URL = 'https://你的网关域名/api/updateLiveStatus'
$credential = Read-Host '输入写入令牌' -AsSecureString
$env:CLOUDBASE_API_TOKEN = [System.Net.NetworkCredential]::new('', $credential).Password
.\.venv\Scripts\python.exe monitor_local.py --once
.\.venv\Scripts\python.exe monitor_local.py
```

**Bash**，先激活前面创建的虚拟环境。

```bash
export CLOUDBASE_UPDATE_URL='https://你的网关域名/api/updateLiveStatus'
read -rsp '输入写入令牌：' CLOUDBASE_API_TOKEN
echo
export CLOUDBASE_API_TOKEN
python monitor_local.py --once
python monitor_local.py
```

先在手机打开看板，核对首次单次推送的数量和店名与终端一致，再保持最后一条命令运行。默认模式每 120 秒开始一轮，遇到耗时超过周期的扫描会等待后再继续，不并发堆积。按 Ctrl+C 可以停止。登录失效时先停止循环，运行 `--login` 并重新启动。

### 打开副屏视频墙

在有图形桌面的主机，用下面的命令代替常规监控命令。Windows 未激活虚拟环境时，将 `python` 替换为前面的虚拟环境解释器路径。

```bash
python monitor_local.py --video-wall --width 1920 --height 1080 --x 1920 --y 0
```

例中副屏位于主屏右侧；左侧副屏可用 `--x -1920`，主屏用 `--x 0 --y 0`。采用系统**逻辑像素**，有显示缩放时按系统报告的逻辑分辨率设置。每家在播店铺一个静音 Chrome 窗口，6 家在横屏排成 2 行 3 列。新场次替换旧窗口，已确认下播时关闭对应窗口。平铺受系统窗口管理器、Chrome 最小窗口尺寸限制。若播放器显示播放按钮，在该窗口点一次播放。可只在本机试墙：`python monitor_local.py --local-only --video-wall`。

### 时间与异常

- `updatedAt` 是最近一次有效全量扫描完成时间。线上保存 UTC，手机显示北京时间。看板每 60 秒拉取一次，超过 5 分钟未取得新观测时变黄，保留上次名单和已观测时长。
- `startTime` 是当前场次本次连续观测的起点。相同房间在后续轮次保留起点。换场、下播后再开、出现未知轮次或有效观测相隔超过 5 分钟会重新计时。淘宝官方开播时间没有参与计算。
- 全部基准店铺均明确未开播时可以发布真实的 0；同时保存调试截图。登录框、验证、缺卡、无法确定链接或页面不稳定时，不覆盖云端快照，也不因这次扫描关闭大屏窗口。
- HTTP 写入只发送规范化快照。云端校验令牌、数量和时间，拒绝时间倒退或同时间内容冲突；客户端只在收到 JSON 成功回执后清除待推送标记。临时断网时本地保留最新有效快照，下轮重试或以更新快照替换它。`runtime/local-only.json` 与推送模式的 `runtime/latest.json` 各自保存。
- `live_debug/` 仅保存最近 24 张截图。截图会遮盖图片、表单和内嵌框架；其余可见文字仍可能有账号信息，分享前请自行检查。

## 离线核验

```bash
python -m unittest discover -s tests -v
node --test cloud/test/status.test.js
```

可选的 Chrome DOM 测试使用合成页面并阻断外部请求。已安装真实 Chrome 时，将环境变量 `TEST_CHROME` 设为 `1` 再运行 Python 测试。可按以下顺序验收真实环境：

1. 单次本地扫描结果与同一时间手机或桌面实际看到的卡片一致，点开在播店铺对应链接，核对店铺和场次。
2. 首次云端推送后，手机显示一致的数量。刷新不改变观测时间。停采超过 5 分钟，手机出现黄色预警。
3. 恢复采集并连接副屏，观察一场实际的开播、下播。检查对应窗口出现、关闭以及手机快照随之更新。
