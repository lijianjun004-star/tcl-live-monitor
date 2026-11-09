# Repository Agent Guide

This repository is **TCL live-monitor**, not the TCL practice-room repository. Do not touch any practice-room project, historic deployment, or another repository.

## R1.9 Douyin / FFALCON standard path (mandatory for related work)

Before researching, probing, changing monitoring logic or reporting live status, read:

1. `docs/r19/DOUYIN-FIXED-OPERATION-PATH.md` — canonical 7-step account-first operating procedure.
2. `config/r19-douyin-tcl-ffalcon-registry.json` — exact 14 independent secUid records, 12 primary monitored categories, historical evidence annotations.
3. `probes/r19/operation-path.mjs` and `probes/r19/path-cli.mjs` — programmatic account lookup and deterministic path.
4. `docs/r19/2026-11-09-REAL-LIVE-ROOM-CROSS-CHECK.md` — verified examples and known limitations.

### Required route

```text
exact registry key / display Douyin ID / secUid
 -> stable profile URL /user/<secUid>
 -> match secUid + display ID + account name
 -> inspect fresh on-page "直播中" badge
 -> follow that new badge's current live link ONCE
 -> verify the matching account and active live UI in the room page
 -> persist evidence with actual timestamp, or UNKNOWN with reason
```

Never prefer generic Douyin homepage, keyword searches, affiliate recommendations, or previously visited room links for known accounts. Search/discover only when no exact account exists in the roster. Ambiguous nickname requires explicit account key selection.

### ID and truth rules

- `secUid` is an account identity; **do not merge** FFALCON television, home-appliance and monitor flagships.
- `live.douyin.com/<route>` path is a **route**, not the current dynamic `room_id`.
- Fresh profile badge query `room_id` identifies a **candidate dynamic session**; a historical badge or route never proves current live state.
- If the room canonicalizes its URL, validate the originally navigated URL AND final exact same HTTPS host and route.
- Only profile + room + visible live UI with matching identity can establish that the account was LIVE **at the observation time**. Never infer exact start/end time from this.
- No badge, timeouts, challenge, login wall, 429, account mismatch, uncertain metadata, stale data, or nonmatching room -> `UNKNOWN`. **OFFLINE detection has not been field-validated**.
- Current roster `score_eligible:false`; no full-stream assessment, cron or production deployment.

### Tools and safety

- Use an ordinary authorized browser profile only. No captcha bypass, stealth fingerprinting, signature forging/replay, copied credentials, or rotating proxies to avoid platform blocks.
- Stop after the first site access limit rather than retrying multiple times.
- Never initiate purchases, follows, messages or account changes.
- The one-shot public browser script requires **one** explicit `--key` and `--execute`; without both it must not hit Douyin.
- Keep this work in the existing experiment PR #30, not `main`. Maintain draft PR and no deployment pending acceptance.

### Verification commands

```bash
node probes/r19/path-cli.mjs --list
node probes/r19/path-cli.mjs --key ffalcon-douyin-tv-flagship
node --test tests/*.test.mjs
```

These commands do not access the Douyin platform. Historical LIVE screenshots are documentation, not current live observations.
