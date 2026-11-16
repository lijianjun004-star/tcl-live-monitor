# Claude project guidance

Project skill: `.claude/skills/rsi-scrapling/SKILL.md`.

For web information collection, source verification or bounded evaluation and strategy replay, use this skill when relevant. It can also be invoked as `/rsi-scrapling` in a Claude Code client that loads project skills. Read its SKILL.md before running scripts.

Keep current project requirements and user authorization in force. The skill uses a separate cache, does not need model API keys, and does not authorize production deployments, new schedules, live source access, or changes to monitoring cooldowns. For operational sites, retain the project's existing guarded readers instead of directly applying generic Scrapling defaults.

Skill installation in the repository is not proof that a particular Claude session has loaded or executed it. Verify available skills in that client; reload or open a new session after pulling an update if needed.
