/**
 * R3.11 encrypted one-shot internal OPS room detail export.
 * Raw room/shop IDs are kept ONLY in memory and AES-256-GCM encrypted before
 * any file write. Never print them, store plaintext, retry access, or schedule.
 * RSA-3072 private key is NOT in this repository or CI environment.
 */
import fs from 'node:fs/promises';
import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
import {scanDouyinOps} from '../r36/douyin-ops-parity.mjs';
import {networkReader,SOURCE_ROUTES} from '../lib/tcl-jd-all.mjs';
if(process.env.R311_ENCRYPTED_ONESHOT!=='ONE_PUBLIC_KEY_PROTECTED_EXPORT')
 throw Error('R311_ENCRYPTED_EXPORT_NOT_AUTHORIZED');
const allowed=new Set(Object.values(SOURCE_ROUTES));
const get=networkReader('http://101.96.215.251',globalThis.fetch,15000);
const reader=async(path,params)=>{
 if(!allowed.has(path))throw Error('ROUTE_NOT_ALLOWED');
 if(params && (path!==SOURCE_ROUTES.daily ||
  !/^\d{4}-\d{2}-\d{2}$/.test(String(params.start_date||'')) ||
  params.start_date!==params.end_date ||
  !['dy','douyin','抖音'].includes(String(params.platform||'').toLowerCase()) ||
  !/^\d{1,16}$/.test(String(params.live_room_id||''))))
  throw Error('DAILY_QUERY_NOT_ALLOWED');
 return get(path,params);
};
const config=JSON.parse(await fs.readFile('config/probe-targets.json','utf8'));
const result=await scanDouyinOps({reader,config,maxRooms:60,at:Date.now()});
if(result.sourceAccess!=='ROOM_CATALOG_RECEIVED' || !Array.isArray(result.rooms)||!result.rooms.length)
 throw Error('SOURCE_UNAVAILABLE_NO_EXPORT');
const records=result.rooms.map((r,i)=>({
 ordinal:i+1,opsRoomId:r.roomId,opsShopId:r.shopId,platform:r.platform,
 category:r.category,captureBound:r.captureBound===true,
 opsShopIdentityMatched:r.opsShopIdentityMatched===true,
 internalObservationState:r.status==='LIVE'?'LIVE':'UNKNOWN',
 reason:r.reason,publicAccountMatched:false,
 exactStartAt:null,exactEndAt:null
}));
const payload={
 schemaVersion:311,source:'TCL_OPS_EXISTING_APPROVED_GET_ROUTES',
 checkedAt:result.checkedAt,beijingDate:result.date,previousSourceRun:'43015295953',
 catalogComplete:result.catalogComplete===true,sourceReportedItems:result.sourceReportedItems,
 observedSourceDouyinRooms:records.length,sourceShopJoinCount:result.shopJoinCount,
 captureBoundRooms:records.filter(r=>r.captureBound).length,
 identityBridgesVerified:0,formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
 notes:'These are internal OPS records, NOT proven public accounts or real-time LIVE sessions.',
 rooms:records
};
const publicKey=await fs.readFile('probes/r311/r311-one-shot-public-key.pem','utf8');
const key=randomBytes(32),iv=randomBytes(12);
const cipher=createCipheriv('aes-256-gcm',key,iv);
const plain=Buffer.from(JSON.stringify(payload),'utf8');
const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
const tag=cipher.getAuthTag();
const wrapped=publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
plain.fill(0);key.fill(0);
await fs.mkdir('out/r311',{recursive:true});
const envelope={schemaVersion:311,encryption:'AES-256-GCM+RSA-OAEP-SHA256',
  encryptedPayloadBase64:encrypted.toString('base64'),
  wrappedKeyBase64:wrapped.toString('base64'),
  nonceBase64:iv.toString('base64'),tagBase64:tag.toString('base64'),
  sourceRun:'R311_ENCRYPTED_USER_EXPORT'};
await fs.writeFile('out/r311/internal-ops-room-encrypted.json',JSON.stringify(envelope,null,2)+'\n',{mode:0o600});
console.log('R311_PRIVATE_EXPORT_SAFE_COUNTS '+JSON.stringify({
 observedInternalRooms:records.length,shopJoins:result.shopJoinCount,
 captureBoundRooms:payload.captureBoundRooms,publicIdentitiesJoined:0,
 catalogComplete:result.catalogComplete,encrypted:true,rawIDsLogged:false,
 formalOpeningRatePercent:null,formalFullDurationRatePercent:null
}));
if(records.length<10){console.error('BELOW_ORIGINAL_10_SOURCE_BASELINE');process.exitCode=3;}
