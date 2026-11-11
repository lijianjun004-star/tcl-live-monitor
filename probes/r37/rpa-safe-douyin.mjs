/**
 * R3.7 - Public guest RPA evidence sampler (experimental, read-only).
 * Zero login, cookie export, screenshot, raw HTML, private API, anti-bot bypass,
 * background cron, production persistence or formal rate scoring.
 *
 * Needs an explicitly approved public Douyin account and a browserFactory.
 * Browser automation may establish a public PAGE observation only; it cannot
 * validate TCL OPS room/shop -> public account ownership or exact session times.
 */
import {decideDouyin, profileIdentity, liveAnchorRoomIds} from '../lib/douyin.mjs';
import {normalizedPublicLiveAnchors,safePublicDomDiagnostics,identifyDomGap} from '../r39/rpa-dom-signal-utils.mjs';

const MAX_TARGETS=2;
const WALL=/(验证码|安全验证|滑块|captcha|请先登录|登录后观看|扫码登录|登录抖音|人机验证|verify you are human)/i;
const UID=/^MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/;
const DISPLAY=/^[A-Za-z0-9._-]{3,32}$/;
const VALID_HOSTS=new Set(['www.douyin.com','live.douyin.com']);

export function approvedDouyinRpaTargets(config,keys){
  if(!Array.isArray(config?.douyin)||!Array.isArray(keys)||keys.length<1||keys.length>MAX_TARGETS
     ||new Set(keys).size!==keys.length)throw Error('RPA_ONE_OR_TWO_UNIQUE_TARGETS_REQUIRED');
  const selected=[];
  for(const key of keys){
    const x=config.douyin.find(a=>a.key===key);
    if(!x||x.scopeApproved!==true||!DISPLAY.test(String(x.displayDouyinId||'')))throw Error('RPA_TARGET_NOT_APPROVED');
    let u;try{u=new URL(x.profileUrl)}catch{throw Error('RPA_INVALID_TARGET_URL')}
    if(u.protocol!=='https:'||u.hostname!=='www.douyin.com'||u.port||u.username||u.password||u.search||u.hash
      ||!UID.test(u.pathname.replace(/^\/user\//,''))||!u.pathname.startsWith('/user/'))throw Error('RPA_INVALID_TARGET_URL');
    if(typeof x.accountName!=='string'||x.accountName.length<2||x.accountName.length>80)throw Error('RPA_INVALID_ACCOUNT_NAME');
    selected.push({key:x.key,accountName:x.accountName,displayDouyinId:x.displayDouyinId,
      profileUrl:u.href,configuredRoomId:/^\d{5,24}$/.test(String(x.roomId||''))?String(x.roomId):null});
  }
  return selected;
}

export function safeDouyinPageURL(raw,role){
  let u;try{u=new URL(raw)}catch{return false}
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash)return false;
  if(role==='profile')return u.hostname==='www.douyin.com'&&/^\/user\/MS4wLjABAAAA[A-Za-z0-9_-]{20,150}$/.test(u.pathname);
  if(role==='room')return u.hostname==='live.douyin.com'&&/^\/\d{5,24}$/.test(u.pathname);
  return false;
}

export function isRpaAccessBlocked(s){
  return Boolean(s?.accessBlocked||[401,403,429].includes(s?.httpStatus)||
    !VALID_HOSTS.has(s?.finalHost)||WALL.test(String(s?.title||'')+' '+String(s?.bodyExcerpt||'')));
}

export async function inspectPublicPage(page,url,role,{holdMs=800}={}){
  if(!safeDouyinPageURL(url,role))throw Error('RPA_URL_NOT_ALLOWLISTED');
  const output={httpStatus:null,title:'',bodyExcerpt:'',metaDescription:'',
    douyinIdsInPage:[],liveRoomAnchors:[],finalHost:null};
  try{
    const resp=await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});
    output.httpStatus=resp?.status()??null;
    const final=new URL(page.url());
    output.finalHost=final.hostname;
    if(!safeDouyinPageURL(final.href,role)||output.httpStatus!==200)return {...output,accessBlocked:true};
    if(holdMs>0)await page.waitForTimeout(Math.min(holdMs,1800));
    const readDOM=()=>page.evaluate(()=>{
      const fullText=String(document.body?.innerText||'').replace(/\s+/g,' ');
      const elements=[...document.querySelectorAll('a[href]')].slice(0,2000);
      const candidates=[];let liveHostAnchorCount=0,liveLabeledAnchorCount=0;
      for(const element of elements){
        let u;try{u=new URL(String(element.href||''))}catch{continue}
        if(u.protocol!=='https:'||u.hostname!=='live.douyin.com'||
           !/^\/\d{5,24}\/?$/.test(u.pathname))continue;
        liveHostAnchorCount++;
        const text=String(element.textContent||'').slice(0,64);
        const ariaLabel=String(element.getAttribute('aria-label')||'').slice(0,64);
        const title=String(element.getAttribute('title')||'').slice(0,64);
        const childLabel=String(element.querySelector('[aria-label]')?.getAttribute('aria-label')||'').slice(0,64);
        if(/直播中|正在直播|开播中/.test([text,ariaLabel,title,childLabel].join(' ')))liveLabeledAnchorCount++;
        if(candidates.length<100)candidates.push({href:u.href,text,ariaLabel,title,childLabel});
      }
      const buttons=[...document.querySelectorAll('button,[role="button"]')].slice(0,400);
      return {
        title:String(document.title||'').slice(0,150),
        bodyExcerpt:fullText.slice(0,700),
        metaDescription:String(document.querySelector('meta[name="description"]')?.content||'').slice(0,180),
        douyinIdsInPage:[...fullText.matchAll(/抖音号[:：]\s*([A-Za-z0-9._-]{3,32})/g)].slice(0,5).map(m=>m[1]),
        liveRoomCandidates:candidates,
        rawDomSignal:{
          totalAnchors:elements.length,
          liveHostAnchorCount,
          liveLabeledAnchorCount,
          visibleLiveTextMentions:(fullText.slice(0,20000).match(/直播中|正在直播|开播中/g)||[]).length,
          liveRelatedButtons:buttons.filter(b=>/直播中|正在直播|开播中/.test(String(b.textContent||'').slice(0,80)+' '+String(b.getAttribute('aria-label')||'').slice(0,80))).length,
          domTextLength:fullText.length,
        },
      };
    });
    let snap=await readDOM();
    let anchors=normalizedPublicLiveAnchors(snap?.liveRoomCandidates??snap?.liveRoomAnchors);
    let delayed=false;
    // One extra DOM-only sampling pass, no second navigation or API request.
    if(role==='profile' && !anchors.length && !isRpaAccessBlocked({...out,...snap})){
      await page.waitForTimeout(1200);
      snap=await readDOM();
      anchors=normalizedPublicLiveAnchors(snap?.liveRoomCandidates??snap?.liveRoomAnchors);
      delayed=true;
    }
    const diagnostics=safePublicDomDiagnostics(snap?.rawDomSignal,anchors.length,delayed);
    return {...out,
      title:String(snap?.title||'').slice(0,150),bodyExcerpt:String(snap?.bodyExcerpt||'').slice(0,700),
      metaDescription:String(snap?.metaDescription||'').slice(0,180),
      douyinIdsInPage:Array.isArray(snap?.douyinIdsInPage)?snap.douyinIdsInPage.slice(0,5):[],
      liveRoomAnchors:anchors,domDiagnostics:diagnostics,domGap:identifyDomGap(diagnostics)};

  }catch{
    return {...output,accessBlocked:true}; // No exception content or URLs in reports.
  }
}

