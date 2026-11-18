#!/usr/bin/env bash
# Exactly one dispatch attempt; acceptance is not proof of a completed publication.
set -euo pipefail

report() {
  local status="$1" reason="$2" http="${3:-0}" dispatched=false
  # curl's no-response 000 and malformed status must still produce valid JSON.
  if [[ "$http" =~ ^[0-9]{1,3}$ ]]; then http=$((10#$http)); else http=0; fi
  [ "$status" = DISPATCHED ] && dispatched=true
  printf 'R334_RESULTS_REFRESH {"dispatched":%s,"status":"%s","reason":"%s","httpStatus":%s}\n' "$dispatched" "$status" "$reason" "$http"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'status=%s\nreason=%s\ndispatched=%s\n' "$status" "$reason" "$dispatched" >> "$GITHUB_OUTPUT"
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### 结果站刷新请求\n\n状态：**%s**；原因：`%s`。\n\n' "$status" "$reason"
      if [ "$status" = DISPATCHED ]; then
        printf 'GitHub 已接受一次发布请求；**尚未确认发布完成**。请查看 [结果站发布记录](https://github.com/lijianjun004-star/tcl-live-results/actions/workflows/publish.yml)，以对应运行的部署结果为准。\n'
      elif [ "$reason" = REQUEST_FAILED ]; then
        printf '刷新请求未收到可靠结果，是否已被接受未知；本次不会自动重试。请检查关联的发布记录，不能把超时当作已完成或确定未派发。\n'
      else
        printf '本次没有成功派发刷新；不能把本运行的完成状态当作结果站已更新。已有采集结果和其他发布入口不受此状态判定影响。\n'
      fi
      printf '\n数据截至时间以各平台快照的有效观测时间为准；旧快照不能当作本轮新数据，缺样或 UNKNOWN 不代表停播。\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

token=$(printf '%s' "${RESULTS_DISPATCH_TOKEN:-}" | tr -d '[:space:]')
if [ -z "$token" ]; then
  report NOT_DISPATCHED MISSING_CREDENTIAL
  echo '::notice::Results refresh was not dispatched: missing credential.'
  exit 0
fi
case "$token" in
  github_pat_*|ghp_*) ;;
  *) report NOT_DISPATCHED INVALID_CREDENTIAL_FORMAT
     echo '::notice::Results refresh was not dispatched: invalid credential format.'
     exit 0 ;;
esac

# Optional run correlation. Numeric IDs are safe in JSON and summary links.
collector="${RESULTS_COLLECTOR_RUN_ID:-}"
dispatcher="${RESULTS_DISPATCH_RUN_ID:-}"
if [[ "$collector" == *[!0-9]* || "$dispatcher" == *[!0-9]* ]]; then
  report FAILED INVALID_RUN_CONTEXT
  exit 1
fi
payload='{"ref":"main"}'
if [ -n "$collector$dispatcher" ]; then
  printf -v payload '{"ref":"main","inputs":{"collector_run_id":"%s","dispatcher_run_id":"%s"}}' "$collector" "$dispatcher"
fi

if ! code=$(curl -sS --connect-timeout 10 --max-time 45 -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  https://api.github.com/repos/lijianjun004-star/tcl-live-results/actions/workflows/publish.yml/dispatches \
  -d "$payload"); then
  report FAILED REQUEST_FAILED
  exit 1
fi

case "$code" in
  204) report DISPATCHED ACCEPTED 204 ;;
  401|403) report NOT_DISPATCHED CREDENTIAL_REJECTED "$code"
           echo '::notice::Results refresh was not dispatched: GitHub rejected the credential.' ;;
  *) # Do not print response bodies or arbitrary command output.
     [[ "$code" =~ ^[0-9]{3}$ ]] || code=0
     report FAILED HTTP_REJECTED "$code"
     exit 1 ;;
esac
