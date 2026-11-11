// R3.6: read ONLY the user-supplied dashboard HTML and same-origin public /assets/*.js.
// No authentication, cookies, captcha bypass, raw JS logs or public artifacts.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const origin='http://101.96.215.251';
const target=origin+'/?start=2026-10-21&end=2026-10-21&platform=jd&category=%E5%85%A8%E5%93%81%E7%B1%BB&shop_id=17';
const maxJs=2,maxBytes=2_000_000;
const timeout=15000;
const safeGet=async u=>{
 const r=await fetch(u,{method:'GET',headers:{accept:'text/html,application/javascript'},redirect:'manual',signal:AbortSignal.timeout(timeout)});
 if(!r.ok)throw Error('HTTP_'+r.status);
 const len=Number(r.headers.get('content-length'));
 if(Number.isFinite(len)&&len>maxBytes)throw Error('SIZE_LIMIT');
 const a=Buffer.from(await r.arrayBuffer());
 if(a.length>maxBytes)throw Error('SIZE_LIMIT');
 return a;
};
const audit={schemaVersion:36,source:'USER_PROVIDED_TCL_OPS_URL',mode:'READONLY_STATIC_BUNDLE',
  htmlAvailable:false,jsBundlesRead:0,jsBytes:0,hasDouyinLiteral:false,
  hasShopsLiteral:false,hasCaptureDailyLiteral:false,assetsSha256:[],
  referenceSiteJsObtained:false,reaPossible:false,errors:[]};
try{
 const html=(await safeGet(target)).toString('utf8');
 audit.htmlAvailable=true;
 // Scripts are extracted ONLY from passive HTML. No guessed private endpoint paths.
 audit.sourceHtmlHasPlatformLabel=/抖音|douyin/i.test(html);
 audit.sourceHtmlHasShopManagementLabel=/店铺管理/.test(html);
 const candidates=[...html.matchAll(/<script[^>]+src=["']([^"']+\\.js(?:\\?[^"']*)?)["']/gi)].map(x=>x[1]);
 const paths=[...new Set(candidates.map(p=>{try{
  const u=new URL(p,origin);
  if(u.origin!==origin||!/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(u.pathname)||u.search)return null;
  return u.pathname;
 }catch{return null}}).filter(Boolean))].slice(0,maxJs);
 await fs.mkdir('r36-private-js',{recursive:true});
 for(let i=0;i<paths.length;i++){
  try{
   const bytes=await safeGet(origin+paths[i]);
   const s=bytes.toString('utf8');
   audit.jsBundlesRead++;audit.jsBytes+=bytes.length;
   audit.hasDouyinLiteral ||= /douyin|抖音/.test(s);
   audit.hasShopsLiteral ||= /\/api\/shops|店铺管理/.test(s);
   audit.hasCaptureDailyLiteral ||= /\/api\/capture\/room-overview\/daily/.test(s);
   const allowedUiLabels=['抖音','京东','天猫','店铺管理','画面巡检','直播间','场次','排班','开播','下播','日期','品类'];
   const allowedFields=['live_room_id','shop_id','platform','category','start_date','end_date','session_count','minute_count','latest_minute_ts','last_heartbeat_at'];
   const knownRoutes=['/api/shops','/api/capture/rooms','/api/assistant/active-rooms','/api/capture/room-overview/daily','/api/capture/schedules'];
   audit.uiLabelsObserved=[...new Set([...(audit.uiLabelsObserved||[]),...allowedUiLabels.filter(x=>s.includes(x))])];
   audit.fieldNamesObserved=[...new Set([...(audit.fieldNamesObserved||[]),...allowedFields.filter(x=>s.includes(x))])];
   audit.existingKnownRoutesInJs=[...new Set([...(audit.existingKnownRoutesInJs||[]),...knownRoutes.filter(x=>s.includes(x))])];
   audit.hasPotentialPollingClock ||= /setInterval\\(|setTimeout\\(/.test(s);

   audit.assetsSha256.push(createHash('sha256').update(bytes).digest('hex'));
   // Ephemeral workspace only, NEVER uploaded, never printed.
   await fs.writeFile('r36-private-js/bundle-'+i+'.js',bytes);
  }catch(e){audit.errors.push('ASSET_'+String(e.message).slice(0,55))}
 }
 audit.referenceSiteJsObtained=audit.jsBundlesRead>0;
 audit.reaPossible=audit.referenceSiteJsObtained;
}catch(e){audit.errors.push('HTML_'+String(e.message).slice(0,55))}
await fs.writeFile('r36-frontend-safe.json',JSON.stringify(audit,null,2)+'\n');
console.log('R36_FRONTEND_SAFE_AUDIT '+JSON.stringify(audit));
