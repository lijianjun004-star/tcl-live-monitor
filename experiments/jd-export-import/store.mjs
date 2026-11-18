// Local private historical staging. A stale lock is a review gate, never a TTL unlock.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {parseInstant} from './import.mjs';
const fail = () => { throw Error('JD_EXPORT_STORE_BLOCKED'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const normal = r => ({accountId:r.accountId,sessionId:r.sessionId,sourceId:r.sourceId,startedAt:r.startedAt,endedAt:r.endedAt});
const MAX_STATE = 32 * 1024 * 1024;
const ERROR_CODES=new Set(['FORMAT_UNSUPPORTED','CSV_SIZE_LIMIT','CSV_INVALID_TEXT','CSV_CELL_LIMIT','CSV_COLUMN_LIMIT','CSV_ROW_LIMIT','CSV_QUOTE_INVALID','CSV_NEWLINE_INVALID','CSV_EMPTY','CSV_HEADER_INVALID','MAPPED_COLUMN_MISSING','CSV_INVALID','CSV_ROW_WIDTH','FORMULA_LIKE_CELL_REJECTED','IDENTIFIER_INVALID','TIME_FORMAT_INVALID','TIME_ORDER_INVALID','SESSION_CONFLICT']);
function cleanErrors(errors) {
  if(!Array.isArray(errors)||errors.length>40004) fail();
  return errors.map(e=>{if(!e||!ERROR_CODES.has(e.code)||!Number.isInteger(e.fileIndex)||e.fileIndex<0||e.fileIndex>3||(e.row!==null&&(!Number.isInteger(e.row)||e.row<2||e.row>10001)))fail();return {fileIndex:e.fileIndex,row:e.row,code:e.code};});
}
function cleanFiles(files) {
  if(!Array.isArray(files)||files.length<1||files.length>4||new Set(files.map(f=>f?.fileIndex)).size!==files.length)fail();
  return files.map(f=>{
    if(!f||!Number.isInteger(f.fileIndex)||f.fileIndex<0||f.fileIndex>3||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isInteger(f.rowCount)||f.rowCount<0||f.rowCount>10000||!['csv','xlsx'].includes(f.sourceFormat)||f.parserVersion!=='bounded-text-v1'||typeof f.parsedSha256!=='string'||!/^[a-f0-9]{64}$/.test(f.parsedSha256)||(f.sourceFormat==='csv'?f.sourceSheet!==null:typeof f.sourceSheet!=='string'||!f.sourceSheet||f.sourceSheet.length>128)) fail();
    return {fileIndex:f.fileIndex,sha256:f.sha256,rowCount:f.rowCount,sourceFormat:f.sourceFormat,sourceSheet:f.sourceSheet,parsedSha256:f.parsedSha256,parserVersion:f.parserVersion};
  });
}

export function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  const st = fs.lstatSync(absolute);
  const real = fs.realpathSync(absolute);
  const same = process.platform === 'win32' ? real.toLowerCase() === absolute.toLowerCase() : real === absolute;
  if (!st.isDirectory() || st.isSymbolicLink() || !same) fail();
  if (process.platform !== 'win32' && (st.mode & 0o077)) fail();
  return absolute;
}

export function readBytes(file, limit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > limit) fail();
    const buffer = Buffer.alloc(limit + 1); let size = 0, n;
    while (size < buffer.length && (n = fs.readSync(fd,buffer,size,buffer.length-size,null)) > 0) size += n;
    if (size > limit) fail();
    return buffer.subarray(0,size);
  } finally { fs.closeSync(fd); }
}

export function syncDirectory(dir) {
  if (process.platform === 'win32') return; // No Windows power-loss guarantee claimed.
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function publishNew(output, result) {
  const dir = privateDirectory(path.dirname(path.resolve(output)));
  const temp = path.join(dir, '.jd-preview-' + randomUUID());
  const fd = fs.openSync(temp,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(result,null,2)+'\n'); fs.fsyncSync(fd); }
  catch (e) { fs.closeSync(fd); fs.unlinkSync(temp); throw e; }
  fs.closeSync(fd);
  try { fs.linkSync(temp,path.resolve(output)); syncDirectory(dir); }
  finally { fs.unlinkSync(temp); }
}

