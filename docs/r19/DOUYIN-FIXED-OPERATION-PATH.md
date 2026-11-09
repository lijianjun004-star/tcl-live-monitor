# R1.9 固定抖音操作路径｜TCL / 雷鸟账号查询与直播核验 SOP

> 状态：实验分支内生效，不是正式巡检部署。基线：PR #30。路径版本：`R19_ACCOUNT_FIRST_V1`。
> 决策：**已在账号台账中的对象，不再优先全网搜索；先用稳定 `secUid` 直达账号主页，再从当次“直播中”链接进入直播间。**

## 每次都按以下固定 7 步操作

| 顺序 | 输入／动作 | 成功证据 | 不满足时 |
|---|---|---|---|
| 01 | 按账号 `key`、完整抖音号或 `secUid` 在本地台账精确查找 | 返回唯一账号、固定主页 `www.douyin.com/user/<secUid>` | 不模糊选号；查不到才转独立发现流程 |
| 02 | 用常规浏览器只打开这个**账号主页一次** | 页面可见；记录实际观测时间（ISO UTC，在展示层换算北京时间） | 超时／403／挑战页，立即记录 UNKNOWN |
| 03 | 三重身份匹配：`secUid` + 页面抖音号 + 账号显示名 | 真实账号身份确认；允许显示名变更后进入人工冲突核验 | 有冲突即 STOP，不能把经销商当官方 |
| 04 | 从账号头像附近寻找**本次新鲜**“直播中”标记和所附正常可点击链接 | `live.douyin.com/<route>?room_id=<dynamic>`（不要求每页都保留参数） | 无标记不是停播证据，UNKNOWN |
| 05 | 仅沿本次页面的直播入口进入一次；不使用台账旧 `room_id` 冒充当前场次 | 记录实际发起导航的 URL + 落地 URL；允许同一路由落地页清除参数 | 异域跳转／其他账号／登录墙立即 STOP |
| 06 | 直播间二次核对：主播账号名、对应主页、可见视频／直播标识、非结束状态 | 主页和直播页双重身份一致时，才能证明**当次确实正在直播** | 有冲突、无足够信号时 UNKNOWN |
| 07 | 只读保存时间和证据来源：账号、路由 ID、动态场次 ID、LIVE/UNKNOWN、访问阻断原因及请求次数 | 账号→场次关联，重复检查可去重；只记录观测时间，绝不捏造真实上下播时刻 | 不根据历史 LIVE 补整段时长，不进行考核 |

### 固定入口、动态场次的区别

```text
业务层 account_key (例如 ffalcon-douyin-tv-flagship)
    └─ 稳定 secUid → www.douyin.com/user/<secUid>  ← 未来优先直达这里
           └─ 当次“直播中”入口 → live.douyin.com/<route>?room_id=<dynamic>
                     └─ 账号／直播 UI 二次核验
                               └─ 仅本次观测；与历史数据独立保存
```

- `secUid`：账号主键；同品牌的电视、大家电、显示器旗舰店是不同账号，不能合并。
- `live route ID`：直播页路径中的编号，如 `988541363148`；可作历史直达参考，**不能证明当下开播**。
- `room_id`：当次页面直播入口里的动态场次参数，例如 `7705939961182636842`，下一场可能变化。
- **固定入口永远是账号主页 URL**，不是历史直播页，也不是淘宝直播官网、搜索引擎页面。
- 若直接打开老直播路由，必须重新和当前账号主页及直播场次交叉验证；不得由老页面推断当前 LIVE。

## 不再重复低效搜索

1. **已知账号（12 个主目标）**：不再检索百度／网页搜索／抖音搜索；先精确命中 `config/r19-douyin-tcl-ffalcon-registry.json`。
2. **名称相似（例如“雷鸟”）**：先列出候选，用户或当前业务上下文选具体 `key`。不同 `secUid` 不合并。
3. **未知新店铺**：另开“新账号发现”路径，从真实公开作者主页读取 secUid 与抖音号，双重核对后才加入候选；不能仅凭搜索关键词判定为集团官方。
4. **无直播标志／访问限制**：一次即停，记录 `UNKNOWN`；不连续刷新、不伪造签名、不轮换代理、不破解验证码。
5. **主播换人／数字人识别**：目前不进入该阶段；先保证“账号身份—直播场次—访问时间”的稳定映射。

