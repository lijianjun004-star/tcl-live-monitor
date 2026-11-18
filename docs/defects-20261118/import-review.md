# 京东导入独立交叉审查与回归

日期：北京时间 2026-11-18。审查对象为本次候选的 `store.mjs`、`xlsx-reader.py`、`cli.mjs`、`import.mjs`。测试全为虚构数据，不代表真实京东导出格式已验收。

## 发现及处理

| 发现 | 修复与独立验证 |
|---|---|
| 同一 XLSX 两个不同工作表行数相同，原批次键只含整本 SHA/行数/映射，第二表可能被误当重复而丢失 | 批次包含所选 sheet、原格式、解析摘要、parserVersion、规范化行及错误。实际生成一本两表 XLSX，连续通过 Python→CLI→持久库导入，保留两批两条不同记录；再次导入同表仍幂等 |
| sharedStrings/inlineStr 读取所有后代 t，将 rPh 注音附加到 ID；已复现 `001` 变 `0019` | 明确文本结构拒绝 rPh 等未支持节点。shared 与 inline 两种合成工作簿均拒绝且不写状态 |
| 部分坏行只留在当前预览，持久库及后续 stdout 不显示错误；全坏文件可生成空批次 | 固定错误代码和位置进入每批快照，聚合 errorRows。一次部分成功后再导入有效批次，旧错误仍可见；原始公式内容不会落库。全文件不可解析时不初始化 |
| 发布/清锁前未复查目录身份和 owner，替换目录或 owner 会混淆锁所有者 | 主实现增加 inode/dev/owner 检查；独立故障注入证实保留原状态/锁，不改替换目录。首轮 parent 替换虽阻塞但回显 ENOENT 路径，后统一固定错误并复验通过 |
| 新预览引用错位可以先写入，下一轮 load 才拒绝；SHA 正则会隐式接受数组 | 增加字符串类型、规范 UTC 时间检查；写入前核对行 provenance 的文件索引、SHA、行范围，以及错误的文件/行范围和文件级/行级分类。只保存清理后的文件目录。错误输入在首次发布前拒绝 |

## 实际回归

独立测试文件：`tests/jd-import-review.test.mjs`，新增 **9 项**。其中包含同工作簿多表实际 CLI 链路、注音拒绝、跨批错误、owner/目录替换、重算 checksum 后仍拒绝错位来源、发布前异常输入和部分文件解析失败。

实际执行命令：

```text
node --test tests/jd-import-review.test.mjs tests/jd-import-durable.test.mjs tests/jd-export-import.test.mjs
```

Node **v24.18.0**、Windows 主机环境：**36 tests，35 PASS，0 FAIL，1 SKIP，退出码 0**。日志 `../evidence/import-review.log`。唯一跳过为 POSIX owner-only permission bits：Windows ACL 无法由 POSIX mode bits 证明，明确 NOT RUN。

运行设置 TEMP/TMP 为本任务 `work/test-tmp`；Node 网络护栏及指向不可用本地端口的 HTTP/HTTPS/ALL_PROXY 均已启用。Python 仅用标准库生成/读取内存 ZIP 和 XML，无外部来源访问。为测试硬链接和符号链接，实际使用获准主机执行环境。

保留迭代证据：`import-review-first.log` 是初次 parent 替换固定错误断言失败；`import-review-sandbox.log` 是沙箱内扩大回归的 5 项失败，涉及硬链接/符号链接权限，未把这些失败算作通过。相同测试在支持所需文件操作的主机环境复跑后得到上述结果。

## 边界

未获得真实京东导出样本，未作真实列含义、日期语义、账号身份或生产接入验收。持久输出始终 `historicalOnly=true`、`currentState=UNKNOWN`、`productionWrite=false`。Checksum 仅用于意外损坏检查，不能证明文件未被拥有目录写权限的人重写。Windows 真实断电、POSIX 文件权限及恶意本机目录攻击不在本轮已通过范围内。