const UNKNOWN=(key,checkedAt,reason,profileStatus=null,roomStatus=null)=>({
  accountKey:key,checkedAt,state:'UNKNOWN',reason,publicSource:'PUBLIC_GUEST_RPA',
  profileHttp:profileStatus,roomHttp:roomStatus,profileIdentityVerified:false,
  roomIdentityVerified:false,observedRoomId:null,offlineCandidate:false,
  opsBridgeVerified:false,exactStartAt:null,exactEndAt:null,
});

export async function runDouyinRpaReadOnly({
  config,keys,browserFactory=async()=>{const {chromium}=await import('playwright');return chromium.launch({headless:true})},
  clock=()=>new Date().toISOString(),holdMs=800
}={}){
  const targets=approvedDouyinRpaTargets(config,keys);
  const report={schemaVersion:37,platform:'douyin',mode:'RPA_MANUAL_PUBLIC_GUEST_READONLY',
    sourceAccess:'NOT_STARTED',stoppedForChallenge:false,observations:[],
    verifiedOpsBridgeCount:0,formalOpeningRatePercent:null,formalFullDurationRatePercent:null,
    exactStartTimesKnown:0,exactEndTimesKnown:0};
  let browser,context;
  try{
    browser=await browserFactory();
    context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
      locale:'zh-CN',serviceWorkers:'block',acceptDownloads:false});
    // Apply request method and navigation allowlists across the *whole context*:
    // popups and page-level routes must not accidentally bypass this policy.
    await context.route('**/*',async route=>{
      const request=route.request();
      const method=request.method();
      if(method!=='GET'&&method!=='HEAD')return route.abort();
      if(request.isNavigationRequest()){
        try{const u=new URL(request.url());if(u.protocol!=='https:'||!VALID_HOSTS.has(u.hostname))return route.abort();}
        catch{return route.abort()}
      }
      return route.continue();
    });
    report.sourceAccess='ATTEMPTED_PUBLIC_PAGE';
    for(const target of targets){
      const checkedAt=clock();
      let profilePage, roomPage;
      try{
        profilePage=await context.newPage();
        const p=await inspectPublicPage(profilePage,target.profileUrl,'profile',{holdMs});
        if(isRpaAccessBlocked(p)){
          report.observations.push(UNKNOWN(target.key,checkedAt,'PROFILE_ACCESS_BLOCKED_OR_CHALLENGED',p.httpStatus));
          report.stoppedForChallenge=true;break;
        }
        const pid=profileIdentity(p,target);
        const anchors=pid?liveAnchorRoomIds(p):[];
        if(!anchors.length){
          report.observations.push({...UNKNOWN(target.key,checkedAt,pid?'PROFILE_NO_VERIFIED_LIVE_ANCHOR':'PROFILE_IDENTITY_NOT_VERIFIED',p.httpStatus),
            profileIdentityVerified:pid,profileDomDiagnostics:p.domDiagnostics??null,profileDomGap:p.domGap??null});
          continue;
        }
        const observed=anchors[0];
        const roomUrl='https://live.douyin.com/'+observed;
        if(!safeDouyinPageURL(roomUrl,'room'))throw Error('RPA_ROOM_ID_REJECTED');
        roomPage=await context.newPage();
        const r=await inspectPublicPage(roomPage,roomUrl,'room',{holdMs});
        if(isRpaAccessBlocked(r)){
          report.observations.push({...UNKNOWN(target.key,checkedAt,'ROOM_ACCESS_BLOCKED_OR_CHALLENGED',p.httpStatus,r.httpStatus),
            profileIdentityVerified:pid,profileDomDiagnostics:p.domDiagnostics??null,profileDomGap:p.domGap??null});
          report.stoppedForChallenge=true;break;
        }
        const d=decideDouyin(p,r,{...target,roomId:target.configuredRoomId},{offlineRuleValidated:false});
        report.observations.push({accountKey:target.key,checkedAt:clock(),
          publicSource:'PUBLIC_GUEST_RPA',state:d.state==='LIVE'?'LIVE':'UNKNOWN',
          reason:d.reason,profileHttp:p.httpStatus,roomHttp:r.httpStatus,
          profileIdentityVerified:d.profileIdentityVerified===true,
          roomIdentityVerified:d.roomPageIdentityVerified===true,
          observedRoomId:d.observedRoomId||null,roomIdChanged:d.roomIdChanged===true,
          offlineCandidate:false,opsBridgeVerified:false,exactStartAt:null,exactEndAt:null,
          profileDomDiagnostics:p.domDiagnostics??null,profileDomGap:p.domGap??null});
      }catch{
        report.observations.push(UNKNOWN(target.key,checkedAt,'RPA_NAVIGATION_OR_RUNTIME_FAILURE'));
        report.stoppedForChallenge=true;break;
      }finally{
        if(roomPage)await roomPage.close().catch(()=>{});
        if(profilePage)await profilePage.close().catch(()=>{});
      }
    }
    report.sourceAccess=report.stoppedForChallenge?'ACCESS_RESTRICTED_OR_RUNTIME_STOP':'PUBLIC_READ_COMPLETE';
  }catch{
    report.sourceAccess='BROWSER_UNAVAILABLE';
    report.stoppedForChallenge=true;
  }finally{
    if(context)await context.close().catch(()=>{});
    if(browser)await browser.close().catch(()=>{});
  }
  return report; // no raw DOM, screenshots, auth state, cookies or secret fields
}
