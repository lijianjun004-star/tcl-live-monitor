/**
 * R3.11 isolated TCL OPS source census, one shot only. 4 existing GET route
 * types; never store raw room/shop IDs, source bodies, credentials or cookies
 * in PUBLIC GitHub logs/artifacts. Do not enable schedule or production writes.
 */
import fs from 'node:fs/promises';
import {scanDouyinOps} from '../r36/douyin-ops-parity.mjs';
import {reconcileDouyinCatalog,publicDouyinCatalogReceipt} from './douyin-catalog-reconcile.mjs';
import {networkReader,SOURCE_ROUTES} from '../lib/tcl-jd-all.mjs';

if(process.env.R311_SOURCE_ONESHOT!=='READ_FOUR_APPROVED_ROUTES_ONCE')throw Error('ONESHOT_GUARD_REQUIRED');
const ORIGIN='http://101.96.215.251';
const routeAllow=new Set(Object.values(SOURCE_ROUTES));
const sourceReader=networkReader(ORIGIN,globalThis.fetch,15000);
const readonly=async(path,params)=>{
 if(!routeAllow.has(path))throw Error('SOURCE_ROUTE_NOT_APPROVED');
 if(params && (path!==SOURCE_ROUTES.daily ||
   !/^\d{4}-\d{2}-\d{2}$/.test(params.start_date) ||
   params.start_date!==params.end_date ||
   !['dy','douyin','抖音'].includes(String(params.platform||'').toLowerCase()) ||
   !/^[0-9]{1,16}$/.test(String(params.live_room_id||''))))
   throw Error('INVALID_DAILY_QUERY');
 return sourceReader(path,params);
};
const config=JSON.parse(await fs.readFile('config/probe-targets.json','utf8'));
const source=await scanDouyinOps({reader:readonly,config,at:Date.now(),maxRooms:60});
const inventory=reconcileDouyinCatalog({sourceReport:source,approvedAccounts:config.douyin,
 rpaObservations:[],bridgeEvidence:[],historicalConfirmedMinimum:10});
const receipt=publicDouyinCatalogReceipt(inventory);
receipt.baselineSourceRun='43015295953';
receipt.rpaExcludedFromSourceCensus=true;
receipt.individualRoomIDsOmittedBecauseRepoIsPublic=true;
receipt.notProofOfActualBroadcastStatus=true;
await fs.mkdir('out/r311',{recursive:true});
await fs.writeFile('out/r311/source-catalog-public-receipt.json',JSON.stringify(receipt,null,2)+'\n');
console.log('R311_SOURCE_CATALOG_SAFE_RECEIPT '+JSON.stringify(receipt));
if(inventory.sourceAccess!=='ROOM_CATALOG_RECEIVED') {
 console.error('R311_SOURCE_UNAVAILABLE_NOT_ZERO_ROOMS');process.exitCode=2;
}else if(inventory.observedSourceRoomsThisRun<10){
 console.error('R311_BELOW_HISTORICAL_10_ROOMS_NO_DELETION_ALLOWED');process.exitCode=3;
}
