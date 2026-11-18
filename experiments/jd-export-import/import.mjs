// Local historical staging only. No network or production state integration.
import {createHash} from 'node:crypto';
export const LIMITS=Object.freeze({bytes:2*1024*1024,files:4,rows:10000,columns:64,cell:1024});
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw Error(code)};
export function parseCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>LIMITS.bytes)fail('CSV_SIZE_LIMIT');
 if(text.startsWith('\uFEFF'))text=text.slice(1);
 if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/.test(text))fail('CSV_INVALID_TEXT');
 const rows=[];let row=[],cell='',quoted=false,closed=false;
 const pushCell=()=>{if(cell.length>LIMITS.cell)fail('CSV_CELL_LIMIT');row.push(cell);if(row.length>LIMITS.columns)fail('CSV_COLUMN_LIMIT');cell='';closed=false;};
 const pushRow=()=>{pushCell();rows.push(row);row=[];if(rows.length>LIMITS.rows+1)fail('CSV_ROW_LIMIT');};
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;}
  else if(ch==='"'){if(cell||closed)fail('CSV_QUOTE_INVALID');quoted=true;}
  else if(ch===',')pushCell();
  else if(ch==='\r'||ch==='\n'){if(ch==='\r'){if(text[i+1]!=='\n')fail('CSV_NEWLINE_INVALID');i++;}pushRow();}
  else {if(closed)fail('CSV_QUOTE_INVALID');cell+=ch;}
  if(cell.length>LIMITS.cell)fail('CSV_CELL_LIMIT');
 }
 if(quoted)fail('CSV_QUOTE_INVALID');
 if(cell||closed||row.length)pushRow();
 if(rows.length===0)fail('CSV_EMPTY');
 return rows;
}
// Explicit numeric timezone required; never infer locale, Excel serial dates or machine zone.
export function parseInstant(value){
 const m=typeof value==='string'&&/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{3}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
 if(!m)return null;
 const [y,mo,d,h,mi,s,ms]=[m[1],m[2],m[3],m[4],m[5],m[6],m[7]||'0'].map(Number);
 if(y<1000||mo<1||mo>12||h>23||mi>59||s>59)return null;
 const utc=Date.UTC(y,mo-1,d,h,mi,s,ms),check=new Date(utc);
 if(check.getUTCFullYear()!==y||check.getUTCMonth()!==mo-1||check.getUTCDate()!==d)return null;
 let offset=0;
 if(m[8]!=='Z'){const oh=Number(m[8].slice(1,3)),om=Number(m[8].slice(4));if(oh>14||om>59||(oh===14&&om!==0))return null;offset=(oh*60+om)*60000*(m[8][0]==='+'?1:-1);}
 return utc-offset;
}
const fields=['accountId','sessionId','startedAt','endedAt','sourceId'];
export function previewExports({files,mapping,now}={}){
 const nowMs=parseInstant(now),exportMs=parseInstant(mapping?.exportedAt);
 if(nowMs===null||exportMs===null||exportMs>nowMs)fail('EXPORT_CLOCK_INVALID');
 if(!mapping||mapping.schemaVersion!==1||mapping.sourceType!=='JD_MERCHANT_EXPORT_UNVERIFIED'||!['synthetic','user-provided-unverified'].includes(mapping.evidenceKind))fail('MAPPING_INVALID');
 if(!mapping.columns||fields.some(k=>typeof mapping.columns[k]!=='string'||!mapping.columns[k]||mapping.columns[k].length>128)||new Set(fields.map(k=>mapping.columns[k])).size!==fields.length)fail('MAPPING_COLUMNS_INVALID');
 if(!Array.isArray(files)||files.length<1||files.length>LIMITS.files||!Array.isArray(mapping.bindings??[])||(mapping.bindings??[]).length>1000)fail('INPUT_LIMIT_OR_SCHEMA');
 const records=[],quarantinedRecords=[],errors=[],duplicates=[],fileSummaries=[],groups=new Map();
 for(const [fileIndex,file] of files.entries()){
  let rows,digest;
  try{
   if(file?.format!=='csv')fail('FORMAT_UNSUPPORTED');
   rows=parseCsv(file.text);digest=file.sourceFormat==='xlsx'&&/^[a-f0-9]{64}$/.test(file.sourceSha256??'')?file.sourceSha256:hash(file.text);
   const headers=rows[0];
   if(new Set(headers).size!==headers.length||headers.some(h=>!h||/^[\s]*[=+@-]/.test(h)))fail('CSV_HEADER_INVALID');
   if(fields.some(k=>!headers.includes(mapping.columns[k])))fail('MAPPED_COLUMN_MISSING');
  }catch(e){errors.push({fileIndex,row:null,code:['FORMAT_UNSUPPORTED','CSV_SIZE_LIMIT','CSV_INVALID_TEXT','CSV_CELL_LIMIT','CSV_COLUMN_LIMIT','CSV_ROW_LIMIT','CSV_QUOTE_INVALID','CSV_NEWLINE_INVALID','CSV_EMPTY','CSV_HEADER_INVALID','MAPPED_COLUMN_MISSING'].includes(e.message)?e.message:'CSV_INVALID'});continue;}
  fileSummaries.push({fileIndex,sha256:digest,rowCount:rows.length-1,sourceFormat:file.sourceFormat==='xlsx'?'xlsx':'csv',sourceSheet:file.sourceFormat==='xlsx'?file.sourceSheet:null,parsedSha256:hash(file.text),parserVersion:'bounded-text-v1'});
  const indexes=Object.fromEntries(fields.map(k=>[k,rows[0].indexOf(mapping.columns[k])]));
  for(let n=1;n<rows.length;n++){
   const cells=rows[n],ref={fileIndex,row:n+1};let code=null;
   if(cells.length!==rows[0].length)code='CSV_ROW_WIDTH';
   else if(cells.some(c=>/^[\s]*[=+@-]/.test(c)))code='FORMULA_LIKE_CELL_REJECTED';
   const r=Object.fromEntries(fields.map(k=>[k,cells[indexes[k]]]));
   const start=parseInstant(r.startedAt),end=r.endedAt===''?null:parseInstant(r.endedAt);
   if(!code&&![r.accountId,r.sessionId,r.sourceId].every(id))code='IDENTIFIER_INVALID';
   if(!code&&(start===null||(r.endedAt!==''&&end===null)))code='TIME_FORMAT_INVALID';
   if(!code&&(start>exportMs||(end!==null&&(end<start||end>exportMs))))code='TIME_ORDER_INVALID';
   if(code){errors.push({...ref,code});continue;}
   const normalized={accountId:r.accountId,sessionId:r.sessionId,sourceId:r.sourceId,startedAt:new Date(start).toISOString(),endedAt:end===null?null:new Date(end).toISOString()};
   const key=JSON.stringify([r.accountId,r.sessionId]);
   const fingerprint=hash(JSON.stringify(normalized));
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push({ref,normalized,fingerprint,fileSha256:digest});
  }
 }
 for(const group of groups.values()){
  if(new Set(group.map(x=>x.fingerprint)).size>1){for(const x of group){errors.push({...x.ref,code:'SESSION_CONFLICT'});quarantinedRecords.push({...x.normalized,recordHash:x.fingerprint,provenance:[{...x.ref,fileSha256:x.fileSha256}],currentState:'UNKNOWN',historicalOnly:true});}continue;}
  const first=group[0],r=first.normalized;
  const bindings=(mapping.bindings??[]).filter(b=>b?.accountId===r.accountId&&b.sourceId===r.sourceId);
  let identity='UNVERIFIED',internalRoomId=null;
  if(bindings.length>1)identity='CONFLICT';
  else if(bindings.length===1){const b=bindings[0],reviewed=parseInstant(b.reviewedAt),expires=parseInstant(b.expiresAt);
   if(b.reviewed===true&&id(b.internalRoomId)&&id(b.reviewRef)&&reviewed!==null&&expires!==null&&reviewed<=nowMs&&expires>nowMs&&expires>reviewed){identity='REVIEWED_MAPPING_INPUT';internalRoomId=b.internalRoomId;}}
  records.push({...r,internalRoomId,identity,currentState:'UNKNOWN',historicalOnly:true,
   recordCompleteness:r.endedAt===null?'END_TIME_MISSING':'START_AND_END_DECLARED',
   evidenceKind:mapping.evidenceKind,sourceType:mapping.sourceType,exportedAt:new Date(exportMs).toISOString(),
   provenance:group.map(x=>({...x.ref,fileSha256:x.fileSha256})),recordHash:first.fingerprint});
  for(const x of group.slice(1))duplicates.push({...x.ref,code:'EXACT_DUPLICATE',of:first.ref});
 }
 return {schemaVersion:1,mode:'HISTORICAL_IMPORT_PREVIEW',evidenceKind:mapping.evidenceKind,
  realFormatValidated:false,productionWrite:false,currentState:'UNKNOWN',records,quarantinedRecords,errors,duplicates,fileSummaries,
  counts:{historicalRecords:records.length,errorRows:errors.length,duplicates:duplicates.length,unverifiedIdentities:records.filter(r=>r.identity!=='REVIEWED_MAPPING_INPUT').length}};
}
