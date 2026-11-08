# Agent D｜统一接口与京东 / 抖音

任务：TCL-R18-20261108；领域：多平台适配 / 数据契约；总负责人：Agent 0；执行者：Agent D。来源版本 R1.7 `b940f90ba2c901cdbb8aea334304c0183959f1b1` 与 R1.8 接力包。预算：0 付费 API；平台公开页每平台一次业务请求、不重试；Gemini 0 次。状态：代码完成；平台实时状态验收 BLOCKED。

## 已实现

- `probes/r18/schema.mjs`：`normalizeObservation(input,{now,maxAgeMs,expectedAccountId})`、`validateIdentity`。统一 snake_case，store_key 从平台和期望账号重算，忽略外来 store_key。淘宝固定账号2050532947；其他平台由已核准 target 提供 expected_account_id。
- 来源未核验、账号不符、过期、未来超过60秒、推荐内容、同时冲突、LIVE无liveId、平台失败码：全部 UNKNOWN，不产生默认 OFFLINE。
- `observed_at`（兼容 evidence_at）优先于 actual_check_at 判断过期；默认 maxAgeMs=3600000。`now`默认actual_check_at，便于历史离线重放；实时调用者必须提供真实actual时间。
- `source_attested`是适配器内部证据判定边界，不是用户上传JSON的真实性证明；不得将任意外部JSON的true直接视为已校验。适配器须先核验页面/响应归属后才能设置true。
- `exact_start_end`及`exact_start_end_time`恒为false。roomId不含130742硬门槛。
- `sources/jd/index.mjs`、`sources/douyin/index.mjs`均导出async observe；支持传入正常页面snapshot或capture函数，不请求隐藏接口、不产生签名、不加载Cookie。

## 旧代码审核与范围

- 京东 `probes/lib/tcl-jd-all.mjs` 针对已有授权运营平台GET API。它保留internal room/shop与public shop、liveId的不同ID层次，并检查分页/冲突等。当前缺少此实验的运营平台可用地址、授权和动态liveId映射，不能仅凭内部roomId宣称平台当前场次已核验。R1.8不自动接通该旧路径。
- 抖音 `probes/lib/douyin.mjs` 已有严格主页身份 + 直播间页面双页交叉核验，OFFLINE候选规则默认未校准。R1.8复用既有项目自身纯函数分析；旧URL roomId不等于新场liveId，因此本轮返回UNKNOWN / NO_ATTESTED_DYNAMIC_LIVE_ID，预留后续经审计的被动数据适配。
- 检查已有 `config/probe-targets.json`、`config/jd-ops-crosswalk-template.json`；未修改既有范围与业务记录。

## 实际公开访问证据

| 路径 | 真实执行 | HTTP | 结果 | 理由 |
|---|---|---:|---|---|
| 京东配置已有公开店铺入口407681 | 2026-11-08 11:48 UTC，一次普通GET | 200 | BLOCKED | 最终host为www.jd.com，无法取得目标直播身份与场次证据 |
| 抖音已批准TCL官方旗舰店公开主页 | 2026-11-08 11:48 UTC，一次普通GET | 200 | BLOCKED | 响应body为0字节，无有效目标证据 |

证据：`docs/r18/evidence/jd-public-check.json`、`docs/r18/evidence/douyin-public-check.json`。只存状态、已公开URL、body长度/hash及failure；未存响应正文、headers、Cookie、token，未截图。正常重定向由标准HTTP客户端跟随；没有循环重试、隐藏API或地区/登录控制规避。

## 验证

- 两个adapter模块实际import PASS。
- schema十项基础断言PASS：有效LIVE、有效OFFLINE；账号不符、来源无核验、throttle、stale、推荐、缺liveId、冲突均UNKNOWN；时间精度false。最终独立测试数量以Agent F全回归为准，不将这些断言重复计数。
- 真实京东、抖音动态新场次端到端：BLOCKED。
- 登录会话与24h运行：NOT_EXECUTED。

## 下一锁

先让用户在自己的正常浏览器会话打开已核准主页，取得一次不含凭证的有效页面身份/动态liveId归属证据，再单独为该平台增加具证据的解析规则。当前不恢复开发者账号/AppKey/TMC路线、不将旧状态当实时结果。
