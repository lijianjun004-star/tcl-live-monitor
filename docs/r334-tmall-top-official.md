# Official Taobao live metadata query (R3.34)

This is a manual, read-only integration for `taobao.live.batchlives.get`. It uses a normal owned TOP application's credentials, not a browser session or a documentation example key. It does not change the public-page probe, its cooldown, or the production ledger.

## Prerequisites

- An existing TOP application with permission to call this API. Configure a complete repository secret pair: `TOP_APP_KEY` / `TOP_APP_SECRET`, or `TAOBAO_APP_KEY` / `TAOBAO_APP_SECRET`. `TMALL_` and `TB_` pairs are also accepted. Credentials from different prefixes are never combined.
- One to thirty genuine content `live_id` values associated with the approved target accounts. Supply the workflow input `live_ids`, or repository variable `TOP_LIVE_IDS` / `TAOBAO_LIVE_IDS`. Account IDs and the existing `roomNumber` values are not interchangeable with content IDs. Test fixtures are not evidence of real current sessions.

The code can use credentials already configured in Actions without reading their values through the GitHub API. Missing configuration produces a blocked receipt with zero requests; the job deliberately fails rather than reporting that live collection worked. No documentation example or invented ID is substituted.

## Run

In GitHub Actions, select **Tmall official TOP live metadata query (manual, one request)** on main, supply genuine IDs, and explicitly authorize the query. Alternatively, with credentials provided securely in the environment:

```sh
R334_TOP_ONCE=AUTHORIZED_OFFICIAL_READ node probes/r334/tmall-top-once.mjs
```

Set `TOP_LIVE_IDS` in the environment before this command. Never paste credentials into workflow inputs, PRs, logs, or chat. The existing manual authorization allows running the preflight with no IDs; it will report what is missing and will not contact Taobao.

The workflow writes a sanitized `tmall-top-official-query` artifact and summary. The CLI receipt is `out/tmall-top-receipt.json`. Inspect `requestsSent`, `status`, `blockers`, `verifiedRecordCount`, `verifiedLiveCount`, and `allRequestedVerified`; process success alone is not a full-day broadcast result.

`requestsSent` counts client fetch attempts, not acknowledgement by Taobao. A zero count means the preflight prevented any attempt; a network failure with a count of one does not prove the API server received it.

## Interpretation and limits

- At most one query is sent to the fixed official HTTPS endpoint. No redirects, host switching, automatic retries, browser cookies, merchant session, or CAPTCHA interaction.
- Both HTTP and the official response's business success must pass. Missing rows, unsafe numeric IDs, mismatched accounts, and malformed states remain unknown.
- Only registered account metadata is retained. Raw business JSON, broadcaster names, money metrics, playback signatures, URLs, application keys, secrets, and signed requests are not written to artifacts.
- Source status describes the requested session. A replay does not prove the account has no newer live session. This API does not automatically discover future content IDs.
- The official page specifies `end_time` in milliseconds but does not explicitly state the unit of `start_time`. The adapter preserves raw values and does not compute exact live duration before independent time calibration.
- This integration is not yet wired into the production daily rate. Real application permissions, account/content mapping, timing semantics, future-session discovery, and coverage must be verified first.

Exit codes: `0` all requested session metadata verified; `2` blocked prerequisites or inputs; `3` network/platform/business rejection; `4` incomplete or unverified metadata; `1` unexpected CLI failure.

## Sources

- [Batch live metadata API](https://developer.alibaba.com/docs/api.htm?apiId=48613)
- [TOP invocation and signing protocol](https://developer.alibaba.com/docs/doc.htm?articleId=101617&docType=1&treeId=1)
- [Application API permission vs. seller authorization](https://developer.alibaba.com/docs/doc.htm?articleId=101269&docType=1&treeId=153)

The API is documented as not needing seller authorization (`session`); that label does not remove the application credential and API-permission requirements. A workflow preflight or offline fixture test does not establish that the application can call the real API.
