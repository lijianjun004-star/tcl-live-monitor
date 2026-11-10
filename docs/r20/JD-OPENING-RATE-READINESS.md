# TCL 京东开播率 R2.0｜真实排班 × 公开身份映射 × LIVE 证据准入

基线：`main@b0861d9fc4d5ba19db62dbc0658dae7b8bfa2ddc`。本分支 **只做证据审计、计算门禁和离线验收；不合并、不部署、不增加 cron**。

## 当前结论

京东有两轮真实 TCL 运营来源的内部巡检，**6 个内部房间中有 5 个 LIVE 和 1 个 UNKNOWN**。但是：

- 6 个 `ops_room_id` 与 6 个 `ops_shop_id` 是运营平台**内部编号**，不能直接视为京东平台公开店铺 ID、主播 ID 或 JD 动态直播场次 ID。
- `config/jd-ops-crosswalk-template.json` 的 6 个账号 `identityCrosswalkVerified:false`；截至本轮尚无用户审核通过的外部账号对应关系。
- 当前 main 仓库**没有可用于对账的已核实正式排班**，因此无法确定应开播分母。
- 未经验证的停播判断不能把 UNKNOWN 当作未开播。
- 11 月 7 日巡检发生在 16:47/16:52 左右（北京时间），日志打印时刻不是上下播时间，也不能证明每一个排班的开播是否迟到。

因此 **5/6=83.3% 只是一种错误的开播率算法**。正式指标保持空值 `null`，不可作为人员考核。

历史日志证据：
[2026-11-07 两轮真实巡检](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42356978045)。

## 数据主键必须分开

| 类型 | 例子 | 含义 | 是否可直接计算开播率 |
|---|---|---|---|
| 内部 `ops_room_id` | `17` | TCL 运营监控房间 | 否 |
| 内部 `ops_shop_id` | `18` | TCL 运营店铺行 | 否 |
| `public_jd_account_id` | 需真实核实 | 京东平台公开账户身份 | 身份确认后才可映射 |
| `jd_live_session_id` | 动态、待核实 | 京东每场直播的场次 | 必须与对应公开账号归属一致 |
| `shift_id` | 排班每个班次 | **开播率分母** | 需要已核实排班 |
| `observed_at` | UTC ISO | 实际成功观测时间 | 不等于真实开播时间 |

主键链路：

```text
已核实排班 shift_id + 计划北京时间段
         ↕ ops_room_id
内部运营房间 + ops_shop_id
         ↕ 独立身份核验（当前六个全部 PENDING）
京东公开店铺 / 公开直播账号
         ↕ 新鲜、可信的 LIVE 证据
直播场次 / 实际观测时间
         ↓
每班次开播证据 / 5分钟内已观察到直播 / UNKNOWN
```

## 开播率与准时开播率区分

正式开播率的候选公式：

```text
开播率 = 已确认实际开播的已到期班次数 ÷ 应开播的已到期班次数 × 100%
```

准时开播率另算：

```text
准时开播率 = 计划时刻起5分钟内被可靠观测为LIVE的班次数 ÷ 应开播的已到期班次数 × 100%
```

注意：

1. 开播率以**排班班次**为单位，不以正在直播的房间数量为分母。同一房间一天多个班次不能丢失。
2. 正好在排班开始后 2 分钟观测到 LIVE，可以确认不晚于 +2 分钟已开播；在 +20 分钟首次发现 LIVE，只能确认“曾经开播”，**不能反推出迟到了 20 分钟**。
3. 如果有 UNKNOWN、排班或身份冲突，返回 `opening_rate_percent:null`，并输出尚未解决的班次数。只有全部已到期班次都有可信正例时，当前仅可得 100%；**任何低于 100% 的真实开播率都需要经平台或其他可靠手段验证的未开播证据**，当前未满足。
4. 若未取得相应分母或可验证的直播账号，不能由 5/6 房间状态填补缺口。
5. 计划开播时间以北京时间 `+08:00` ISO 字段存入，观测时间以 UTC `Z` 存入；支持跨午夜到次日 02:00 的班次。
6. 排班变更只接受计划开始以前发生的修订，避免事后改写分母。原始 Excel 不能被覆盖；应另存转换和审核版本。

## 本轮交付文件