function validateEntry(r) {
  if (!r || ![r.accountId,r.sessionId,r.sourceId].every(identifier) || r.currentState !== 'UNKNOWN' || r.historicalOnly !== true) fail();
  const start=parseInstant(r.startedAt),end=r.endedAt===null?null:parseInstant(r.endedAt);
  if (start===null || (r.endedAt!==null && (end===null || end<start)) || r.recordHash!==digest(normal(r))) fail();
  if(r.startedAt!==new Date(start).toISOString() || (end!==null && r.endedAt!==new Date(end).toISOString())) fail();
  if (!Array.isArray(r.provenance) || !r.provenance.length || r.provenance.length>40000) fail();
  for (const p of r.provenance) if (!p || typeof p.fileSha256!=='string' || !/^[a-f0-9]{64}$/.test(p.fileSha256) || !Number.isInteger(p.fileIndex) || p.fileIndex<0 || p.fileIndex>3 || !Number.isInteger(p.row) || p.row<2 || p.row>10001) fail();
}

function cleanEntry(r) {
  validateEntry(r);
  return {...normal(r),recordHash:r.recordHash,provenance:r.provenance.map(p=>({fileIndex:p.fileIndex,row:p.row,fileSha256:p.fileSha256})),currentState:'UNKNOWN',historicalOnly:true};
}

export function projectBatches(batches) {
  const groups=new Map();
  for (const batch of batches) for (const r of batch.rows) {
    const key=JSON.stringify([r.accountId,r.sessionId]);
    if (!groups.has(key)) groups.set(key,new Map());
    const variants=groups.get(key);
    if (!variants.has(r.recordHash)) variants.set(r.recordHash,{...normal(r),recordHash:r.recordHash,provenance:[],identity:'UNVERIFIED',internalRoomId:null,currentState:'UNKNOWN',historicalOnly:true});
    const item=variants.get(r.recordHash);
    for (const p of r.provenance) item.provenance.push({...p,batchId:batch.batchId});
  }
  const records=[],conflicts=[];
  for (const variants of groups.values()) {
    if (variants.size===1) records.push([...variants.values()][0]);
    else conflicts.push({code:'SESSION_REVISION_CONFLICT',variants:[...variants.values()]});
  }
  return {records,conflicts,counts:{historicalRecords:records.length,conflictingSessions:conflicts.length,batches:batches.length,errorRows:batches.reduce((sum,b)=>sum+b.errors.length,0)},realFormatValidated:false,productionWrite:false,currentState:'UNKNOWN'};
}

function load(file) {
  let state;
  try { state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBytes(file,MAX_STATE))); } catch { fail(); }
  if (state?.schemaVersion!==1 || state.mode!=='HISTORICAL_IMPORT_STORE' || !Number.isInteger(state.revision) || state.revision<0 || !Array.isArray(state.batches) || state.batches.length>200 || state.revision!==state.batches.length) fail();
  const {checksum,...payload}=state;
  if (checksum!==digest(payload)) fail();
  const ids=new Set();
  for (const b of state.batches) {
    if (!b || typeof b.batchId!=='string' || !/^[a-f0-9]{64}$/.test(b.batchId) || ids.has(b.batchId) || !Array.isArray(b.rows) || b.rows.length>40000 || !Array.isArray(b.files) || b.files.length>4 || !['synthetic','user-provided-unverified'].includes(b.evidenceKind) || parseInstant(b.exportedAt)===null) fail();
    ids.add(b.batchId); cleanErrors(b.errors); cleanFiles(b.files);
    const rowCodes=new Set(['CSV_ROW_WIDTH','FORMULA_LIKE_CELL_REJECTED','IDENTIFIER_INVALID','TIME_FORMAT_INVALID','TIME_ORDER_INVALID','SESSION_CONFLICT']);
    for(const e of b.errors){const source=b.files.find(f=>f.fileIndex===e.fileIndex);if(e.row===null?(source||rowCodes.has(e.code)):(!source||!rowCodes.has(e.code)||e.row>source.rowCount+1))fail();}
    for (const r of b.rows) {
      validateEntry(r); if(parseInstant(r.startedAt)>parseInstant(b.exportedAt) || (r.endedAt!==null && parseInstant(r.endedAt)>parseInstant(b.exportedAt))) fail();
      for(const p of r.provenance){const file=b.files.find(f=>f.fileIndex===p.fileIndex);if(!file||file.sha256!==p.fileSha256||p.row>file.rowCount+1)fail();}
    }
  }
  return {schemaVersion:1,mode:'HISTORICAL_IMPORT_STORE',revision:state.revision,batches:state.batches.map(b=>({batchId:b.batchId,files:cleanFiles(b.files),evidenceKind:b.evidenceKind,exportedAt:b.exportedAt,rows:b.rows.map(cleanEntry),errors:cleanErrors(b.errors)}))};
}

