# Official TOP structure probes (R3.34)

Two manual, read-only probes for the open question of how to find the content `live_id` values that [taobao.live.batchlives.get](r334-tmall-top-official.md) needs. They record the **structure** of the real response and where the registered accounts appear. They do not collect live data, they are not wired into the production ledger, and they do not change the public-page probe or its cooldown.

| Mode | Official method | Question it answers |
| --- | --- | --- |
| `venue` | `alibaba.taobao.live.recommend.alipay.query` ([70809](https://developer.alibaba.com/docs/api.htm?apiId=70809)) | Given the registered account IDs, does it return their live sessions and `live_id` values? |
| `contents` | `taobao.live.contents.query` ([69002](https://developer.alibaba.com/docs/api.htm?apiId=69002)) | Can one day's sessions be listed, whose scope is it, and what does `data_json_str` contain? |

Neither page documents the response well: 70809 does not say whether it returns all of an account's sessions or only those shown on the Alipay venue, and 69002 does not describe `data_json_str` or whose sessions it covers. The probe exists to replace those unknowns with a real, sanitized answer before any parser is written.

## Prerequisites

- The same application credentials as the batch query: a complete `TOP_` / `TAOBAO_` / `TMALL_` / `TB_` `APP_KEY` and `APP_SECRET` pair in repository secrets. Never paste them into inputs, PRs, logs or chat.
- Permission for the chosen API on that application. Both pages are labelled as needing no seller authorization, which does not remove the application and API-permission requirements; a permission error is itself a result worth recording (`apiErrorCode` 11, 12 or 13).
- The nine registered accounts in `config/probe-targets.json`. Their IDs are the only accounts the probe sends and the only ones it records values for.

## Run

In GitHub Actions, select **Tmall official TOP structure probe (manual, one request)** on main, pick the mode, and explicitly authorize it. The first run should leave every optional input empty:

- `venue` sends only `anchor_id_list` with the registered account IDs. The pages do not say which of the other optional parameters matter, so `scene`, `live_source`, `rule_code`, `venue_count` and `venue_page` can be set (validated, letters/digits/`.`/`_`/`-` only) for a later, separate run. Each run is one request.
- `contents` sends `query_date` (default yesterday in Beijing time), `start` (default 0) and `page_size` (default 20).

With no credentials, an invalid mode or invalid options the job makes no request, saves a `BLOCKED` receipt, and fails on purpose. Locally: `R334_TOP_EXPLORE=AUTHORIZED_STRUCTURE_READ R334_TOP_MODE=venue node probes/r334/tmall-top-explore-once.mjs` with the credentials in the environment.

## What the receipt contains

`out/tmall-top-explore-receipt.json` (artifact `tmall-top-explore`, 7 days) and the step summary hold:

- `status`: `EXPLORED` (HTTP and platform success, one recognizable `*_response` root), `PARTIAL` (parsed, but the root is not recognizable), `REJECTED` (HTTP, network, platform error or a business failure flag) or `BLOCKED`. `requestsSent` is 0 or 1. `apiErrorCode` and `apiSubCode` are recorded for platform errors.
- `shape`: a merged description of the whole response. Keys are listed only if they look like field names (a letter, then letters, digits or `_`; at most 64 characters, 60 per object); other keys are only counted (`$otherKeys`, `$omittedKeys`). Scalars are shown as their type (`string`, `integer`, `null`, ...), arrays as `$array` with the length and `$items`, and JSON carried inside a string (such as `data_json_str`) is parsed and shown as `$json`. Depth, node count and receipt size are bounded (`shapeTruncated`).
- `envelope`: small status and count scalars near the root (`success`, `msg_code`, `error_code`, `total_count`, page counts). `total_count` helps show the scope of the 69002 listing. A `success: false` or non-empty `error_code` makes the run `REJECTED` while keeping the structure that was seen.
- `registeredHits`: matched by account ID **value** anywhere an object field equals a registered ID, so a renamed field is still found and reported under its field name (`matchedFields`). For each hit only the session record that holds the field is summarized, through allow-listed field names: `ids` (live, room, topic, content, feed IDs; account IDs of other accounts appear only as `OTHER_ACCOUNT`), `enums` (status and type fields, as short numeric tokens or identifier-like words) and `times` (time fields as form, digit count and unit evidence, never the value). Lists inside a record are skipped, so recommendation-reason times and products never enter a hit.
- `registeredWithoutRecord`, `otherAccountCount` and `registeredHitsOmitted`: which registered accounts were not returned, how many distinct other accounts appeared (counted only, never listed) and how many hits were beyond the cap. A large `otherAccountCount` in `venue` mode means the account filter is not strict.

Never stored: the response itself, titles, covers, stream URLs, nicknames, products, prices, viewer counts, request IDs, platform messages, signed requests, credentials, or any value of an unregistered account.

## Interpretation and limits

- A registered account that is **not** returned is `UNKNOWN`. Neither a missing record nor an empty list shows that the account is offline, and a replay or an old session does not show that no newer session exists.
- A hit shows that an ID with the same value appeared, not that the ID namespace is the same as the batch API's `account_id`. Confirming that needs a follow-up batch query on the discovered `live_id` and a match of its `account_id`.
- Times inside 70809's `rec_reason_infos` are recommendation-reason times, not broadcast start and end, and are never used for broadcast rates.
- `EXPLORED` means a response was received and its structure recorded. It does not verify coverage, freshness, completeness or the ability to discover future sessions.
- The pages list `eco.taobao.com` for HTTPS while the general invocation guide lists `gw.api.taobao.com`. The probes use the guide's host, like the batch client. A transport-level failure is not retried or redirected to the other host automatically.
- If the first real response does show the needed fields, the next step is a reviewed change that adds a small parser and a discovery-to-batch path with its own tests. Nothing here feeds the production daily rate.

Exit codes: `0` structure recorded; `2` blocked prerequisites or inputs; `3` network, platform or business rejection; `4` response not recognizable; `1` unexpected CLI failure.
