/** R3.13 one-shot approved TCL OPS category refresh; encrypted output ONLY. */
import fs from 'node:fs/promises';
import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
import {networkReader,SOURCE_ROUTES,extractArray} from '../lib/tcl-jd-all.mjs';
import {inspectDouyinCatalog,inspectDouyinShops,isDouyin} from '../r36/douyin-ops-parity.mjs';

if(process.env.R314_CANDIDATE_ONESHOT!=='R314_BOUNDED_TWO_GET_READS')
 throw Error('R314_ONESHOT_GUARD_REQUIRED');
const get=networkReader('http://101.96.215.251',globalThis.fetch,15000);
const [roomDoc,shopDoc]=await Promise.all([
 get(SOURCE_ROUTES.rooms),get(SOURCE_ROUTES.shops)]);
const catalog=inspectDouyinCatalog(roomDoc,80),shops=inspectDouyinShops(shopDoc);
if(catalog.rooms.length<10)throw Error('BELOW_HISTORIC_TEN_ROOM_BASELINE');
const rawRooms=extractArray(roomDoc,[['rooms'],['data','rooms'],['data','list'],['list']],'ROOMS');
const rawShops=extractArray(shopDoc,[[],['shops'],['data','shops'],['data','list'],['list']],'SHOPS');
const rawRoomMap=new Map();
for(const r of rawRooms){
 if(!isDouyin(r?.platform))continue;
 const roomId=String(r?.id??r?.live_room_id??r?.room_id??'');
 if(/^[1-9][0-9]{0,15}$/.test(roomId)&&!rawRoomMap.has(roomId))rawRoomMap.set(roomId,r);
}
const rawShopMap=new Map();
for(const s of rawShops){
 if(!isDouyin(s?.platform))continue;
 const id=String(s?.id??s?.shop_id??s?.shopId??'');
 if(/^[1-9][0-9]{0,15}$/.test(id)&&!rawShopMap.has(id))rawShopMap.set(id,s);
}
const sane=(value,max=80)=>{
 if(typeof value!=='string')return null;
 return value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max)||null;
};
const sourceRows=catalog.rooms.map(r=>{
 const raw=rawRoomMap.get(r.roomId);
 const shop=rawShopMap.get(r.shopId);
 return {
  opsRoomId:r.roomId,opsShopId:r.shopId,platform:r.platform,
  latestRawCategory:sane(raw?.category,35),
  normalizedCategory:r.category,
  shopNameHint:sane(shop?.name??shop?.shop_name??shop?.title),
  shopRecordPresent:Boolean(shop),
  captureBound:r.captureBound===true,
  // Source-provided hints are NOT evidence of public account binding.
  sourceDeclaredSecUidHint:sane(shop?.douyin_sec_uid??shop?.sec_uid??shop?.secUid,180),
  sourceDeclaredAccountHint:sane(shop?.douyin_account_id??shop?.account_id,80),
 };
});
const payload={schemaVersion:313,scope:'PRIVATE_SOURCE_ROOM_SHOP_NAME_CANDIDATES_20261112',
 checkedAt:new Date().toISOString(),sourceRoomCount:sourceRows.length,
 shopCount:shops.length,shopJoinCount:sourceRows.filter(x=>x.shopRecordPresent).length,
 catalogComplete:catalog.catalogComplete===true,identityBridgesVerified:0,
 formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
 sourceRows, noPublicSecUidProof:true, noAutoBridge:true};
const pub=await fs.readFile('probes/r314/public-encryption-key.pem','utf8');
const plain=Buffer.from(JSON.stringify(payload));
const aes=randomBytes(32),nonce=randomBytes(12);
const c=createCipheriv('aes-256-gcm',aes,nonce);
const ciphertext=Buffer.concat([c.update(plain),c.final()]);
const wrapped=publicEncrypt({key:pub,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},aes);
const tag=c.getAuthTag();
plain.fill(0);aes.fill(0);
const envelope={schemaVersion:313,method:'AES-256-GCM+RSA-OAEP-SHA256',
 wrappedKeyBase64:wrapped.toString('base64'),ciphertextBase64:ciphertext.toString('base64'),
 nonceBase64:nonce.toString('base64'),tagBase64:tag.toString('base64')};
await fs.mkdir('out/r314',{recursive:true});
await fs.writeFile('out/r314/ops-shop-name-private-encrypted.json',JSON.stringify(envelope)+'\n',{mode:0o600});
console.log('R314_SOURCE_SAFE_COUNTS '+JSON.stringify({observedOpsRooms:sourceRows.length,
 shopRecords:shops.length,sourceShopJoins:payload.shopJoinCount,
 rawDataLogged:false,encrypted:true,identityBridgesVerified:0,catalogComplete:payload.catalogComplete}));
