# R3.23 真实运行结果与"直播中"入口离线修正（Claude，2026-11-13）

结论：**PASS_WITH_LIMITS**。访问链路和主页身份已经在真实页面上跑通，但真实直播间页面的身份核验还没有跑过，所以 LIVE 判定目前仍未经过真实验证。本次修正全部在离线环境完成，没有再访问抖音。

## 1. 已批准的真实运行（run 43449924435）

批准范围：2 个已批准账号，只跑 1 轮，手机视口，不登录，只放行两个核心 CDN 的 JS/CSS，遇到 403、验证或登录跳转立即停止。

| 项 | 结果 |
|---|---|
| 访问 | 两个主页都返回 HTTP 200；没有 401/403/429，没有验证或登录跳转，`stopped = null` |
| 核心 CDN | 只有 `lf-douyin-pc-web.douyinstatic.com` 被放行：script 192 个，stylesheet 40 个 |
| 主页身份 | 两个账号都通过核验（最终 URL 完全一致，且页面上只有一个抖音号并且一致），说明 R3.22 的 256 字符路径修正有效 |
| 主页标题 | 两个账号都是空标题（`titleExact=false`）；最终 URL 存在时不依赖标题 |
| 账号 #1 | 页面上有"直播中"链接，但不在猜测的主播信息容器里，所以没有访问直播间；原因被写成 `NO_LIVE_BADGE_NOT_PROOF_OF_OFFLINE`，这与事实不符（缺陷）。加密的私有记录显示，页面上唯一的"直播中"链接就是该账号登记的直播间 |
| 账号 #2 | 页面上没有"直播中"链接 → UNKNOWN |
| 台账 | 真实回执可以导入 R3.22 台账 |
| 收尾 | 撤防提交 6ae4d2d（`if: ${{ false }}`），后续触发的运行 43450144368 被跳过，工作流 417407676 已设为 disabled_manually |

访问方式说明：网络守卫用 `route.fetch({maxRedirects:0})` 取回每个请求，再交给 Chromium。这些请求由 Node 发出（HTTP/1.1、Node TLS），而不是由 Chrome 自己的网络栈发出。这是有意的设计：这样每次只取一跳，不跟随重定向。代价是，这些请求和普通 Chrome 访问不完全一样。本次没有被拦，但不能保证以后也不被拦。

## 2. 离线修正（本提交）

| 编号 | 修改 | 安全约束 |
|---|---|---|
| a | `liveAnchorScope(profile, target)` 新增 `REGISTERED_ROOM_LIVE_ANCHOR`：没有主播信息容器内的链接时，如果已核验的主页上**恰好只有一个**直播间，并且它**等于该账号登记的直播间**，就访问这个直播间 | 只会访问本账号自己的直播间；出现别人的直播间或多于一个直播间时都不访问；判 LIVE 仍需直播间页面的标题、描述、主播主页链接和 URL 全部一致。只传一个参数时行为不变 |
| b | 新原因 `LIVE_BADGE_OUTSIDE_OWNER_SCOPE`：页面上有"直播中"链接，但无法确认属于该账号 | 状态仍为 UNKNOWN，不访问该直播间，也不计入统计 |
| c | 公开回执新增布尔字段：`profileSignals.titleEmpty`；`roomSignals {httpOk,titleEmpty,titleExact,metaExact,ownerLinkExact}` | 只有布尔值，不含标题、ID 或 URL |
| d | 私有加密记录新增 `profileStructure / roomStructure`：每个直播链接和本账号主页链接的祖先标签链（标签名，以及只保留字母的 data-e2e） | 页面只返回编号和路径，Node 端随即把它们转成布尔值；不往页面传任何参数；身份提取函数逐字节不变（sha256 `67882690…35ae`） |

用真实私有记录做离线回放（不输出任何值）：账号 #1 的范围从 `NO_OWNER_HEADER_LIVE_ANCHOR` 变为 `REGISTERED_ROOM_LIVE_ANCHOR`，下次会访问它自己登记的直播间；没有直播间页面时结果是 UNKNOWN / `LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED`。账号 #2 结果不变。

## 3. 测试（可复现）

```sh
node --test tests/r323/*.test.mjs                                   # 7 个单元测试 + 1 个 Chromium 测试（默认跳过）
R320_BROWSER_SMOKE=1 node --test tests/r323/structure-browser.test.mjs
node --test tests/*.test.mjs tests/r3{15,16,18,19,20,21,22,23}/*.test.mjs
sh tests/r322/e2e/run-sealed-e2e.sh /tmp/r323-sealed-e2e            # 需要 root/sudo；在独立网络命名空间里运行，没有出网路由
```

在封闭网络中做端到端测试，被测的是真实 probe：

| 场景 | 期望 |
|---|---|
| NORMAL / FORBIDDEN_FIRST | 与 R3.22 相同（回归） |
| REAL_LAYOUT | 主页标题为空，本账号的直播链接在主播信息容器外 → 访问本账号直播间 → LIVE（`REGISTERED_ROOM_LIVE_ANCHOR`）；另一个账号 UNKNOWN |
| FOREIGN_BADGE | 只有别人的直播间，或者本账号直播间和别人的直播间同时出现 → 都不访问，原因为 `LIVE_BADGE_OUTSIDE_OWNER_SCOPE` |
| ROOM_TITLE_EMPTY | 访问了本账号直播间，但标题为空 → UNKNOWN / `LIVE_BADGE_BUT_ROOM_PAGE_NOT_CROSS_VERIFIED`，`roomSignals.titleEmpty=true` |

另外检查了私有诊断记录的结构：在封闭网络里把它转成布尔值后再检查，记录本身不离开封闭步骤。还确认了台账能导入，并且所有输出里都没有任何登记过的标识。

## 4. 仍然存在的限制

- 真实直播间页面一次都没有访问过。标题、描述和主播主页链接的选择器在真实页面上能否命中，目前未知。如果不能命中，结果会是 UNKNOWN，不会误判为 LIVE。
- OFFLINE 规则仍未经过验证；UNKNOWN 不等于 OFFLINE。
- 再访问真实抖音，需要新的明确授权。
