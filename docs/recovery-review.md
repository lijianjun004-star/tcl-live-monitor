# TASK-DY-ENCRYPT-20261117 — offline review candidate

Owner: repository owner; coordinator: parent ChatGPT thread; implementer: Codex. Status: Draft candidate, NOT released. Budget: no paid APIs, no live collection. Base main: `18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca`. Branch: `fix/dy-encrypt-recovery-20261117`. Only `lijianjun004-star/tcl-live-monitor` is in scope.

## Evidence and diagnosis

Run https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44042982575, job 133901807773: source step succeeded; encryption failed with `Error reading password from BIO` / `Error getting password`; ledger upload succeeded; encrypted private artifact step skipped. Logs and step metadata were read; no private artifact or real password was read. The failed run's actual random bytes are unknown, so a particular NUL/newline is a mechanism reproduced with synthetic input, not a proven byte-level diagnosis of that run.

`openssl enc -pass file:` reads a text line. Synthetic leading NUL reproduces the BIO error; a newline truncates the password (demonstrated by successful decryption using only the prefix). Generate 32 random bytes encoded as 64 hex characters plus newline, preserving 256 random bits. Existing AES-256-CBC/PBKDF2/RSA-OAEP formats remain, with a new **mandatory integrity.txt** tag. HKDF-SHA256 derives a separate HMAC key; HMAC authenticates length-framed p.enc and k.enc. CBC alone does not authenticate ciphertext. A hash alone would not solve that problem.

Encryption stages in a mode-0700 temporary directory, publishes the complete three-file directory by rename, and cleans the password/archive/private source directories on success and handled errors/signals. Native crypto/tar diagnostics are suppressed; only a fixed error code is printed. Old bundles are removed even on no-input runs. SIGKILL/host crash cannot run a trap: the private files remain outside all artifact inputs and rely on ephemeral runner disposal. This is not secure disk erasure.

Latest-success restoration can skip the newer failed-run ledger, including a cooldown marker from a different failed run. This run does not prove an actual cooldown bypass. Restore the latest **completed main** run, never silently fall back. Missing artifact, invalid ledger, bad cooldown and uncertain failure leave sampling blocked. Persist recovery-block.json even when state.json is unavailable. A successful skipped run cannot clear the marker. Cron, source allowlists, accounts, scoring and retention are unchanged.

## Safe release of a persistent recovery block — NOT authorized or executed

There is deliberately no approval file in this PR. No environment flag/dispatch input clears a block. A future owner-approved PR may add `config/douyin-recovery-approval.json` with schemaVersion=1, reason=ENCRYPTION_FAILURE_ONLY, exact string runId, stateSha256, cooldownSha256 and blockSha256 (null only for absent files), approvedBy, approvalUrl (owner approval comment on this repository's issue/PR), approvedAt, expiresAt. Validity is at most 24 hours. `reviewedRecovery` validates bindings and expiry; it **cannot authenticate human consent**, which must be checked independently during that future PR review.

1. Stop at the block. Read only sanitized latest-run metadata/ledger/cooldown/block; verify same repository, workflow and main provenance, including failures/cancellations. Never select an older success because it is convenient.
2. Establish that the only unresolved failure was encryption. If access restriction, cooldown corruption, missing ledger, unexplained cancellation or data loss remains, this narrow receipt is inappropriate: remain blocked and request an explicit recovery design, not live access.
3. Validate the preserved ledger with `node probes/r325/daily-report.mjs <state>` (redirect to a private local sink when appropriate). Compute SHA-256 of the exact downloaded state/cooldown/block bytes. No observations, timestamps or cooldown may be edited to pass review.
4. Obtain fresh owner authorization for that exact recovery. Submit the receipt as a separate reviewable PR. Owner approval for this encryption-fix PR does not authorize that later recovery. Re-run synthetic tests and have an independent reviewer verify the approval comment, file hashes, expiry and latest run ID.
5. The candidate gate accepts a receipt only for the exact latest restored artifact. Expired receipt, changed run or changed bytes remain blocked. Even a valid receipt cannot override active, malformed or future cooldown. A successful release persists recovery-reviewed.json with the audit receipt. Sampling would resume only after the separate approved release, never from this Draft PR. Remove the spent config by later reviewed change.

This exact binding can become stale if another scheduled skipped run completes before release. Re-review the new latest artifact; do not broaden matching or reuse stale consent. No receipt is supplied now; no blocked access has been restored.

## Offline validation and independent review

Node v24.22.1; OpenSSL 3.5.7. Command:

```
NODE_OPTIONS="--require=$PWD/scripts/offline-test-guard.cjs" node --test tests/*.test.mjs tests/*/*.test.mjs
bash -n scripts/encrypt-douyin-evidence.sh scripts/restore-douyin-ledger.sh
```

Final full Node suite: 294 tests, 292 PASS, 0 FAIL, 2 optional browser tests SKIP. New recovery suite: 11 PASS. Includes real OpenSSL with synthetic keys only, RSA unwrap/CBC roundtrip, modified ciphertext/key/tag and wrong-key rejection, cleanup, latest failed-run carry-forward, successful skipped-run block persistence, actual ledger validator with bad/missing inputs, and exact/expired review receipts. Workflow YAML: all 30 parse. `git diff --check`: PASS.

Two optional Chromium synthetic-HTML tests were separately attempted (Playwright 1.56.1, installed Chromium) but both failed before page creation: `process_singleton_posix.cc:297 socket() failed: Operation not permitted`. An isolated network namespace also cannot enable loopback here. Node full regression therefore uses the committed loopback-only TCP/DNS/UDP guard, inherited by Node subprocesses; it is a test harness, not a general-purpose security sandbox. No page navigation to platforms occurred. Sealed browser E2E, Node 22 parity, real GitHub restore, production key compatibility and live sampling: NOT RUN. These remain release checks; no claim of complete browser/production acceptance.

Independent Claude/Gemini reviewer: check exact diff against base; run commands above; inspect gate failure propagation, upload file allowlists, HMAC before decryption, no private data outputs, and approval receipt binding. Do not send private keys or evidence to a model. For a synthetic encrypted bundle, RSA-decrypt k.enc to a private key file, run `node scripts/evidence-integrity.mjs verify <unwrapped-passphrase> <bundle-directory>` before CBC decryption, then compare plaintext bytes. Legacy bundles have no authenticated tag and must never silently use the new verifier as a successful check.

## Trigger audit / impact / rollback

All 30 tracked workflows reviewed. For this branch and changed paths, push/PR/pull_request_target matches: **none**. The modified daily workflow remains schedule/manual only, main-only. Results refresh listens for completed collection names on main; this branch starts no such run. No workflow dispatch/rerun, deployment, schedule edit, main merge, permission change, other-repository operation or external-model review was performed. Actual production impact: none until separately approved merge. After release, uncertain restore deliberately blocks sampling. Rollback must preserve cooldown/recovery blocks; do not revert blindly to latest-success restoration.