## 当前台账与查找命令

运行环境：项目源码 Node.js 22+。以下命令全部**只读本地 JSON，不访问抖音**。

```bash
# 只列出 12 个 TCL/雷鸟主业务账号
node probes/r19/path-cli.mjs --list

# 快速定位特定账户，返回固定主页和标准操作步骤
node probes/r19/path-cli.mjs --key tcl-douyin-flagship
node probes/r19/path-cli.mjs --key ffalcon-douyin-tv-flagship
node probes/r19/path-cli.mjs --key ffalcon-douyin-home-appliances-flagship
node probes/r19/path-cli.mjs --key ffalcon-douyin-monitor-flagship

# 根据抖音号直达，不需完整名称
node probes/r19/path-cli.mjs --key 83165143028

# 名称筛选只查已有台账，不发起互联网搜索，也不会自动选中同名账号
node probes/r19/path-cli.mjs --search 雷鸟
```

当前主目标共 12 个，另外 RayNeo AR 和第三方经销商 2 个默认隔离；`--list --include-adjacent` 可仅供只读登记时列出 14 个，但不自动纳入主巡检。

## 单次真实浏览器的执行开关

`probes/r19/public-one-shot.mjs` 必须显式传入**一个**已确认的账号 key 和 `--execute`，否则不触发平台页面读取：

```bash
# 必须由有授权的操作者在正常浏览器环境中手动调用。
# 仅此一条账号，主页最多一次、当次直播间最多一次；不自动重试。
node probes/r19/public-one-shot.mjs --key ffalcon-douyin-tv-flagship --execute
```

不得在 GitHub 已遇挑战后反复执行。现有 GitHub Actions 的平台实时访问**不稳定**；上游普通浏览器的成功不能自动证明 GitHub 云端每次都能复现。

## 判定标准与数据字典

| 字段 | 语义 |
|---|---|
| `account_key`, `sec_uid`, `display_douyin_id` | 稳定身份映射 |
| `profile_url` | 每次从这里开始，始终使用账号主页 |
| `live_route_id` | live.douyin.com 路由路径，不是动态场次 |
| `dynamic_room_id`／`live_id` | 从当次主页直播中链接取得的场次 ID；落地页未额外校验时记录来源为 `FRESH_PROFILE_BADGE_LINK` |
| `observed_at` | 单次实际观测 UTC 时间；不是精确开播时刻 |
| `source_attested` | 双页证据通过才可为 true；不能由离线 fixture 充当真实核验 |
| `state` | LIVE / OFFLINE / UNKNOWN。当前**OFFLINE规则未验证**，不能用“没有直播标签”输出 OFFLINE |
| `failure_code` | 时间过期、身份冲突、验证码／登录墙、请求超时、未取得直播页等原因 |
| `room_page_second_verification` | 直播间页面独立核对状态，不能由主页徽标代替 |

**异常停车规则**：验证码、需登录但无人完成合法登录、429、访问限制、直播页身份冲突、跨房间重定向、出乎意料的场次变化等均立即 STOP。记录 UNKNOWN 和失败原因；不得通过不断切换浏览器、账号或网络出口规避限制。

## 验收限制和持续工作边界

- 2026-11-09 的正常浏览器已见到 TCL 主旗舰店与 FFALCON 雷鸟电视旗舰店的真实 LIVE 页面，仅证明**当次**而非持续直播。
- GitHub Actions 一度获得两个账号主页直播标记与动态 `room_id`，但之后遇到 `ACCESS_OR_AUTH_BLOCKED`。因此不能说 GitHub 端到端长期巡检已可用。
- 由于部分证据没有可信精确分钟，不能据此回填直播时长、上下播时间或满播率。
- 每次后续只需要报**账号 key / 抖音号**，就可以沿本 SOP 直达账号，节省全网搜索时间。
- 当前不合并 PR、不启用无人值守 Cron、不部署、不修改 `main`、不开展考核。

## 复验命令

```bash
node --test tests/r19-operation-path.test.mjs
node --test tests/*.test.mjs
```

本 SOP 与 `probes/r19/operation-path.mjs`、`probes/r19/path-cli.mjs` 作为统一版本控制来源，后续如要改变路径必须更新版本与回归测试。
