/**
 * R3.10 - Minimal, non-identifying room-page parity metrics.
 * Diagnostic ONLY. Never upgrades a public UNKNOWN to LIVE, never joins OPS IDs.
 */
export function roomIdentityParity(room,target){
  const title=typeof room?.title==='string'?room.title:'';
  const desc=typeof room?.metaDescription==='string'?room.metaDescription:'';
  const body=typeof room?.bodyExcerpt==='string'?room.bodyExcerpt:'';
  const name=typeof target?.accountName==='string'?target.accountName:'';
  const display=typeof target?.displayDouyinId==='string'?target.displayDouyinId:'';
  const expectedTitle=name?name+'的抖音直播间 - 抖音直播':'';
  const expectedDesc=name?'欢迎来到'+name+'的抖音直播间':'';
  const norm=s=>s.replace(/\s+/g,' ').trim();
  return Object.freeze({
    roomHttp200:room?.httpStatus===200,
    roomPageHostVerified:room?.finalHost==='live.douyin.com',
    expectedExactTitle:!!name&&title===expectedTitle,
    expectedNormalizedTitle:!!name&&norm(title)===norm(expectedTitle),
    titleContainsExpectedName:!!name&&title.includes(name),
    titleHasLiveRoomLabel:/(?:抖音直播间|直播间|直播)/.test(title),
    descExpectedPrefix:!!name&&desc.startsWith(expectedDesc),
    descContainsExpectedName:!!name&&desc.includes(name),
    descriptionPresent:desc.length>0,
    roomBodyContainsDisplayId:!!display&&body.includes(display),
    pageTitleLength:Math.min(title.length,240),
    descriptionLength:Math.min(desc.length,240),
    roomTextExcerptLength:Math.min(body.length,700),
  });
}
export function classifyRoomIdentityGap(d){
  if(!d?.roomHttp200)return 'ROOM_ACCESS_NOT_200';
  if(!d?.roomPageHostVerified)return 'ROOM_HOST_NOT_VERIFIED';
  if(d.expectedExactTitle&&d.descExpectedPrefix)return 'STRICT_ROOM_IDENTITY_MATCHED';
  if(!d.titleContainsExpectedName&&!d.descContainsExpectedName)return 'ROOM_ACCOUNT_NAME_MISMATCH_OR_MISSING';
  if(d.titleContainsExpectedName&&!d.descExpectedPrefix)return d.descriptionPresent?'ROOM_DESCRIPTION_PREFIX_CHANGED':'ROOM_DESCRIPTION_MISSING';
  if(!d.expectedExactTitle&&d.descContainsExpectedName)return 'ROOM_TITLE_FORMAT_CHANGED';
  return 'ROOM_IDENTITY_UNRESOLVED';
}
