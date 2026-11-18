// Local single-writer history adapter. State is authoritative; summary is a verified cache.
// Requires a trusted local directory, not an attacker-writable directory or network filesystem.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const MAX_BYTES=12*1024*1024;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function historyData(state){const data=structuredClone(state);if(data)delete data._historyCommit;return data;}
export function validateHistoryCommit(state){
  if(!state?._historyCommit)return state; // Explicitly supported legacy state; no pair integrity claim.
  const c=state._historyCommit;
  if(c.version!==1||typeof c.id!=='string'||!/^[-a-f0-9]{36}$/.test(c.id)||
    c.stateSha256!==digest(historyData(state))||c.summarySha256!==digest(c.summary)||c.summary?._historyCommitId!==c.id)
    throw Error('HISTORY_COMMIT_INVALID');
  return state;
}
export function verifyHistoryPair(state,summary){
  validateHistoryCommit(state);
  if(state?._historyCommit||summary?._historyCommitId){
    if(!state?._historyCommit||summary?._historyCommitId!==state._historyCommit.id||digest(summary)!==state._historyCommit.summarySha256)
      throw Error('HISTORY_PAIR_MISMATCH');
  }
  return {state,summary};
}
function directoryIdentity(directory){
  const resolved=path.resolve(directory),root=path.parse(resolved).root;
  let current=root;
  for(const part of resolved.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const st=fs.lstatSync(current);
    if(st.isSymbolicLink()||!st.isDirectory())throw Error('HISTORY_DIRECTORY_UNSAFE');
  }
  const st=fs.statSync(resolved);
  return {real:fs.realpathSync(resolved),dev:st.dev,ino:st.ino};
}
function sameDirectory(directory,expected){
  const actual=directoryIdentity(directory);
  if(actual.real!==expected.real||actual.dev!==expected.dev||actual.ino!==expected.ino)throw Error('HISTORY_DIRECTORY_CHANGED');
}
export function readHistoryJson(file,{required=true}={}){
  if(!file)return null;
  let fd;
  try{
    directoryIdentity(path.dirname(path.resolve(file)));
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_BYTES)throw Error('UNSAFE_INPUT');
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const opened=fs.fstatSync(fd);
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>MAX_BYTES)throw Error('INPUT_CHANGED');
    const buffer=Buffer.alloc(MAX_BYTES+1);let length=0,count;
    do{count=fs.readSync(fd,buffer,length,buffer.length-length,null);length+=count;}while(count&&length<buffer.length);
    if(length>MAX_BYTES)throw Error('UNSAFE_INPUT');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));
  }catch(error){if(error.code==='ENOENT'&&!required)return null;throw Error('HISTORY_INPUT_UNAVAILABLE');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function outputExists(file){
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink>1)throw Error('HISTORY_OUTPUT_UNSAFE');return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
function durableFile(file,value){
  const bytes=JSON.stringify(value,null,2)+'\n';
  if(Buffer.byteLength(bytes)>MAX_BYTES)throw Error('HISTORY_OUTPUT_TOO_LARGE');
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);return fs.fstatSync(fd);}finally{fs.closeSync(fd);}
}
function syncDirectory(directory){
  // Windows does not expose POSIX directory fsync in Node. File flush is still requested.
  if(process.platform==='win32')return;
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export async function withHistoryTransaction({stateOutput,summaryOutput,previous},build,{checkpoint=()=>{}}={}){
  const stateFile=path.resolve(stateOutput),summaryFile=path.resolve(summaryOutput),directory=path.dirname(stateFile);
  const comparable=x=>process.platform==='win32'?x.toLowerCase():x;
  if(comparable(stateFile)===comparable(summaryFile)||comparable(directory)!==comparable(path.dirname(summaryFile)))throw Error('HISTORY_OUTPUT_LAYOUT');
  // Inspect existing ancestors before mkdir and again afterwards. Hostile concurrent directory swaps
  // are outside the trusted-directory contract; detected identity changes fail closed.
  let ancestor=directory;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  directoryIdentity(ancestor);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const identity=directoryIdentity(directory),lock=stateFile+'.lock',directoryLock=path.join(directory,'.jd-history.lock'),id=randomUUID();
  const lockRecord={version:1,id,reason:'WRITE_IN_PROGRESS_OR_INTERRUPTED'};
  let lockFd,directoryLockIdentity,stateLockIdentity;
  const checkLock=(file,expected)=>{
    try{
      const actual=fs.lstatSync(file);
      if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1||actual.dev!==expected.dev||actual.ino!==expected.ino||
        digest(readHistoryJson(file))!==digest(lockRecord))throw Error('CHANGED');
    }catch{throw Error('HISTORY_LOCK_OWNERSHIP_CHANGED');}
  };
  const checkOwnedLocks=()=>{sameDirectory(directory,identity);checkLock(directoryLock,directoryLockIdentity);checkLock(lock,stateLockIdentity);};
  // Directory-wide exclusion also covers two differently named states sharing one summary path.
  try{directoryLockIdentity=durableFile(directoryLock,lockRecord);}catch{throw Error('HISTORY_LOCK_REQUIRES_REVIEW');}
  try{lockFd=fs.openSync(lock,'wx',0o600);stateLockIdentity=fs.fstatSync(lockFd);}
  catch{
    // If creation succeeded but descriptor inspection failed, retain both locks for review.
    if(lockFd!==undefined){fs.closeSync(lockFd);throw Error('HISTORY_LOCK_REQUIRES_REVIEW');}
    sameDirectory(directory,identity);checkLock(directoryLock,directoryLockIdentity);fs.unlinkSync(directoryLock);throw Error('HISTORY_LOCK_REQUIRES_REVIEW');
  }
  let publishing=false,complete=false;
  const stateTemp=stateFile+'.'+id+'.tmp',summaryTemp=summaryFile+'.'+id+'.tmp';
  try{
    fs.writeFileSync(lockFd,JSON.stringify(lockRecord)+'\n');fs.fsyncSync(lockFd);fs.closeSync(lockFd);lockFd=undefined;
    syncDirectory(directory);
    await checkpoint('locked');
    checkOwnedLocks();
    const stateExists=outputExists(stateFile),summaryExists=outputExists(summaryFile);
    const saved=previous?readHistoryJson(previous):null;
    if(previous&&(!saved||typeof saved!=='object'||Array.isArray(saved)))throw Error('HISTORY_INPUT_UNAVAILABLE');
    if(saved)validateHistoryCommit(saved);
    if(stateExists){
      const current=readHistoryJson(stateFile);validateHistoryCommit(current);
      if(!saved||digest(current)!==digest(saved))throw Error('HISTORY_STALE_PREVIOUS');
      if(current._historyCommit){if(!summaryExists)throw Error('HISTORY_PAIR_MISMATCH');verifyHistoryPair(current,readHistoryJson(summaryFile));}
    }else if(summaryExists)throw Error('HISTORY_ORPHAN_SUMMARY');
    const result=await build(historyData(saved));
    const summary={...result.summary,_historyCommitId:id};
    const state=historyData(result.state);
    state._historyCommit={version:1,id,stateSha256:digest(state),summarySha256:digest(summary),summary};
    validateHistoryCommit(state);
    durableFile(stateTemp,state);durableFile(summaryTemp,summary);
    await checkpoint('prepared');
    checkOwnedLocks();outputExists(stateFile);outputExists(summaryFile);
    publishing=true;
    // One authoritative publish; no claim that the following two renames form a transaction.
    fs.renameSync(stateTemp,stateFile);syncDirectory(directory);
    await checkpoint('state-published');
    checkOwnedLocks();
    fs.renameSync(summaryTemp,summaryFile);syncDirectory(directory);
    await checkpoint('summary-published');
    checkOwnedLocks();
    verifyHistoryPair(readHistoryJson(stateFile),readHistoryJson(summaryFile));
    complete=true;
    return {...result,state,summary};
  }finally{
    if(lockFd!==undefined)fs.closeSync(lockFd);
    checkOwnedLocks();
    for(const file of [stateTemp,summaryTemp])try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    // A partial publish, crash, or cancellation MUST leave the lock for explicit recovery review.
    if(!publishing||complete){checkOwnedLocks();fs.unlinkSync(lock);checkLock(directoryLock,directoryLockIdentity);fs.unlinkSync(directoryLock);syncDirectory(directory);}
  }
}
