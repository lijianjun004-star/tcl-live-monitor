#!/bin/bash
set -euo pipefail
umask 077
# Persist an in-progress sentinel before the existing one-pass collector starts.
node scripts/tmall-ledger-recovery.mjs begin
set +e
node probes/r329/tmall-daily-once.mjs
code=$?
set -e
# Record a stop or incomplete receipt before the importer can fail.
node scripts/tmall-ledger-recovery.mjs record-stop "$code"
if ! node probes/r322/import-receipt.mjs --receipt out/tmall-receipt.json --state out/ledger/state.json --html out/ledger/index.html --platform tmall --evidence-kind real > /dev/null 2>&1; then
  echo '::error::TMALL_LEDGER_IMPORT_FAILED'
  exit 1
fi
node scripts/tmall-ledger-recovery.mjs finish "$code"
