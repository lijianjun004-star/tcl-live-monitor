# TASK-TMALL-RECOVERY-20261117 — offline Draft candidate

Base: main `18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca`; branch `fix/tmall-ledger-recovery-20261117`. Owner: repository owner; coordination: parent ChatGPT; implementation: Codex. Scope: only lijianjun004-star/tcl-live-monitor. No paid API, platform/source request, credentials, production change or collection execution. Existing PRs through #102 were checked; neither #101 (Douyin) nor #102 (JD) fixes the Tmall workflow. This is independent of both.

## Defects confirmed from current code

1. Latest-success restoration excludes a newer failed run containing a new stop marker or ledger.
2. Run-list/download errors, absent/corrupt state and absent/malformed/future cooldown all could result in sampling. The old catch-all cooldown gate defaults to skip=false.
3. Receipt import precedes cooldown persistence. If import fails after a stopped collector, the new stop is never written.
4. Upload requires state.json, so a safety marker alone would not survive missing-state failures.

These are source-code findings, not claims that a particular live Tmall run bypassed cooldown. No live observation was made.

## Candidate behavior

- Initialize skip=true and a durable block before restore. Select the latest completed main run, never older success. Verify exact repository/head repository, workflow path, main branch, completed status, event and run attempt through GitHub run metadata before download. Any command failure leaves the sentinel. No bootstrap from missing history.
- Validate a real-kind Tmall-only ledger with the existing validator (synthetic tests simulate that schema), reject future/stale (>7 days) or invalid state. Preserve independently valid cooldown even when ledger validation fails. Never re-date observations to make an old ledger fresh.
- A manifest binds run ID/attempt, savedAt and SHA-256 of state/cooldown/block/audit files, explicitly null for absent optional files. This distinguishes a verified no-stop snapshot from a lost cooldown file. It is integrity evidence within trusted same-repository GitHub artifacts, not a cryptographic signature or proof of source truth.
- Missing legacy manifest blocks pending review. Expected file missing, hash mismatch, bad timestamp, invalid JSON, symlink, oversized input and ambiguous provenance block. Existing cooldown is valid only with a canonical stoppedAt; active 24-hour cooldown and future/invalid timestamps cannot authorize access.
- Before the unchanged collector starts, persist SAMPLE_INCOMPLETE. Immediately after it returns, persist stop/cooldown **before import** if exit is nonzero, stopped is present, or receipt is missing/malformed. Import failure retains the marker. Only a valid completed sample clears its own sentinel. Unknown interrupted runs remain blocked.
- Seal a manifest and upload safety state even without state.json. Invalid working output is excluded rather than blessed by a new manifest. A failed/blocked run followed by successful skipped runs cannot automatically clear the block; corrupt safety lineage cannot be converted into an approvable null-cooldown snapshot.
- Workflow cron, manual trigger, permissions, concurrency, sources, targets, existing collector logic and 7-day artifact retention are unchanged. Proposed changes are only on this Draft branch. UNKNOWN remains UNKNOWN.

## Auditable manual recovery — separate approval required, NOT performed

No `config/tmall-recovery-approval.json` is provided. This PR is not approval to resume restricted access. The narrow candidate mechanism accepts one separately reviewed receipt with schemaVersion=1, reason=RESTORE_CHAIN_REVIEWED, exact runId/runAttempt, files mapping for all five critical files (including manifest, null only for actual absence), approvedBy, approvalUrl pointing to an owner approval comment in this repository, approvedAt/expiresAt (canonical UTC, at most 24 hours). Extra payload fields, wildcards, expired receipts or changed bytes/run/attempt are rejected. Software validates binding and syntax, not the identity or authenticity of human consent: an independent reviewer must verify the owner approval comment.

Safe procedure:
1. Leave collection blocked. Inspect the exact latest main workflow run, attempt and sanitized artifacts including failed/cancelled runs. Record root cause, current stop/cooldown and file hashes. Do not inspect private credentials or access platforms.
2. Establish a valid unchanged ledger and known cooldown history. Never delete/re-date a stop marker, select an older success opportunistically, or manufacture observations. Wait at least the full valid cooldown interval; an approval receipt does not shorten it.
3. For a valid preserved chain, or explicitly reviewed legacy missing-manifest migration, obtain owner approval for that exact recovery and submit the exact short-lived receipt in a **separate PR**. Current repair approval is not recovery consent. Re-test bindings, future/invalid time, expiry and cross-run behavior, and independently verify the approval evidence.
4. On separately approved rollout, exact matching may clear a reviewable marker and persists recovery-reviewed.json as an audit trail. New run/attempt/bytes require new review; no environment flag or manual workflow input bypasses the gate.
5. Missing/invalid ledger, unresolved corruption/provenance or PERSISTENT_SAFETY_UNVERIFIED cannot be repaired by this receipt. Recover valid evidence through a separately approved repair, or obtain a separately designed and authorized controlled baseline with explicit evidence-loss disclosure. This PR supplies no such reset or live bootstrap. If evidence cannot be established, remain blocked.

Migration consequence: old artifacts have no manifest, so a future deployment may intentionally stop sampling until migration review is approved. If state ages out during a long block, the narrow receipt cannot re-date it. This is a release planning requirement, not evidence that production has already stopped. Rollback must retain stop/block data; reverting to fail-open restoration is not a safe rollback.

## Validation and limits

Node v24.22.1, only synthetic files and injected gh/collector/importer stubs; no GitHub workflow was dispatched.

```
NODE_OPTIONS="--require=$PWD/scripts/offline-test-guard.cjs" node --test tests/*.test.mjs tests/*/*.test.mjs
NODE_OPTIONS="--require=$PWD/scripts/offline-test-guard.cjs" node --test tests/tmall-ledger-recovery.test.mjs
bash -n scripts/restore-tmall-ledger.sh scripts/tmall-sample-once.sh
```

Full suite: **303 total / 301 PASS / 0 FAIL / 2 SKIP**; focused safety suite **20 PASS**. Includes list/API/download failure; no run/foreign provenance; missing/corrupt/stale/future/wrong-kind state; cooldown boundary/invalid timestamps; manifest loss/tamper; failed-run to successful-skip carry-forward; nonzero/stop-with-zero/missing receipt; import failure; exact review and expiry; corrupt-lineage laundering refusal; healthy wrapper; unsafe file rejection. Shell syntax and diff --check PASS. All 30 YAML files parse; on/permissions/concurrency equal baseline.

The 2 unchanged optional browser diagnostics are skipped. Earlier sibling-task attempts failed before Chromium page creation due to environment local socket restrictions; no browser pass is claimed and they were not retried for this change. Node 22 parity, real gh artifact download/provenance end-to-end, actual runner cancellation/crash, browser/platform behavior and production migration remain NOT RUN. The Node TCP/DNS/UDP guard is a test harness, not a general security sandbox. SIGKILL/runner loss can prevent upload; a subsequent run with missing latest artifact remains blocked, not silently bootstrapped.

Independent Claude/Gemini review has NOT occurred. Review exact commit and full source; run the commands; inject loss of the new stop before/after import and verify no path emits skip=false. Check manifest-null vs missing-file semantics, marker preservation, narrow receipt constraints and scope. Do not contact a source or send private evidence to a model.

## Trigger audit and actual impact

All 30 tracked workflows reviewed. New branch/path set matches no push/pull_request/pull_request_target trigger. No collector completion is generated, so no new downstream results-site dispatch is caused. No other repository is operated on. No merge/deploy, permission edit, production frequency change, workflow enable/disable or restricted-access recovery. Production impact now: **none**; this is a reviewable conservative candidate, not a claim of restored availability.
