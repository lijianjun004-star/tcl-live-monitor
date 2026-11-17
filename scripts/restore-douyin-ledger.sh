#!/bin/bash
# Select latest completed MAIN run, not latest successful run. Never fall back after an error.
set -euo pipefail
umask 077
mkdir -p out/ledger prev
# Any command failure must leave a durable block, even without a valid ledger.
trap 'code=$?; if [ "$code" != 0 ]; then printf '\''{"reason":"RESTORE_UNVERIFIED"}\n'\'' > out/ledger/recovery-block.json; fi' EXIT
printf 'skip=true\nreason=RESTORE_UNVERIFIED\n' >> "$GITHUB_OUTPUT"
gh run list --workflow douyin-daily-broadcast.yml --branch main --status completed --limit 1 --json databaseId,status,conclusion > prev/run-list.json
ID=$(node --input-type=module -e "import fs from 'node:fs';const r=JSON.parse(fs.readFileSync('prev/run-list.json'))[0];if(!r||!/^\\d+$/.test(String(r.databaseId))||r.status!=='completed')process.exit(1);console.log(r.databaseId)")
gh run download "$ID" -n douyin-daily-ledger -D prev
if [ -f prev/recovery-block.json ]; then cp prev/recovery-block.json out/ledger/recovery-block.json; fi
node probes/r325/daily-report.mjs prev/state.json > /dev/null 2>&1
cp prev/state.json out/ledger/state.json
node --input-type=module <<'JS'
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {restorePolicy,reviewedRecovery} from './scripts/douyin-restore-policy.mjs';
const run=JSON.parse(fs.readFileSync('prev/run-list.json'))[0];
let cooldown=null;
if(fs.existsSync('prev/cooldown.json')) {
  // Preserve even an invalid marker. Parse errors stop the step before any source access.
  fs.copyFileSync('prev/cooldown.json','out/ledger/cooldown.json');
  cooldown=JSON.parse(fs.readFileSync('prev/cooldown.json'));
}
const recoveryBlocked=fs.existsSync('prev/recovery-block.json') || run.conclusion!=='success';
if(recoveryBlocked) fs.writeFileSync('out/ledger/recovery-block.json',JSON.stringify({reason:'REVIEW_REQUIRED'}));
const digest=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const approvalFile='config/douyin-recovery-approval.json';
const receipt=fs.existsSync(approvalFile)?JSON.parse(fs.readFileSync(approvalFile)):null;
const reviewed=reviewedRecovery(receipt,{run,stateSha256:digest('prev/state.json'),cooldownSha256:digest('prev/cooldown.json'),blockSha256:digest('prev/recovery-block.json')});
const d=restorePolicy({run:reviewed?{...run,conclusion:'success'}:run,downloaded:true,ledgerValid:true,cooldown,recoveryBlocked:recoveryBlocked&&!reviewed});
if(reviewed&&!d.skip){
  fs.rmSync('out/ledger/recovery-block.json',{force:true});
  fs.writeFileSync('out/ledger/recovery-reviewed.json',JSON.stringify(receipt));
}
fs.appendFileSync(process.env.GITHUB_OUTPUT,`skip=${d.skip}\nreason=${d.reason}\n`);
console.log(JSON.stringify({restoredRun:String(run.databaseId),...d}));
JS
