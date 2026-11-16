# Repository instructions for AI coding agents

These instructions apply to work in `lijianjun004-star/tcl-live-monitor`. They are an operational policy, not a substitute for enforced GitHub branch rules.

## Team workflow
- ChatGPT: requirements, task planning, review of evidence, release recommendation.
- Codex: implementation and tests in an isolated branch; submit a draft pull request.
- Claude (web GitHub MCP): independent read-only review; report observed findings. Do not assume that Claude can write GitHub reviews or trigger checks.
- Repository owner: final authorization for merging a production change and deploying a new code version.

## Hard boundaries
1. **Never push directly to `main`**, force-push, delete a protected branch, merge a pull request, enable auto-merge, publish a new production code version, or modify release permissions without the owner's explicit approval for that specific action.
2. Work on a fresh feature/fix branch based on the currently verified `main` commit. Open a **draft PR** for review; leave it unmerged.
3. Do not alter the running JD, Tmall/Taobao, or Douyin collection schedules, safety controls, identity mapping, or data-retention logic except within an expressly scoped task.
4. The existing data-only refresh chain from `refresh-results-site.yml` into `tcl-live-results/.github/workflows/publish.yml` must remain operational. Do not add human approval to its existing `github-pages` environment: it also handles routine result-page refreshes.
5. Treat **new code/version releases** differently from **refreshing results from existing collector logs**. A new release requires owner approval; an existing results-data refresh is allowed to remain automatic.
6. Never expand GitHub App repository access or disclose credentials, secrets, personal data, private evidence, or authenticated sessions in commits, PRs, logs, or public artifacts.
7. On authentication, anti-bot, rate-limit, or permission barriers: stop the affected operation and report the evidence; do not bypass them.
8. Do not interpret `UNKNOWN` evidence as `OFFLINE`, or unobserved coverage as a failed livestream.

## Required development and review evidence
- Record starting `main` commit SHA and exact files changed.
- Give the purpose, affected paths, potential runtime/monitoring impact, and rollback method.
- Run relevant offline tests; report each as PASS, FAIL, or NOT RUN with actual command/output evidence. Never invent results.
- Distinguish CI checks, source review, test-environment smoke tests, and live production verification.
- Request independent Claude review and ChatGPT assessment before asking the owner to authorize release.
- If any release blocker remains, do not ask for merge or production deployment.

## Release gate
- An AI-generated statement, a checked PR template item, or a successful CI run is **not** owner authorization.
- Owner approval must be explicit for the specific PR/release. Await owner-directed merge and deployment.
- Configure GitHub branch rules, repository permissions, and code-release deployment gates separately; this document alone cannot enforce permissions.

## Change isolation
- Historical experimental PRs must remain as-is unless a task expressly references them.
- Do not modify `tcl-live-results`, `live-practice-room`, or `tcl-v43-preview` from this repository task.
