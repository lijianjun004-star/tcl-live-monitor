# 给 Codex 的落地执行清单（Step 5）

分支：`feat/v2-modular-architecture`（基于 `7dd3dec`）。Claude 只提交了代码和文档，**没有写入 `.github/workflows/`，没有配置任何 Secret，也没有访问任何真实平台页面**。以下每一步都由 Codex（或仓库所有者）执行并留存证据。

## 0. 提交清单

| 提交 | 内容 |
|---|---|
| `docs(v2): legacy reuse…` | `docs/v2/LEGACY_REUSE.md`：Step 1 旧代码复用与变更清单 |
| `spec(v2): freeze…` | `SPEC.md`、`schemas/*.json`、`config/targets.example.json`（只有占位值） |
| `feat(v2): four-layer…` | `src/core`、`src/platforms/{jd,ali_live}`、`src/output`、`src/v2_run.py`；`requirements.txt` 新增 `jsonschema==4.26.0`；`.gitignore` |
| `test(v2): offline…` | `tests/v2/`（13 个测试文件 + `conftest.py`）、`pytest.ini`、`requirements-dev.txt` |
| `ci(v2): proposed…` | 本文件与 `ci/v2-monitor.yml.proposed` |

## 1. 本地 / Runner 离线验证（无需任何 Secret）

```bash
python -m pip install -r requirements-dev.txt
python src/single_room_probe.py --self-test          # 旧探针自检，必须仍然通过
python -m playwright install --with-deps chromium
python -m pytest                                      # 预期：175 passed
python src/v2_run.py --targets config/targets.example.json --engine fake \
  --out v2-evidence --state-dir state --dashboard docs/index.html --no-notify --no-drive
(cd v2-evidence && sha256sum --strict --check SHA256SUMS.txt)
```

| 预期结果 | 说明 |
|---|---|
| `175 passed` | 其中 5 个真浏览器用例全部由本地伪造响应应答，不访问外网。没有 Chromium 时显示 `170 passed, 5 skipped`，同样算通过 |
| dry-run 输出 `"verdict": "canary_passed"`，退出码 0 | 假引擎下 8 个示例目标都是 `OK` |
| `sha256sum` 每行显示 `OK` | 证据包完整 |

Claude 已在 Python 3.11.18 和 3.13 下各跑过一次，结果都是 175 passed（本地 Chromium 153）。

## 2. 落盘工作流（需要 Workflows 权限，由 Codex 或你执行）

```bash
cp ci/v2-monitor.yml.proposed .github/workflows/v2-monitor.yml
git add .github/workflows/v2-monitor.yml && git commit -m "ci(v2): enable V2 monitor workflow (manual + branch push)"
git push origin feat/v2-modular-architecture
```

- 触发方式只有两种：推送到本分支（只跑 `offline` job，不读取任何 Secret），以及手动 `workflow_dispatch`。
- **没有定时触发**。是否加 cron、多久一次，需要你另行明确决定。

## 3. 需要配置的 Secrets（只列名称，值由你在 GitHub Settings → Secrets 中填写）

| Secret | 必需 | 说明 |
|---|---|---|
| `V2_TARGETS_JSON` | 是（仅 live） | 整份目标 JSON，格式见 `schemas/targets.schema.json`。京东阳性对照写成 `{"key":"jd-canary","platform":"jd","mode":"direct","live_id":"49019552","canary":true}`；天猫目标可从 `config/probe-targets.json` 按 `accountId→account_id`、`displayName→display_name`、`roomNumber→room_number` 映射，并补上 `account_group` |
| `ALI_COOKIE_GROUP_1/2/3` | 否 | 不配置则该组走游客模式（已实测的默认方式） |
| `WEBHOOK_URL`、`WEBHOOK_KIND`、`WEBHOOK_SECRET` | 否 | 推送通道 |
| `GDRIVE_CLIENT_ID`、`GDRIVE_CLIENT_SECRET`、`GDRIVE_REFRESH_TOKEN`、`GDRIVE_FOLDER_ID` | 否 | 刷新令牌必须只授权 `drive.file`，否则同步会拒绝执行（`drive_status.json` 中显示 `refused_scope`） |

可以先在本地校验 `V2_TARGETS_JSON`，不会打印任何值：

```bash
V2_TARGETS_JSON="$(cat my-targets.json)" python -c "import sys; sys.path.insert(0,'src'); from core.config import load_settings; s=load_settings(); print(len(s.targets),'targets OK; canary =', s.canary and s.canary.key)"
```

## 4. GitHub Actions 验证步骤

