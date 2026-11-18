# 京东商家导出：离线历史导入候选

**真实京东商家导出格式尚未取得或验证。** FICTIONAL CSV 和映射均为合成测试数据。此工具供本地历史暂存使用。

## 当前能做什么

本地 CSV 或受限 XLSX 可按明确字段映射逐行校验，生成历史记录及错误预览。stdout 仅输出数量。JSON 内保留账号、场次 ID 和时间，应存放在用户控制的私有目录，避免提交到仓库或上传 Artifact。POSIX 要求目录仅属主可访问并以 0600 创建数据文件。Windows 依赖目录 ACL。

```
node experiments/jd-export-import/cli.mjs \
  --input experiments/jd-export-import/fixtures/FICTIONAL-export.csv \
  --mapping experiments/jd-export-import/fixtures/FICTIONAL-mapping.json \
  --output /已有私有目录/新的预览文件.json
```

可重复传入 `--input`，最多 4 个文件。每批使用同一导出时间、证据类型和映射。返回码 0 表示暂存成功且无本批行错误或未决修订冲突，2 表示已暂存但需要审查，1 表示输入、输出或配置被阻塞。

- 配置columns将五个逻辑字段映射到精确CSV标题：accountId、sessionId、startedAt、endedAt、sourceId。列名可以改，不能自动按名称猜账号归属。endedAt列允许空值，记录END_TIME_MISSING，不据此判定仍在播。
- 配置exportedAt必须为明确时区的导出时间。输入时间只接受ISO日期时间、秒和显式Z或数值时区，可有三位毫秒；拒绝Excel序列日期、无时区日期、非法日历、未来导出、结束早于开始或晚于导出。
- ID按字符串保留前导零，不将账号、店铺、内部房间或直播场次互换。当前ID仅支持字母数字/下划线/连字符，超出规则待真实样本审查后扩展，不静默截断。
- 同一账号和场次、相同标准化时间与来源的记录合并证据位置。时间或来源不同的变体隔离，保留原始批次、文件摘要和行号。重复导入不会消除未决冲突。
- 未匹配身份仍作为未核实历史记录保留，identity=UNVERIFIED、internalRoomId=null。重复映射为CONFLICT。可选bindings须精确accountId+sourceId、内部房间ID、reviewRef及有效期限；REVIEWED_MAPPING_INPUT仅是用户配置声明，不验证身份事实或签名。
- errors只含fileIndex、逻辑CSV行号和固定code，不回显原始单元格；duplicates指出原始重复位置。CSV引号内换行属于一个逻辑行，错误行号不是物理文本行号。
- 每条记录historicalOnly=true、currentState=UNKNOWN；整个结果realFormatValidated=false、productionWrite=false。结束时间不等于当前OFFLINE，未匹配账号不等于停播，导出时间不是实时观测或心跳。没有开播率/考核计算或正式数据覆盖。

## CSV/XLSX能力与安全

仓库检查没有已有CSV/XLSX解析依赖，只有其他候选的Wrangler开发依赖。本次实现无新增依赖的受限CSV解析：UTF-8（可BOM）、逗号、双引号转义、LF/CRLF；拒绝重复/缺失标题、坏引号、坏UTF-8、控制字符、列数不齐和公式样式单元格（包括未使用列）。最多每文件2MiB、10000数据行、64列、单元格1024字符；最多4文件。文件读取限定字节数，拒绝输入符号链接；输出只创建新文件，失败清理。

XLSX 需要 Python 3 标准库和明确的 `--sheet 工作表名`。仅支持简单 OOXML 工作簿中的文本单元格。文件存在宏、外链、公式及缓存值、隐藏表行列、注音、合并单元格、数值 ID 或 Excel 日期序列时会阻塞。XLS 和 XLSM 仍拒绝。ZIP 总展开大小、压缩比例、文件数、路径和 XML 结构均受限，解析在内存中进行。真实工作簿的字段与类型仍需拿样本对账。

## 跨批暂存

把 `--output` 换成 `--store 私有目录 --initialize-store true` 可显式创建本地历史。后续批次只传 `--store 私有目录`。历史缺失、摘要不符、无可解析文件或发现中断锁时会阻塞。部分成功会保存错误位置和固定错误码。相同批次不增加版本，同一 XLSX 的不同工作表保留各自原始文件摘要和解析摘要。

写入者通过独占锁串行发布完整的 `history.json`。发布中断会保留锁和现有证据，需核对快照与批次后人工恢复。Windows 进程中断已测试，真实断电顺序仍待验证。

输出目录须为用户控制的本地私有目录；本工具不是恶意本机多用户/并发目录竞态隔离器。来源ID和文件摘要用于追溯，不证明文件来自京东或未被人改写。解析成功的未匹配历史不进入任何现有LIVE状态机。

## 真实样本所需信息（以后提供，不含凭据）

1. 经用户允许的最小脱敏导出样本及实际文件类型、编码、分隔符、工作表/表头位置；保留原列名与数据类型。
2. 哪列是真实商家/主播账号ID，哪列是直播场次ID；店铺ID、内部监控房间ID若不同要分开，不用店名代替映射证据。
3. 开始/结束列的真实业务定义与时区，空结束值含义、秒/毫秒精度、导出时间与导出覆盖范围。
4. 非敏感来源标识及导出批次引用。若来源信息仅在文件外，需要评审配置元数据适配，当前虚构sourceId列不代表真实存在。
5. 少量正常、重复、空值、修订/冲突样例，以及另行核验的内部账号映射证据。无需Cookie、Token、密码、手机号、订单或交易明细。

取得材料后先验证真实格式并逐行对账。正式接入需单独批准。

## 测试与交付

`node scripts/test-offline-all.mjs` 包含三套导入回归，覆盖文本解析、重复和修订隔离、有效观测隔离、文件发布、跨进程中断与 XLSX 拒绝边界。测试使用合成数据。交叉审查证据见 `docs/defects-20261118/import-review.md`。
