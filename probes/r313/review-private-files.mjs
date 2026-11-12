/**
 * R3.13 local-only CLI, no remote requests. Example:
 * node probes/r313/review-private-files.mjs /secure/work.csv /secure/source.json ./config/probe-targets.json
 *
 * Prints aggregate counts only, does NOT print private IDs or any row.
 */
import fs from 'node:fs/promises';
import {resolve,sep,dirname} from 'node:path';
import {auditPrivateBridgeCSV,publicBridgePreflightSummary} from './private-bridge-review.mjs';
if(process.argv.length!==5)throw Error('USAGE_PRIVATE_CSV_SOURCE_JSON_APPROVED_REGISTRY_JSON');
const [csvPath,sourcePath,registryPath]=process.argv.slice(2);
const [csvText,sourceDetail,registry]=await Promise.all([
 fs.readFile(csvPath,'utf8'),
 fs.readFile(sourcePath,'utf8').then(JSON.parse),
 fs.readFile(registryPath,'utf8').then(JSON.parse),
]);
const privateReport=auditPrivateBridgeCSV({csvText,sourceDetail,registry});
console.log('R313_PRIVATE_REVIEW_AGGREGATE_ONLY '+JSON.stringify(publicBridgePreflightSummary(privateReport)));
const out=process.env.R313_PRIVATE_REPORT_PATH;
if(out){
 const cwd=resolve(process.cwd())+sep,dest=resolve(out);
 if(dest.startsWith(cwd))throw Error('PRIVATE_REPORT_DESTINATION_INSIDE_REPOSITORY');
 await fs.mkdir(dirname(dest),{recursive:true,mode:0o700});
 await fs.writeFile(dest,JSON.stringify(privateReport,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('R313_PRIVATE_REPORT_WRITTEN_OUTSIDE_REPOSITORY');
}
if(privateReport.verifiedCrossSystemBridges!==0)throw Error('UNEXPECTED_AUTOMATIC_BRIDGE');