| 顺序 | 操作 | 通过标准 |
|---|---|---|
| A | 推送分支，等待 `offline` job | 绿色；`TCL_V2_DryRun_*` 证据包可下载 |
| B | 手动触发，`engine=fake` | 同 A |
| C | 手动触发，`engine=live`、`fail_on_canary=true`，`restore_state_run_id` 留空 | 见第 6 节「第一轮必查项」 |
| D | 再触发一次 live，`restore_state_run_id` 填 C 的 run id | 推送不重复（`notification.fresh_events` 只计新变化）；缓存可用（`resolved_cache.json` 中的条目被保留） |
| E | 下载 `TCL_V2_Evidence_<run_id>_a<attempt>`，上传到 Google Drive 交复核 | 如果配置了 Drive Secrets，第 C/D 步已自动上传 `tcl-v2-report-*.zip` |

## 5. 预期证据包结构

```text
TCL_V2_Evidence_<run_id>_a<attempt>/
├── run_summary.json          # verdict、by_code、max/median_detect_ms、contract_validation、circuit_breaker、notification
├── control_live_result.json  # 阳性对照：判定式与旧实验完全一致
├── resolved_rooms.json       # B→A 契约（含每个目标的 audit：function_ids、blocked_by_category、landing_route）
├── monitor_snapshot.json     # A→交付契约
├── index.html                # 手机竖屏看板（缩略图已内嵌）
├── thumbs/<key>.jpg          # 仅在直播中且页面未变化时截取，已打码
├── SHA256SUMS.txt            # 覆盖以上所有文件
└── drive_status.json         # Drive 同步结果（在 SHA256SUMS 之后生成，不在校验范围内）
v2-state/                     # 供下一轮恢复：resolved_cache.json、monitor_snapshot.json、notify_ledger.json
```

## 6. 下一轮审计核验点（对应交接单的两个缺陷）

| 检查项 | 位置 | 通过标准 |
|---|---|---|
| 阳性对照 | `control_live_result.json` | `positive_live_control: true`，`room_id` 为 `49019552` |
| 缺陷 A：耗时 | `run_summary.max_detect_ms`；`monitor_snapshot.rooms[].elapsed_ms` | 京东房间的 `detect_ms ≤ 12000`；`diagnostics.early_return: true`；`diagnostics.network` 中有 `font_blocked`、`media_blocked` 计数 |
| 缺陷 A：没有 33s 长尾 | 同上 | 即使是 `NAV_TIMEOUT`，`elapsed_ms` 也约等于预算（12s），而不是 25s 以上 |
| 缺陷 B：不再误拦 | `resolved_rooms.rooms[sku].audit.network` | 不再出现 `non_allowlisted_writes_blocked`；`function_ids.allowed` 列出以前被拦的只读 POST；`unknown_read` 列表交人工复核 |
| 缺陷 B：安全写仍被拦截 | 同上 | `blocked_by_category` 只包含 order / cart / auth / telemetry / privacy / state_change |
| 缺陷 B：不走 PC | 同上 | `audit.h5.status`，不存在任何 `item.jd.com` 变体 |
| 熔断 | `run_summary.circuit_breaker` | 某组被熔断后，该组后续房间显示 `GROUP_CIRCUIT_OPEN` 且 `diagnostics.network_requests: 0` |
| 契约 | `run_summary.contract_validation` | `{"resolved_rooms":"ok","monitor_snapshot":"ok"}` |
| 无密钥外泄 | 整个证据包 | 用 `grep -rE` 搜索你自己的 Cookie 片段、Webhook token、`refresh_token`，结果应为空 |

## 7. 尚未实测校准的部分（不要把它们的结果当作已证实）

| 部分 | 当前行为 | 需要什么证据才能升级 |
|---|---|---|
| 京东 `shop_discover` | 移动店铺入口实测会跳到 App 下载页，因此大概率返回 `REDIRECTED / app_download_landing`；`hook_key_summary` 中只记录键名 | 一次能看到店铺直播入口的公开观测样本 |
| 京东 SKU 候选 | 唯一候选标记为 `candidate_unverified`，需等监控层确认 `room_id_matched` 后才写入缓存 | 多轮运行中，候选与阳性对照一致（`diagnostics.sku_control_verdict`） |
| 淘宝 `m.tb.cn` 短链 | 只接受落地到 `h5.m.taobao.com/taolive/video.html?userId=` 的结果，其他落地页判 `SCHEMA_MISMATCH / landing_route_uncalibrated` | 一份脱敏的 `landing_route` 样本，用来决定是否扩充 `SHORT_LINK_PARAM_HOOKS` |
| 阿里 DOM 兜底文案 | 只用于识别门禁（只会触发熔断，不会判定直播状态） | 真实滑块页 / 登录页的文案样本 |
| 阿里 `OFFLINE` | 保留旧规则 `offline_rule_validated: false` | 一次确认真实下播后的对照 |
| Bark / 飞书加签 | 按公开文档格式实现，未真实发送验证 | 一次真实推送回执 |
| Drive 令牌 `scope` 字段 | 令牌响应中缺少 `scope` 时按「不合格」拒绝执行（宁可失败也不越权） | 首次 live 运行时检查 `drive_status.json` |
