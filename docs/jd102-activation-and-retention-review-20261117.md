# Read-only follow-up: JD PR #102 activation, r327 scope and retention

Reviewed main 18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca and PR #102 head cffc565d1152fff3d2dbb339316518eb2dfaf0c6. The current task changes no PR #102 code, production checkout pin, schedule or retention rule. No source access or workflow run. This report is separate from acceptance of #102.

## Activation boundary

`.github/workflows/jd-r23-scheduled.yml` lines 43 and 75 check out `267b6709a8563ef779cda6b11c97b9684c4e1c16`, for verification and actual inspection respectively. `jd-r33-backup.yml` calls that same workflow; it does not activate #102's new history modules. #102 adds r21/r23 files copied from the fixed source plus candidate fixes, but does not update either workflow. A main merge of #102 alone therefore does not repair the scheduled/backup r23 chain. A separate specifically approved release must select an immutable source commit and review any checkout-pin/guard updates; this report is not that approval.

Read-only check performed:

```
git diff --quiet 18581b2 cffc565d -- .github/workflows probes/r327 config
```

Exit 0: those paths are unchanged by #102. Its tested Node tree is f8ad2c56bc4bbf782aaefbd4fc8d2577ccba1c29, with prior recorded full regression 310 tests / 308 PASS / 0 FAIL / 2 optional browser SKIP. This follow-up is source review, not a new production run or external-model recheck.

## r327 is a different pipeline

`jd-fullday-rate.yml` has its own main checkout, state artifact, lock, morning/final schedule and r327 CLI. The specified SOURCE_UNAVAILABLE run 44000502640 belonged to r23. #102 does not include the supplied r327 reliability patch, does not change `probes/r327/jd-fullday-cli.mjs` or `jd-fullday.mjs`, and does not fix r327's latest-success restore/reset behavior. r327 catalog throws, per-room caught failures and report/lastRunAt timestamp semantics remain separate pending work; no claim that #102 solves them.

The shared `networkReader` is changed by #102. If later merged, unpinned r327/manual clients would receive its bounded HTTP error classes, but that is not activation of r23 history fixes nor a complete r327 failure-state repair. No new source, retry or timeout setting was added.

## Three distinct retention concepts

| Layer | Observed source behavior | What must not be claimed |
|---|---|---|
| r23 checks | CHECK_WINDOW_MS=7 days; trim by sample time; cap 100,000 records | Does not mean every field in state is younger than seven days |
| r23 events | WINDOW_MS=90 days; trim event rows; cap 100,000 records | Not a 90-day immutable archive or guaranteed complete history |
| r23 room fields | First/last observation metadata survives event/check trimming; room identities retained | Not a seven-day deletion policy for all room metadata |
| GitHub r24-jd-main-state artifact | retention-days: 7 | A fresh artifact can contain older carried-forward event data; its seven-day expiry does not truncate JSON to seven days |
| r327 state | Cutoff is Beijing date now minus 35 days; delete dates strictly before cutoff, so boundary is inclusive (up to 36 date keys) | Not the r23 90-day event policy; not guaranteed durable history |
| GitHub jd-fullday-state artifact | retention-days: 7 | Not durable 35-day archival storage |

The r23 90/7 constants and trimming exist in original fixed commit 267b6709 and remain unchanged in #102. `docs/r31/JD-SEVEN-DAY-ONLY-ACCEPTANCE.md` explicitly removed the separate daily 90-day archive and retained the code-level event window, warning that 90-day persistent data must not be claimed. Thus “7-day rolling only” is shorthand for artifact/check policy, not proof of universal seven-day data deletion. If policy should instead delete all events/room metadata at seven days, that is a new decision requiring specific authorization and migration review; no such change was made.

Continuous successful carry-forward can keep older events inside newly created artifacts; an interruption beyond the available artifact lifetime may lose continuity. No guarantee of 90-day recoverability is possible from these settings alone. No historical artifact was deleted.

## Identity coverage

The six-row crosswalk template is distinct from the seven-room internal source catalog. All mappings remain unverified. The companion Draft only adds a user-reported internal jd-19 placeholder; it does not assert a public account, store, category, live-session ID or formal scoring readiness.

Independent reviewer should verify these exact source versions/paths and distinguish offline state tests, source-code review, activation and live-source validation. Claude/Gemini has not independently reviewed this follow-up.
