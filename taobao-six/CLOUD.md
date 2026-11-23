# 部署 CloudBase 云函数和手机看板

准备一个腾讯云开发环境、用于部署的 Node.js 和 CloudBase CLI。以下命令在解压后的项目根目录执行。配置适用于有文档数据库、HTTP 云函数、HTTP 访问服务和静态网站托管的 CloudBase 环境。

## 1. 创建集合并设置权限

在控制台进入目标环境的「数据库」，新建文档集合 `tcl_live_status`，将客户端访问权限设为「仅管理员可读写」或等价的客户端读写均关闭规则。首次有效推送会创建文档 `_id = latest`。全系统只保存这份最新快照。

| 字段 | 含义 |
|---|---|
| `updatedAt` | 本地采集到这次状态的 UTC 时间，ISO 8601 字符串 |
| `liveCount`、`totalCount` | 在播店数和这次快照中的全部店数 |
| `shops[]` | 每行保存 `name`、`isLive`、`liveUrl`、`startTime` |
| `startTime` | 首次观察到当前直播的时间。离线填 `null` |
| `liveUrl` | 同一卡片的淘宝直播间 URL，形如 `https://tbzb.taobao.com/live?liveId=数字`。离线或已确认在播但链接尚未识别时填 `null` |

服务端检查店名唯一、总数与在播数一致、时间和链接合法。写入时用数据库条件更新，使旧推送无法覆盖新的快照。相同时间、相同内容的重试可重复提交，同时间内容冲突会返回 409。

## 2. 部署两个 HTTP 云函数

安装 CLI 并登录。把命令里的 `你的环境ID` 替换为控制台实际值。同名函数已有其他用途时，请先选独立环境。

```bash
npm install -g @cloudbase/cli
tcb login
cd cloud
chmod +x functions/*/scf_bootstrap
tcb fn deploy --all -e 你的环境ID
cd ..
```

配置使用 Node.js 20.19，在云端安装 npm 依赖。两个可执行的 `scf_bootstrap` 随各自的函数上传，启动监听 9000 端口的 HTTP 服务。[CloudBase 部署说明](https://docs.cloudbase.net/cli-v1/functions/deploy)

在控制台每个函数的「函数配置 → 环境变量」填入以下值，保存并等待新配置生效。

| 变量 | 使用位置 | 填写内容 |
|---|---|---|
| `CLOUDBASE_ENV_ID` | 两个函数 | 目标环境 ID |
| `CLOUDBASE_APIKEY` | 两个函数 | 在该环境创建的**服务端 API Key**，需具备相应集合权限。与下行的写入令牌分别生成，保存在函数环境变量中 |
| `API_TOKEN` | 仅 updateLiveStatus | 本地采集端使用的随机写入令牌，在本地对应 `CLOUDBASE_API_TOKEN` |

可在本机执行 `python -c "import secrets; print(secrets.token_urlsafe(32))"` 生成写入令牌。手机看板只使用读接口 URL。Web 云函数访问云数据库需要配置服务端凭据。[CloudBase 云函数资源鉴权](https://docs.cloudbase.net/cloud-function/resource-integration/cloudbase)

## 3. 核对 HTTP 地址

在「HTTP 访问服务」查看自动创建的路径，复制完整的 **HTTPS** URL。未自动绑定时，在控制台选择当前环境的访问域名、关联资源「云函数」，手动绑定下表两条路径。网关级设为允许匿名 HTTP 访问，写接口由函数内部校验 `x-api-token`。

| 方法、路径 | 云函数 | 访问方式 |
|---|---|---|
| POST `/api/updateLiveStatus` | updateLiveStatus | 采集端设置 `CLOUDBASE_UPDATE_URL` 为完整 URL 并提供令牌 |
| GET、OPTIONS `/api/getLiveStatus` | getLiveStatus | 看板公开读取；返回 CORS 响应头和 `Cache-Control: no-store` |

首次推送前直接打开读 URL，应得到 HTTP 404 和 `{"error":"no_snapshot"}`。写 URL 收到未带令牌的 JSON POST 会返回 401，写令牌尚未配置时返回 503。若返回平台登录页面，核对路由指向、网关的公开访问策略以及绑定域名。[HTTP 访问服务](https://docs.cloudbase.net/en/cloud-function/quick-start)

## 4. 上传手机看板

在控制台开通「静态网站托管」。若其域名与 API 域名不同，在 `web/index.html` 找到 `const READ_API`，把值改为上一步复制的完整读 URL。若两个服务已在同一域名正确映射，保留默认相对路径即可。

仅上传 `web/` 目录中的静态页面。可用静态托管控制台上传到网站根目录，或在项目根目录执行：

```bash
tcb hosting deploy ./web / -e 你的环境ID
```

用手机浏览器或微信打开托管的 HTTPS 首页。完成一次有效本地扫描后，核对手机总数、名单和时间与本地日志一致。停采超过 5 分钟后，看板应显示数据过期提示并保留最近一次快照。[静态托管上传](https://docs.cloudbase.net/cli-v1/hosting/deploy)

本地验证后端的鉴权、乱序写入、幂等和读写返回格式可运行 `node --test cloud/test/status.test.js`。该测试使用内存数据库替身；真实环境中的数据库权限、网关和域名需在自己的环境完成联调。
