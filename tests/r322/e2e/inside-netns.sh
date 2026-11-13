# Runs INSIDE a fresh network namespace (see run-sealed-e2e.sh). Needs: NODE ROOT WORK SCEN.
set -eu
if command -v ip >/dev/null 2>&1; then ip link set lo up; else
  python3 -c "import fcntl,socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack('16sH',fcntl.ioctl(s,0x8913,struct.pack('16sH',b'lo',0)))[1];fcntl.ioctl(s,0x8914,struct.pack('16sH',b'lo',f|1))"
fi
# 1) The namespace must be sealed before the probe starts: no route out, no DNS.
"$NODE" -e "const s=require('net').connect({host:'1.1.1.1',port:443});s.setTimeout(3000);s.on('connect',()=>{console.error('NETWORK_NOT_SEALED');process.exit(97)});s.on('timeout',()=>{console.error('NETWORK_NOT_SEALED');process.exit(97)});s.on('error',e=>{console.log('sealed: '+e.code);process.exit(0)})"
"$NODE" -e "require('dns').lookup('example.com',e=>{if(!e){console.error('DNS_NOT_SEALED');process.exit(97)}console.log('dns sealed: '+e.code)})"
# 2) Stand-in pages on loopback only.
"$NODE" "$ROOT/tests/r322/e2e/stand-in-server.mjs" "$ROOT" "$SCEN" "$WORK" 2>"$WORK/$SCEN/server.err" &
SRV=$!
i=0; until grep -q READY "$WORK/$SCEN/server.err"; do i=$((i+1)); [ $i -gt 40 ] && { cat "$WORK/$SCEN/server.err"; exit 98; }; sleep 0.25; done
# 3) The UNCHANGED probe, default blocked-CDN mode (no CDN approval variable).
cd "$ROOT"
HAD_OUT=0; [ -e out ] && HAD_OUT=1
set +e
R316_RPA_ONCE=TWO_ACCOUNTS_ONE_PASS NODE_EXTRA_CA_CERTS="$WORK/cert.pem" timeout 150 "$NODE" probes/r316/douyin-rpa-two-once.mjs > "$WORK/$SCEN/probe-stdout.txt" 2> "$WORK/$SCEN/probe-stderr.txt"
echo $? > "$WORK/$SCEN/probe-exit.txt"
set -e
cp out/r316-rpa-public.json "$WORK/$SCEN/receipt.json"
rm -rf out/r316-private          # plaintext private page data never leaves this step
[ "$HAD_OUT" = 1 ] || rm -rf out
kill -TERM $SRV; wait $SRV || true
