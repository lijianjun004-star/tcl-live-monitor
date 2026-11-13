#!/bin/sh
# R3.22 sealed end-to-end check (offline). The UNCHANGED RPA probe runs against a loopback stand-in of
# the two approved accounts, inside a NEW network namespace that only has a loopback interface and is
# proven to have no route out before the probe starts. The receipt is then imported with the R3.22
# ledger and checked. Nothing can reach Douyin or any other external host. Needs root or sudo.
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
WORK=$(mktemp -d)
NODE=$(command -v node)
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
PWB=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=r322-sealed-e2e \
  -addext "subjectAltName=DNS:www.douyin.com,DNS:live.douyin.com" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
cp /etc/hosts "$WORK/hosts.bak"
trap '$SUDO cp "$WORK/hosts.bak" /etc/hosts' EXIT
printf '127.0.0.1 www.douyin.com live.douyin.com lf-douyin-pc-web.douyinstatic.com lf-douyin-pc-web-back.douyinstatic.com\n' | $SUDO tee -a /etc/hosts >/dev/null
for SCEN in NORMAL FORBIDDEN_FIRST REAL_LAYOUT FOREIGN_BADGE ROOM_TITLE_EMPTY RAW_ROOM; do
  mkdir -p "$WORK/$SCEN"
  $SUDO env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME="$WORK" PLAYWRIGHT_BROWSERS_PATH="$PWB" \
    NODE="$NODE" ROOT="$ROOT" WORK="$WORK" SCEN="$SCEN" unshare --net sh "$ROOT/tests/r322/e2e/inside-netns.sh"
done
$SUDO chown -R "$(id -u):$(id -g)" "$WORK"
"$NODE" "$ROOT/tests/r322/e2e/assert-e2e.mjs" "$ROOT" "$WORK" "${1:-}"