| 路径 | 用途 |
|---|---|
| `config/r20-jd-crosswalk-review.json` | 6 个内部运营房间的外部账号身份审核表；全部 PENDING |
| `config/r20-jd-schedule-inbox.json` | 空排班入口；必须由真实排班材料填充 |
| `docs/r20/evidence/jd-2026-11-07-two-rounds.json` | 两轮历史真实监控结果，保留来源不外推 |
| `probes/r20/jd-historical-audit.mjs` | 历史证据质量检查，禁止造出 83.3% |
| `probes/r20/jd-opening-rate.mjs` | 计划班次、店铺身份、观察正例的准入与开播率就绪门禁 |
| `probes/r20/jd-opening-rate-cli.mjs` | 生成离线审计报告，不访问京东或运营平台 |
| `tests/r20-jd-*.test.mjs` | 身份冲突、错误的时间、夜间班次、5分钟、UNKNOWN、重复等回归 |
| `.github/workflows/r20-jd-opening-rate-offline.yml` | 仅运行离线回归，保留 JSON 审计输出 |

## 核验与转换要求

来自实际排班的 JSON 样式（**示例仅供格式参考，不是实际排班**）：

```json
{
  "schema_version": 20,
  "timezone": "Asia/Shanghai",
  "shifts": [
    {
      "shift_id": "EXAMPLE-DO-NOT-USE",
      "platform": "jd",
      "ops_room_id": "17",
      "starts_at": "2026-11-10T18:00:00+08:00",
      "ends_at": "2026-11-10T22:00:00+08:00",
      "revision_at": "2026-11-10T10:00:00+08:00",
      "schedule_verified": false,
      "schedule_evidence_ref": null
    }
  ]
}
```

以上 `schedule_verified:false` 不允许参与正式开播率。需要真正取得排班来源后才能改为 true。

公开账号审核表中 `identity_status:'VERIFIED'` 必须配有实际可复查的 `https` 证据、外部京东账号 ID、对应内部房间和内部店铺编号。填写认证状态的人必须进行独立复查，程序不会仅凭“认证”文字自动验证其真实性。

实际巡检证据至少需：`ops_room_id`、`ops_shop_id`、UTC `observed_at`、明确的 `state`、可信 `source_ref`、身份匹配通过的 `identity_attested` 和状态证据通过的 `state_attested`。**历史日志中的打印时刻不能填作精确观测时间**。

## 执行方法

```bash
# 当前默认文件全部保守处理：正式开播率空值
node probes/r20/jd-opening-rate-cli.mjs --as-of 2026-11-10T12:00:00Z --out r20-jd-readiness.json

# 回归
node --test tests/r20-jd-opening-rate.test.mjs
node --test tests/r20-jd-historical-audit.test.mjs
node --test tests/*.test.mjs
```

### 下一阶段验收门禁

- A：从用户认可的原始排班导出具体 `shift_id`、对应内部房间 ID、每个班次起止时间与后续变更时间，验收数据完整；
- B：逐店核实六个运营房间对应的**真实京东公开账号身份**，不能以内部编号数字强绑；
- C：在排班开始前后实际执行可重复的观察；关键时段需至少 5 分钟一次，单靠整点一小时巡检不足以判定 5 分钟迟到；
- D：取得独立的可靠未开播/下播证据，避免把 UNKNOWN 当未开播；
- E：在独立云端测试中检查一次跨午夜排班、一次动态调整、一次网络阻断和持久化后，才能考虑启用自动巡检。

**当前仍不得对外发布正式京东开播率，且保持不更改 main、不合并历史 PR、不部署、不启用生产定时任务。**

## 新发现：京东公开店铺与个人资料库排班

### 京东公开店铺核验（2026-11-10）

正常只读浏览器打开 https://mall.jd.com/shopLevel-721631.html ，核对到 TCL官方旗舰店的公开店铺资质信息页面，但导航、内容及页脚没有发现明确归属于本店的直播入口。该页面不能作为 OFFLINE、京东公开直播账号 ID 或开播率的证据。浏览器记录：https://agent.tinyfish.ai/runs/d1d93650-daa8-4c36-a057-c6c82dbf941e

对应机器记录：docs/r20/evidence/jd-tcl-flagship-public-shop-check.json。京东公开店铺候选：config/r20-jd-public-store-candidates.json，均保持 UNMAPPED_CANDIDATE，不得自动绑定内部 ops_room_id。

### 私人资料库排班候选（尚未批准用于本监控项目）

用户既有个人资料库《2026年11月排班优化版.xlsx》中出现「东」平台，但源文件说明包含优化建议、候选确认、待审批班位；未证明该「东」对应本项目全部六个 TCL 京东房间，缺少每班 ops_room_id 身份关联。

因此仅标记为待审的排班来源候选；不得把人员姓名同步到公开 GitHub，不覆盖原表，不假定优化排班已正式生效，不转换为已经验收通过的京东开播率分母。只有核实文件业务归属、正式排班版本及逐班身份映射后才能导入。
