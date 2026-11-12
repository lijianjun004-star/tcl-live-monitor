# R3.13｜直接执行：私有十房四层身份审核工作台（离线）

2026-11-12。以 R3.12.1 Draft #70 为代码基线；仅新 Draft 分支，不合并 `main`、不部署 Pages、不变更京东巡检与历史。

## 已有私有原始数据核对

- 10 条内部 OPS 房间，10 个唯一内部房间 ID、10 个唯一内部店铺 ID；R3.11 解密来源 JSON 和 R3.12 私有 CSV **10/10 房间 ID 与店铺配对一致**。
- 私有 CSV 的第 1 层 10/10 标注来源 VERIFIED。第 2 层有效公开 secUid 0、第 3 层公开实际直播间 ID 0、第四层独立审核 0。
- 2 行历史类别列差异：2026-11-07 来源“家电”，2026-11-11 导出“未核实”；**不自动回填旧值**，需要按有时间戳的原始来源重新核实。
- 这不是公开平台真实 LIVE / OFFLINE 的验收：不能根据“内部目录 10”或 RPA 2 个公开样本推断正式开播/满播率。

## 实际新增代码

- `probes/r313/private-bridge-review.mjs`：以 17 列私有 CSV + R3.11 私有 JSON + 12 个已批准公开抖音账号名单做离线 L1/2/3/4 检查。
- `probes/r313/review-private-files.mjs`：本地 CLI；默认仅在控制台显示可公开的计数，不输出 IDs。只有 `R313_PRIVATE_REPORT_PATH` 明确指向**仓库目录外**时才会输出私有逐行 JSON，文件要求不存在、mode 0600。
- `tools/r313/index.html`：手机优先的本地审核台；用户在浏览器选择 3 个文件，全部使用 File API 本地读取，页面 CSP 禁用 `connect-src`、第三方字体及远程资源。可编辑证据字段，手动导出更新后的私有 CSV 或脱敏计数摘要。不自动提交内容到 GitHub/服务器。
- `tests/r313-private-bridge-review.test.mjs`：验证来源 ID 与店铺配对、十房不减、批准 secUid 规范、重复冲突、CSV 破坏/注入、假 VERIFIED/LIVE 无效、缺少审核证据不自动晋级、公开摘要不含 IDs。

## 运行方式

在完整仓库工作副本的根目录，通过本地静态服务器访问 `tools/r313/index.html`。例如：

```sh
python3 -m http.server 8000 --bind 127.0.0.1
# 在同一台电脑访问 http://127.0.0.1:8000/tools/r313/
```

打开页面后手工选择：
1. `TCL-R3.12-四层身份关联工作表-私有勿公开-20261112.csv`
2. R3.11 私有明细 ZIP 里的 `01-真实内部十房间明细.json`
3. 当前仓库 `config/probe-targets.json`

注意：这个开发测试页尚未发布手机互联网预览站。页面需从本地服务器提供模块文件，不建议直接把含真实 ID 的 CSV 上传到公开测试站。

CLI（同样离线）：

```sh
node probes/r313/review-private-files.mjs /private/work.csv /private/source.json config/probe-targets.json
```

## 严格门禁

1. 即使 CSV 填写了 `VERIFIED`、证据路径和审核人，也只会得到 `READY_FOR_MANUAL_INDEPENDENT_REVIEW` 的材料准备度；**此模块永远输出 0 个真正完成的四层桥接**。
2. 只允许 R3.6 四层门禁认可的三份独立证明与真实人工复核将一条关联晋级；证据引用格式、截图文件名、品牌名称、房间 ID 相似不代表真实性。
3. 如无可信实时 LIVE/OFFLINE 真值，本项目不能进入正式满播率考核；`UNKNOWN` 不等于停播。
4. 私有文件只能在授权环境使用，切勿作为普通 PR 附件或公共 GitHub Actions artifact 上传。
5. R3.13 测试只运行 Node 离线 CI。不会碰 R3.5 京东、Pages、生产 `main`、云数据库或原始 7 天历史。
