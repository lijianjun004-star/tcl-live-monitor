// Cooperating local processes only; a stale lock requires review, never automatic stealing.
// Parent directories must remain owned by the operator. This is not a hostile-filesystem sandbox.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const activeLocks=new Map();
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

export function recoveryDirectory(directory) {
 const absolute=path.resolve(directory),root=path.parse(absolute).root;
 let current=root;
 for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
  current=path.join(current,part);
  try{fs.mkdirSync(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const st=fs.lstatSync(current);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('RECOVERY_DIRECTORY_UNSAFE');
 }
 return absolute;
}

export function withRecoveryLock(directory,operation) {
 const dir=recoveryDirectory(directory),lock=path.join(dir,'.recovery-lock');
 try{fs.mkdirSync(lock,{mode:0o700});}catch{throw Error('RECOVERY_LOCKED_REVIEW_REQUIRED');}
 const identity=fs.lstatSync(dir),lockIdentity=fs.lstatSync(lock);
 const ownerFile=path.join(lock,'owner.json'),owner=Buffer.from(JSON.stringify({owner:randomUUID(),pid:process.pid})+'\n');
 const ownerFd=fs.openSync(ownerFile,'wx',0o600);
 try{fs.writeFileSync(ownerFd,owner);fs.fsyncSync(ownerFd);}finally{fs.closeSync(ownerFd);}
 const check=()=>{
  const current=fs.lstatSync(dir);
  if(!current.isDirectory()||current.isSymbolicLink()||!sameFile(current,identity))throw Error('RECOVERY_DIRECTORY_CHANGED');
  try{
   const held=fs.lstatSync(lock);
   if(!held.isDirectory()||held.isSymbolicLink()||!sameFile(held,lockIdentity)||!readBounded(ownerFile,512)?.equals(owner))throw Error('CHANGED');
  }catch{throw Error('RECOVERY_LOCK_CHANGED');}
 };
 activeLocks.set(dir,check);
 try{check();const result=operation(check);check();return result;}
 finally{
  activeLocks.delete(dir);
  // Never delete a replacement lock or an unrecognized owner's metadata.
  check();fs.unlinkSync(ownerFile);
  if(!sameFile(fs.lstatSync(lock),lockIdentity))throw Error('RECOVERY_LOCK_CHANGED');
  fs.rmdirSync(lock);
 }
}

function readBounded(file,maxBytes) {
 try {
  const before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size>maxBytes)throw Error('UNSAFE_FILE');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {
   const actual=fs.fstatSync(fd);
   if(!actual.isFile()||!sameFile(actual,before)||actual.size>maxBytes)throw Error('UNSAFE_FILE');
   const chunks=[];let total=0;
   // At most maxBytes+1 are ever requested, even if a different process grows it.
   while(total<=maxBytes){
    const chunk=Buffer.allocUnsafe(Math.min(64*1024,maxBytes+1-total));
    const n=fs.readSync(fd,chunk,0,chunk.length,null);if(n===0)break;
    total+=n;if(total>maxBytes)throw Error('UNSAFE_FILE');chunks.push(chunk.subarray(0,n));
   }
   const after=fs.fstatSync(fd);
   if(after.size!==actual.size||after.size!==total||after.mtimeMs!==actual.mtimeMs||after.ctimeMs!==actual.ctimeMs)throw Error('FILE_CHANGED_DURING_READ');
   return Buffer.concat(chunks,total);
  }finally{fs.closeSync(fd);}
 }catch(e){if(e.code==='ENOENT')return null;throw Error('UNREADABLE_FILE');}
}
export const readRecoveryFile=file=>readBounded(file,12*1024*1024);

export function removeRecoveryFile(file){
 activeLocks.get(path.resolve(path.dirname(file)))?.();
 fs.rmSync(file,{force:true});
}

export function writeRecoveryFile(file,value,{exclusive=false}={}) {
 const dir=recoveryDirectory(path.dirname(file));
 const check=()=>activeLocks.get(dir)?.();check();
 if(exclusive){
  // A partial/empty blocker is still blocking; never remove it after a failed creation.
  check();const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(process.platform!=='win32'){const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
  return;
 }
 const tmp=path.join(dir,'.recovery-'+randomUUID()+'.tmp');
 let fd;
 try {
  fd=fs.openSync(tmp,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  check();
  fs.renameSync(tmp,file);
  // Linux runner filesystem durability; Windows directory fsync is unavailable.
  if(process.platform!=='win32') {const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
}
