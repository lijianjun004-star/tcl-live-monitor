#!/bin/bash
set -euo pipefail
umask 077
mkdir -p out/ledger prev
printf 'skip=true\nreason=RESTORE_UNVERIFIED\n' >> "$GITHUB_OUTPUT"
node scripts/tmall-ledger-recovery.mjs block
# No fallback to older successful runs, empty state or missing cooldown.
# GitHub and filesystem failures leave the block for the always-upload step.
test "${GITHUB_REPOSITORY}" = 'lijianjun004-star/tcl-live-monitor'
export GH_REPO="$GITHUB_REPOSITORY"
gh run list --workflow tmall-daily-broadcast.yml --branch main --status completed --limit 1 --json databaseId > prev/run-list.json
ID=$(node -e "const r=require('./prev/run-list.json')[0];if(!r||!Number.isSafeInteger(r.databaseId)||r.databaseId<=0)process.exit(1);console.log(r.databaseId)")
gh api "repos/${GH_REPO}/actions/runs/${ID}" > prev/run.json
# Validate provenance BEFORE downloading an artifact.
node --input-type=module -e "import fs from 'node:fs';import {runValid} from './scripts/tmall-ledger-recovery.mjs';const r=JSON.parse(fs.readFileSync('prev/run.json'));if(!runValid(r)||String(r.id)!==process.argv[1])process.exit(1)" "$ID"
gh run download "$ID" -n tmall-daily-ledger -D prev
node scripts/tmall-ledger-recovery.mjs restore
