#!/bin/bash
# Restore the immediately preceding completed run, including failed/cancelled runs.
# Never fall back to older success when the latest artifact is absent, corrupt or interrupted.
set -euo pipefail
umask 077
mkdir -p prev out
trap 'code=$?; if [ "$code" != 0 ]; then printf '\''{"reason":"RESTORE_UNVERIFIED"}\n'\'' > out/recovery-block.json; fi' EXIT
if [ -L prev ] || [ -L out ] || [ -e prev/download ] || [ -e prev/run-list.json ] || [ -e out/.jd-history.lock ] || [ -e out/state.json ] || [ -e out/state.json.lock ] || [ -e out/previous.json ] || [ -e out/recovery-block.json ]; then
  echo 'JD_FULLDAY_LOCAL_STATE_REQUIRES_REVIEW' >&2
  exit 1
fi
test "${GITHUB_REPOSITORY}" = 'lijianjun004-star/tcl-live-monitor'
export GH_REPO="$GITHUB_REPOSITORY"
gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/jd-fullday-rate.yml/runs?branch=main&status=completed&per_page=100" > prev/run-list.json
ID=$(node scripts/restore-jd-fullday-state.mjs select prev/run-list.json)
if [ "$ID" = '-' ]; then
  printf 'previous=-\n' >> "$GITHUB_OUTPUT"
  echo 'JD_FULLDAY_EXPLICIT_FIRST_RUN'
else
  gh run download "$ID" -n jd-fullday-state -D prev/download
  node scripts/restore-jd-fullday-state.mjs verify prev/download out/previous.json
  printf 'previous=out/previous.json\n' >> "$GITHUB_OUTPUT"
fi