export function persistPreview({directory,preview,mapping,initialize=false,fault=()=>{}}) {
  const dir=privateDirectory(directory), file=path.join(dir,'history.json'), lock=path.join(dir,'.import-lock');
  const rootStat=fs.lstatSync(dir);
  fs.mkdirSync(lock,{mode:0o700});
  const lockStat=fs.lstatSync(lock);
  const owner=JSON.stringify({schemaVersion:1,operationId:randomUUID(),createdAt:new Date().toISOString()});
  const assertOwned=()=>{
    try {
    if(privateDirectory(dir)!==dir)fail();
    const a=fs.lstatSync(dir),b=fs.lstatSync(lock);
    if(a.ino!==rootStat.ino||a.dev!==rootStat.dev||b.isSymbolicLink()||!b.isDirectory()||b.ino!==lockStat.ino||b.dev!==lockStat.dev||readBytes(path.join(lock,'owner.json'),1024).toString('utf8')!==owner)fail();
    } catch { fail(); }
  };
  let publishing=false, ownerCreated=false;
  try {
    fs.writeFileSync(path.join(lock,'owner.json'),owner,{flag:'wx',mode:0o600});
    ownerCreated=true; syncDirectory(dir); assertOwned();
    let state;
    if (initialize) {
      if (fs.existsSync(file)) fail();
      state={schemaVersion:1,mode:'HISTORICAL_IMPORT_STORE',revision:0,batches:[]};
    } else state=load(file); // Explicit missing history may not bootstrap.
    const files=cleanFiles(preview.fileSummaries);
    const errors=cleanErrors(preview.errors);
    const rows=[...preview.records,...preview.quarantinedRecords].map(cleanEntry);
    const byIndex=new Map(files.map(f=>[f.fileIndex,f]));
    for(const r of rows) for(const p of r.provenance) {
      const source=byIndex.get(p.fileIndex);
      if(!source || p.fileSha256!==source.sha256 || p.row>source.rowCount+1) fail();
    }
    const rowCodes=new Set(['CSV_ROW_WIDTH','FORMULA_LIKE_CELL_REJECTED','IDENTIFIER_INVALID','TIME_FORMAT_INVALID','TIME_ORDER_INVALID','SESSION_CONFLICT']);
    for(const e of errors) {
      const source=byIndex.get(e.fileIndex);
      if(e.row===null ? (source || rowCodes.has(e.code)) :
        (!source || !rowCodes.has(e.code) || e.row>source.rowCount+1)) fail();
    }
    const batchId=digest({files,rows,errors,mapping:{schemaVersion:mapping.schemaVersion,columns:mapping.columns,exportedAt:mapping.exportedAt,evidenceKind:mapping.evidenceKind}});
    if (!state.batches.some(b=>b.batchId===batchId)) {
      if(state.batches.length>=200) fail();
      state.batches.push({batchId,files,evidenceKind:mapping.evidenceKind,exportedAt:mapping.exportedAt,rows,errors}); state.revision++;
    }
    const result={...state,...projectBatches(state.batches)};
    const saved={...result,checksum:digest(result)};
    const bytes=JSON.stringify(saved,null,2)+'\n';
    if(Buffer.byteLength(bytes)>MAX_STATE) fail();
    const temp=path.join(dir,'.history-'+randomUUID());
    publishing=true; assertOwned();
    const fd=fs.openSync(temp,'wx',0o600);
    try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fault('before-commit');
    assertOwned();
    fs.renameSync(temp,file); syncDirectory(dir);
    fault('after-commit'); assertOwned(); publishing=false;
    return {...saved,batchId,importErrorRows:preview.errors.length};
  } finally {
    // Interrupted publication retains lock, temp and prior/committed snapshot for review.
    if(!publishing && ownerCreated) { assertOwned();fs.unlinkSync(path.join(lock,'owner.json')); fs.rmdirSync(lock); syncDirectory(dir); }
  }
}
