// Offline audit only; never changes production monitoring targets or source service.
import fs from 'node:fs/promises';
import { auditThreePlatformCoverage } from './lib/coverage-audit.mjs';
const args=process.argv.slice(2),arg=(f,d=null)=>{const i=args.indexOf(f);return i>=0?args[i+1]:d;};
const path=arg('--registry'),cfgPath=arg('--targets','config/probe-targets.json'),out=arg('--out','coverage-audit.private.json');
if(!path){console.error('Usage: node probes/audit-three-platform-coverage.mjs --registry private-registry.json [--targets config/probe-targets.json] [--jd-report historic-jd.json] [--out private-audit.json]');process.exit(2);}
const read=async p=>p?JSON.parse(await fs.readFile(p,'utf8')):null;
const report=auditThreePlatformCoverage({registry:await read(path),publicConfig:await read(cfgPath),jdReport:await read(arg('--jd-report'))});
await fs.writeFile(out,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({output:out,counts:report.counts,totalEvidenceRows:report.totalEvidenceRows,approvedDouyinScoringAccounts:report.approvedDouyinScoringAccounts,globalMonitoringCoverageVerified:report.globalMonitoringCoverageVerified,issues:report.issues}));
