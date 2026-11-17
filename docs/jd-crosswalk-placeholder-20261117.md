# JD-19 unverified placeholder — 2026-11-17

Base main: 18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca. Branch: docs/jd19-unverified-crosswalk-20261117. Only tcl-live-monitor is in scope. This is a separate Draft candidate; PR #102 and production are unchanged.

The old config/jd-ops-crosswalk-template.json lists six internal rooms (1,14,15,16,17,18), all identityCrosswalkVerified=false. Existing docs/r31/JD-SEVEN-DAY-ONLY-ACCEPTANCE.md and docs/r34/JD-BACKUP-TOCTOU-AND-GITHUB-CRON-LIMITS.md already describe seven internal rooms. The user's 2026-11-17 read-only finding identifies missing jd-19. That is the provenance of the new placeholder; this task did not independently access the source to confirm its identity.

Add only internal room 19, placeholderOnly=true, publicJdStoreCandidate=null, unknown internal shop/category/live session and identityCrosswalkVerified=false. No guessed URL, public ID, category or scoring eligibility. The original six records and Douyin section retain exact values. Original top-level updatedAtBeijing remains the old template timestamp; the new row separately records coverageReviewDateBeijing=2026-11-17, not an invented source-observation time.

Current main references to this template in probes/scripts/config/tests were inspected: it is read by offline tests, not by the collection reader. Dynamic source enumeration remains unchanged. Seven template entries are not seven verified public accounts. Existing public candidate URLs remain historical unverified candidates, not current identity evidence.

Tests: node --test tests/jd-crosswalk-placeholder.test.mjs — 3 PASS. Full existing Node suite with loopback-only guard: 286 total, 284 PASS, 0 FAIL, 2 optional browser SKIP. Tests check uniqueness/all-unverified, no invented public identity for 19, unchanged original six entries and Douyin data. diff --check and all 30 workflow YAML parses PASS. No source, browser, live identity, production activation or external-model review performed. No runtime/source/workflow/retention changes.

Independent review: inspect the three assertions, compare template diff to base, verify provenance is the user's supplied read-only finding rather than a new platform request, and keep identityCrosswalkVerified=false until separately authorized evidence establishes all four ID layers. No request to browse existing candidate links is implied.

All 30 tracked workflows audited: this branch and changed paths match no push/PR trigger; existing on/permissions/concurrency unchanged. No collection or deployment triggered. Review-only change, not an identity verification result.
