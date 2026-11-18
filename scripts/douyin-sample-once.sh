#!/bin/bash
set -euo pipefail
umask 077
# A killed/cancelled process leaves this block for the always-upload step.
node scripts/douyin-ledger-recovery.mjs begin
pass() {
  local label="$1" target="$2" code
  if R326_TARGET_SET="$target" node probes/r316/douyin-rpa-two-once.mjs; then code=0; else code=$?; fi
  # Stop evidence is durable before receipt moves/imports that can fail.
  node scripts/douyin-ledger-recovery.mjs record-stop "$code" || return 1
  test -f out/r316-rpa-public.json || return 1
  mv out/r316-rpa-public.json "out/receipt-$label.json" || return 1
  if [ -d out/r316-private ]; then mv out/r316-private "out/private-$label" || return 1; fi
  if ! node probes/r322/import-receipt.mjs --receipt "out/receipt-$label.json" --state out/ledger/state.json --html out/ledger/index.html --evidence-kind real > /dev/null 2>&1; then
    echo '::error::DOUYIN_LEDGER_IMPORT_FAILED'
    return 1
  fi
  return "$code"
}
stopped=0
pass a "" || stopped=1
if [ "$stopped" = 0 ]; then sleep 5; pass b SCORING_B || stopped=1; fi
if [ "$stopped" = 0 ]; then sleep 5; pass c MONITOR_C || stopped=1; fi
if [ "$stopped" = 0 ]; then sleep 5; pass d MONITOR_D || stopped=1; fi
if [ "$stopped" = 1 ]; then
  echo '::warning::Douyin sampling stopped; durable recovery block retained. Missing sampling is not OFFLINE.'
  exit 1
fi
node scripts/douyin-ledger-recovery.mjs finish
