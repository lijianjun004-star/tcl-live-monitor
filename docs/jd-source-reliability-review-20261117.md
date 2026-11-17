# TASK-JD-SOURCE-20261117 — source failure / state semantics candidate

Owner: repository owner; coordinator: parent ChatGPT thread; implementer: Codex. Base main: `18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca`. Branch: `fix/jd-source-reliability-20261117`. Status: Draft, NOT released. No paid API, extra service, live source request or workflow execution.

## What the supplied failure actually ran

https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44000502640, job 133763058953, is **jd-r23-scheduled.yml**, not jd-fullday-rate.yml. Logs show catalog UNAVAILABLE, acceptance SOURCE_UNAVAILABLE, seven retained rooms UNKNOWN, state uploaded, final source/persistence gate failed. A source step's displayed conclusion success under continue-on-error did not establish source success. UNKNOWN is not OFFLINE.

The production workflow checks out **267b6709a8563ef779cda6b11c97b9684c4e1c16**, including history/acceptance modules absent from current main. Its restore already selects recent nonexpired same-repository main artifacts regardless of run success; it does NOT use latest-success. This differs from Douyin. Reading run logs cannot distinguish source host outage, route failure or intended access control; this PR makes no claim to repair network availability.

The supplied `/workspace/shared/jd-reliability-offline.patch` was inspected but not applied: it targets r327 full-day rate and explicitly leaves old failed-run continuity unresolved. Applying it alone would not fix this identified production chain. No unrelated source, source URL, retry policy, rate, schedule or deployment is added here.

## Reviewable implementation and integration boundary

- Existing `probes/lib/tcl-jd-all.mjs`: bounded allowlist error codes for connect timeout, timeout, DNS, reset/refused, TLS, HTTP denial/rate/server failures, size/schema/JSON errors. Native messages, URLs, credentials and response bodies never become failure diagnostics. Counts, stable codes and room IDs remain public.
- `probes/tcl-jd-all.mjs`: safe diagnostics in a report and fixed status line, nonzero on failed requests even if other rooms succeed. Valid partial rows survive. Corrupt prior snapshot fails before source access instead of silently resetting; missing first-run file is still permitted.
- attemptedAt and completedAt describe the scan; per-room observedAt is response observation time, null on request/schema failure. They do not claim exact stream start/end, nor that source evidence was generated at response time.
- Pinned r21 acceptance / r23 history files are materialized from the exact existing fixed source, then minimally extended. History uses source observation time for first/last live and last observed, execution time for last_attempted_at, and a separate last_successful_source_at for the latest usable room observation (including partial runs, NOT proof of a fully successful scan). Total failure advances attempt time only and cannot refresh old evidence. Historical observation times survive failed rooms, but current status becomes UNKNOWN. Bad restored timestamps are rejected. Existing retention is preserved.
- Legacy accepted reports without observed_at use checked_at for compatibility. A legacy state does not fabricate last_successful_source_at during migration.

**Production pin and every workflow are unchanged.** This is intentional under the prohibition on production configuration changes. A merge of these source files alone would NOT update the pinned scheduled/backup collector. A separate owner-approved release must choose and review an immutable candidate SHA containing this source, then update the checkout pin and related guards together. No such activation is included or authorized here. The existing unpinned manual/full-day clients share the reader, so after any future merge its sanitized HTTP exception classes also apply there; network URLs/method/limits remain unchanged.

## Tests and limitations

Node v24.22.1:

```
NODE_OPTIONS="--require=$PWD/scripts/offline-test-guard.cjs" node --test tests/*.test.mjs tests/*/*.test.mjs
node --test tests/jd-source-reliability.test.mjs tests/r23-jd-unattended.test.mjs
```

Final full Node suite: **310 tests; 308 PASS; 0 FAIL; 2 SKIP** (optional unchanged browser diagnostics). New reliability tests: 8 PASS; restored pinned history suite: 19 PASS. Includes injected one-request catalog failure; HTTP classes/no retries; redaction; good+failed room mixture; all-failed; complete; persistence roundtrip; failure→recovery; duplicate run; out-of-order/corrupt timestamps; old LIVE evidence not refreshed by report processing; CLI subprocess with synthetic global fetch and corrupt previous file. Existing local HTTP fixture confirms GET-only request count and absence of raw business fields. The committed test guard restricts Node TCP to loopback and blocks external DNS/UDP; no source request was made.

All 30 workflow YAML files parse; `git diff --check` PASS. Main's optional Chromium diagnostics were attempted in the sibling DY branch with identical files; Chromium could not start (`socket() failed: Operation not permitted`). No claim of a JD browser pass. Browser sealed E2E, Node 22 parity, real source recovery, production artifact restoration and GitHub Actions execution: NOT RUN. The repaired r21/r23 chain is tested as an offline candidate; production acceptance remains pending the separately approved pin change and independent verification.

## Independent Claude/Gemini recheck

No external model has reviewed this candidate. Review the source against main and compare newly materialized r21/r23 originals with commit 267b6709. Re-run the full Node suite and 27 focused tests. Feed malicious exception messages containing synthetic URLs/token/body strings; ensure only enumerated codes survive. Verify failed-room timestamps never advance, partial valid rows remain, all-failure persists UNKNOWN without manufacturing OFFLINE or live duration. Inspect the unchanged production SHA to confirm no activation claim. Optional future network investigation requires separate authorization and operator-side evidence; do not probe the source as part of this offline review.

## Trigger audit, impact, rollback

All 30 tracked workflows and their downstream refresh trigger reviewed. These branch/path combinations match **no push/PR/pull_request_target workflow**. No collector completes, so the main-only results-refresh workflow has no newly triggered collector event. No new GitHub Actions spend is requested. No other repository was operated on; no main merge, Pages deployment, dispatch/rerun, workflow enable/disable, application authorization change, score/KPI activation or production pin/frequency change.

Actual production impact now: none. This improves diagnostic and conservative data semantics, not source network connectivity. If a later reviewed activation has problems, stop that release and preserve latest state and UNKNOWN markers; do not erase evidence or roll back to silently resetting corrupted history.
