#!/bin/bash
# Only a complete, authenticated encrypted bundle is eligible for upload.
set -euo pipefail
umask 077
shopt -s nullglob
private=(out/private-*)
[ ! -e out/r316-private ] || private+=(out/r316-private)
work=''
cleanup() {
  code=$?
  trap - EXIT
  [ -z "$work" ] || rm -rf -- "$work"
  rm -rf -- "${private[@]}"
  if [ "$code" != 0 ]; then
    rm -rf out/enc
    echo '::error::PRIVATE_EVIDENCE_ENCRYPTION_FAILED'
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Never combine a stale ciphertext or key with a new run.
rm -rf out/enc
[ "${#private[@]}" -gt 0 ] || exit 0
mkdir -p out
work=$(mktemp -d out/.encrypt-XXXXXXXX)
mkdir "$work/bundle"
names=(); for p in "${private[@]}"; do names+=("${p#out/}"); done
# No filenames, page content, password, or crypto diagnostics in logs.
tar czf "$work/p.tgz" -C out -- "${names[@]}" 2>/dev/null
# OpenSSL -pass file: is line-oriented; use 64 hex characters (256 random bits).
openssl rand -hex 32 > "$work/k.bin" 2>/dev/null
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$work/p.tgz" -out "$work/bundle/p.enc" -pass "file:$work/k.bin" 2>/dev/null
openssl pkeyutl -encrypt -pubin -inkey probes/keys/analysis-pub.pem -pkeyopt rsa_padding_mode:oaep -in "$work/k.bin" -out "$work/bundle/k.enc" 2>/dev/null
node scripts/evidence-integrity.mjs write "$work/k.bin" "$work/bundle" 2>/dev/null
# Same filesystem directory rename publishes all three files together.
mv "$work/bundle" out/enc
