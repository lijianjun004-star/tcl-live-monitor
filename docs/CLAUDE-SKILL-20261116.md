# Claude 原生技能安装

任务 SKILL-20261116-CLAUDE-01。用户要求 Claude Code 与网页/手机两个入口均可使用 RSI/Scrapling。

本仓库安装位置 `.claude/skills/rsi-scrapling/SKILL.md`，根 CLAUDE.md 提供入口。
Claude Code 拉取包含该文件的版本后，可由描述触发或显式 `/rsi-scrapling`；实际加载仍须在相应客户端核验。

配套网页 Skills ZIP 根目录为 rsi-scrapling，含原生 SKILL.md、脚本和固定上游来源。
当前会话未连接 Claude 账户，网页端需在支持 Skills 的客户端上传启用；普通聊天附件不等于安装技能。

默认脚本在独立可写 cache 中运行，适配技能目录只读的环境。首次依赖安装需要包索引网络；
缺工具、代码执行权限或网络时明确报告未执行。MCP 为可选项，stdio 配置不是网页远程连接器。

本轮验证技能结构、逐文件哈希、Python 语法及可执行自检；不把本环境运行写成 Claude 已执行或自动触发已验证。
没有购买 API、添加账号凭据、创建定时任务或改动真实采集代码。
