# R1.9｜抖音 TCL / FFALCON 真实云端巡检复验报告

日期：2026-11-09（北京时间）
目标分支：experiment/r19-douyin-tcl-ffalcon-roster-first
本报告仅针对当前已进行的三次 **只读、单次、无登录的 GitHub Actions 公共浏览器实验**。

## 结论（与 GitHub CI 工作流的成功状态分开）

| 试验 | GitHub 工作流 | 平台真实结果 | 实际证据 |
|---|---|---|---|
| 第 1 轮 | [42578287544](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42578287544) SUCCESS | BLOCKED | 账号主页导航 TIMEOUT；TCL UNKNOWN，雷鸟未访问 |
| 第 2 轮 | [42578588148](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42578588148) SUCCESS | PARTIAL PASS | TCL 和雷鸟两个主页都取得直播徽标与动态 room_id；由于程序字段名映射错误，未进入直播页二次核验 |
| 第 3 轮 | [42578776368](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42578776368) SUCCESS | BLOCKED | 修正二次跳转字段后，TCL 主页触发 ACCESS_OR_AUTH_BLOCKED；雷鸟被安全停机规则跳过 |

**不能因 CI workflow 是绿色，就说平台端到端巡检已完成。**
第三轮遇到限制后，本阶段停止对该 GitHub 出口重复访问，不继续高频探测。

## 第 2 轮真实取得的两个动态场次入口

| 账号 | 抖音号 | live.douyin.com 路由 ID | 当次动态 room_id | 身份 | 状态 |
|---|---|---|---|---|---|
| TCL官方旗舰店 | 79013748820 | 31878890513 | 7705907855488043785 | 主页通过 | 主页显示直播中；房间二次确认未执行 |
| FFALCON雷鸟电视旗舰店 | 83165143028 | 988541363148 | 7705939961182636842 | 主页通过 | 主页显示直播中；房间二次确认未执行 |

两个 room_id 与前一轮正常浏览器观察吻合。**这仍不足以证明上下播时刻或房间页二次验收。**

第 2 轮的技术问题：\`corroborateDouyin(profile, null)\` 将直播路由输出为 \`room_id\`，而 \`public-one-shot.mjs\` 错误地读取了 \`preview.live_route_id\`。结果符合 \`ROOM_PAGE_NOT_VISITED\`，属于 R1.9 自身代码缺陷。该字段名已修正并新增回归测试。

第 3 轮状态：\`UNKNOWN / ACCESS_OR_AUTH_BLOCKED\`。未尝试绕过访问控制、破解验证码或高频重试。

## R1.9 可用能力

1. **14 个独立 secUid 的账号台账**，其中首期 TCL/雷鸟大家电监控 12 个；AR/第三方经销商默认隔离。
2. **8 个真实主页“直播中”线索**，包含新发现的「FFALCON雷鸟大家电旗舰店」和「FFALCON雷鸟显示器旗舰店」。
3. 主页 secUid + 抖音号 + 昵称的严格核实，以及受限时 UNKNOWN。
4. 从直播入口读取动态 \`room_id\`，不能固定用过去的 room_id；允许同一账号后续换场。
5. 直播页二次确认规则：严格匹配路由 ID、动态 room_id、房间页面标题、meta Description；只有同时满足才允许确认 LIVE。
6. \`DurableStore\` 集成：每个真实巡检观察写入本轮工作目录，状态、事件、冷却、时间戳保存在同一事务。
7. 12 个账号的整点/手动巡检清单和幂等检查；**目前只生成清单，不会自动访问所有账号**。

## 未通过 / 未执行

| 项目 | 当前结果 |
|---|---|
| GitHub 公共浏览器读取 TCL 主页直播入口 | PASS（第 2 轮） |
| GitHub 公共浏览器读取雷鸟主页直播入口 | PASS（第 2 轮） |
| 登录与安全限制检测 | PASS（第 3 轮自动停止） |
| 实际直播房间的二次核验 | BLOCKED |
| 12 个目标账号逐小时稳定巡检 | NOT_EXECUTED |
| 实体直播间与多账号去重 | NOT_EXECUTED（目前只能证明账号不同） |
| OFFLINE 真实停播证据 | NOT_EXECUTED |
| 直播时长累计与满播率 | NOT_EXECUTED |
| GitHub Actions 跨运行长期持久化 | NOT_EXECUTED |
| 自动生产 cron | NOT_ENABLED |
| main 合并或部署 | NOT_EXECUTED |

## 正确的后续门禁

1. 停止继续从本次被阻断的 GitHub 出口立即重复请求。
2. 在能正常打开公开页面的**合法浏览器会话**中先完成 1 个直播间页面的二次身份验证；受限时仍 UNKNOWN。
3. 用明确的 LIVE 正例和真实停播 OFFLINE 正例验证状态机；没有可靠的 OFFLINE 来源，继续 UNKNOWN。
4. 验证至少一次不同整点和不同会话的真实 room_id 变化，之后再讨论连续时长统计。
5. 明确经过审核的云端持久化与成本约束后，才能启用无人值守的整点自动巡检。

## 复验

离线测试：

    node --test tests/*.test.mjs

仅生成检查计划，不访问抖音：

    node probes/r19/cli.mjs --mode hourly --at 2026-11-09T06:04:00Z --out r19-plan.json

真实公开浏览器程序（**当前不建议立即从 GitHub 重复执行**）：

    node probes/r19/public-one-shot.mjs

相关源码：

- \`config/r19-douyin-tcl-ffalcon-registry.json\`
- \`probes/r19/douyin-first.mjs\`
- \`probes/r19/douyin-bridge.mjs\`
- \`probes/r19/public-one-shot.mjs\`
- \`tests/r19-douyin-roster.test.mjs\`
- \`tests/r19-douyin-dual-page.test.mjs\`

不包含 Cookie、令牌、密码、原始网页正文或用户私人数据。
