// Offline-only receipt ingestion. Never fetches URLs or launches a browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { importReceipt } from './observation-ledger.mjs';
import { renderLedger } from './render-ledger.mjs';

const args = process.argv.slice(2), opt = {};
const allowed = new Set(['receipt','state','html','platform','evidence-kind']);
try {
  if (args.length % 2) throw new Error('ARGUMENT_PAIRS_REQUIRED');
  for(let i=0;i<args.length;i+=2){
    const key=args[i].replace(/^--/,'');
    if(!args[i].startsWith('--') || !allowed.has(key) || key in opt) throw new Error('INVALID_ARGUMENT');
    opt[key]=args[i+1];
  }
  for(const key of ['receipt','state','html','evidence-kind']) if(!opt[key]) throw new Error('MISSING_'+key);
  if(new Set(['receipt','state','html'].map(k=>path.resolve(opt[k]))).size!==3) throw new Error('PATHS_MUST_DIFFER');
  for(const target of [opt.state,opt.html]) {
    try { if(!(await fs.lstat(target)).isFile()) throw new Error('OUTPUT_MUST_BE_REGULAR_FILE'); }
    catch(e) { if(e.code!=='ENOENT') throw e; }
  }
  for(const target of [opt.state,opt.html]) await fs.mkdir(path.dirname(path.resolve(target)),{recursive:true});
  const identities=[];
  for(const target of [opt.receipt,opt.state,opt.html,opt.state+'.lock']) {
    identities.push(path.join(await fs.realpath(path.dirname(path.resolve(target))),path.basename(target)));
  }
  if(new Set(identities).size!==identities.length) throw new Error('PATH_ALIASES_MUST_DIFFER');
  const lockPath=opt.state+'.lock';
  const lock=await fs.open(lockPath,'wx',0o600);
  // Lets an operator judge a lock left by a crash (no account data in it).
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');
  const temps=[];
  try {
    let previous=null;
    try {previous=JSON.parse(await fs.readFile(opt.state,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const receipt=JSON.parse(await fs.readFile(opt.receipt,'utf8'));
    const ledger=importReceipt(previous,receipt,{platform:opt.platform || 'douyin',evidenceKind:opt['evidence-kind']});
    const html=renderLedger(ledger);
    // Prepare both outputs before replacing the ledger. A malformed input never resets history.
    for(const [target,data] of [[opt.state,JSON.stringify(ledger,null,2)+'\n'],[opt.html,html]]){
      await fs.mkdir(path.dirname(path.resolve(target)),{recursive:true});
      const temp=target+'.'+randomUUID()+'.tmp';temps.push(temp);
      const fh=await fs.open(temp,'wx',0o600);
      try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    }
    await fs.rename(temps[0],opt.state);
    try { await fs.rename(temps[1],opt.html); }
    catch { throw new Error('VIEW_COMMIT_FAILED_LEDGER_SAVED_RETRY_SAME_RECEIPT'); }
    // Make both renames durable (best effort: directory fsync is not supported everywhere).
    for(const d of new Set([opt.state,opt.html].map(t=>path.dirname(path.resolve(t))))) {
      try { const dh=await fs.open(d,'r'); try { await dh.sync(); } finally { await dh.close(); } } catch {}
    }
    console.log(JSON.stringify({status:'IMPORTED_OFFLINE',evidenceKind:ledger.evidenceKind,observations:ledger.observations.length,latestAt:ledger.latestAt}));
  } finally {
    for(const temp of temps) await fs.rm(temp,{force:true});
    await lock.close(); await fs.rm(lockPath,{force:true});
  }
} catch(e) {
  console.error('IMPORT_FAILED: '+(e.code || e.message));
  process.exitCode=1;
}
