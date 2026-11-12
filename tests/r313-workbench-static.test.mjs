import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const file=new URL('../tools/r313/index.html',import.meta.url);
const html=fs.readFileSync(file,'utf8');

test('workbench script syntax parses as a valid browser module',()=>{
 const code=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
 assert.ok(code?.includes('auditPrivateBridgeCSV'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r313-static-'));
 try{
   const temp=path.join(dir,'screen.mjs');
   fs.writeFileSync(temp,code);
   execFileSync(process.execPath,['--check',temp],{timeout:10000});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('workbench imports only local source-controlled review library',()=>{
 const spec=html.match(/from '([^']+private-bridge-review\.mjs)'/)?.[1];
 assert.equal(spec,'../../probes/r313/private-bridge-review.mjs');
 const local=path.resolve(path.dirname(new URL(file).pathname),spec);
 assert.equal(fs.existsSync(local),true);
});
test('browser includes no network request or tracking APIs',()=>{
 const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]||'';
 assert.doesNotMatch(script,/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\s*\(|\blocalStorage\b|\bindexedDB\b/);
 assert.doesNotMatch(html,/<script[^>]+src=|<iframe|<img[^>]+src=|<link[^>]+href=/i);
 assert.match(html,/connect-src 'none'/);
 assert.match(html,/form-action 'none'/);
});
test('private exports require explicit user action and prior audit',()=>{
 const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]||'';
 assert.match(script,/\$\('export-csv'\)\.addEventListener\('click'/);
 assert.match(script,/\$\('export-safe'\)\.addEventListener\('click'/);
 assert.match(script,/if\(stateReady\)save\(/);
 assert.match(script,/\$\('export-csv'\)\.disabled=true;\$\('export-safe'\)\.disabled=true;/);
});
test('private inputs cannot become public report from a DOM string interpolation',()=>{
 const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]||'';
 assert.match(script,/textContent/);
 assert.doesNotMatch(script,/\binnerHTML\s*=/);
 assert.match(script,/publicBridgePreflightSummary\(store\.report\)/);
});
