#!/bin/bash
# Latest completed MAIN run, including failure/cancellation. No older-success fallback.
set -euo pipefail
umask 077
mkdir -p out/ledger prev
printf 'skip=true\nreason=RESTORE_UNVERIFIED\n' >> "$GITHUB_OUTPUT"
node scripts/douyin-ledger-recovery.mjs prepare
test "${GITHUB_REPOSITORY}" = 'lijianjun004-star/tcl-live-monitor'
export GH_REPO="$GITHUB_REPOSITORY"
gh run list --workflow douyin-daily-broadcast.yml --branch main --status completed --limit 1 --json databaseId,status,conclusion > prev/run-list.json
ID=$(node --input-type=module -e "import fs from 'node:fs';const r=JSON.parse(fs.readFileSync('prev/run-list.json'))[0];if(!r||!Number.isSafeInteger(r.databaseId)||r.databaseId<=0||r.status!=='completed')process.exit(1);console.log(r.databaseId)")
gh api "repos/${GH_REPO}/actions/runs/${ID}" > prev/run.json
node --input-type=module -e "import fs from 'node:fs';import {runValid} from './scripts/douyin-ledger-recovery.mjs';const r=JSON.parse(fs.readFileSync('prev/run.json'));if(!runValid(r)||String(r.id)!==process.argv[1])process.exit(1)" "$ID"
gh run download "$ID" -n douyin-daily-ledger -D prev
node scripts/douyin-ledger-recovery.mjs restore
