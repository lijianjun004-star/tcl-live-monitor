import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {previewExports} from '../experiments/jd-export-import/import.mjs';
import {persistPreview,publishNew} from '../experiments/jd-export-import/store.mjs';
const mapping=JSON.parse(fs.readFileSync('experiments/jd-export-import/fixtures/FICTIONAL-mapping.json'));
const header=Object.values(mapping.columns).join(',')+'\n';
const row='001,0009,2026-11-16T10:00:00+08:00,2026-11-16T11:00:00+08:00,SYNTHETIC_EXPORT\n';
const preview=(text=header+row)=>previewExports({files:[{format:'csv',text}],mapping,now:'2026-11-18T00:00:00Z'});
function sandbox(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jd-durable-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const save=(directory,text=header+row,extra={})=>persistPreview({directory,preview:preview(text),mapping,...extra});

test('persistent import is idempotent across separate calls and preserves leading-zero IDs',t=>{
 const dir=sandbox(t),a=save(dir,undefined,{initialize:true}),b=save(dir);
 assert.equal(a.revision,1);assert.equal(b.revision,1);assert.equal(b.records.length,1);assert.equal(b.records[0].sessionId,'0009');assert.equal(b.records[0].currentState,'UNKNOWN');
});
test('cross-batch revisions quarantine every variant independent of arrival order',t=>{
 for(const reverse of [false,true]){
  const dir=sandbox(t),changed=row.replace('11:00','12:00');
  save(dir,header+(reverse?changed:row),{initialize:true});
  const b=save(dir,header+(reverse?row:changed));assert.equal(b.records.length,0);assert.equal(b.conflicts.length,1);assert.equal(b.conflicts[0].variants.length,2);
  assert.equal(save(dir).conflicts.length,1);
 }
});
test('within-batch conflict is retained and later good copy cannot silently resolve it',t=>{
 const dir=sandbox(t);save(dir,header+row+row.replace('11:00','12:00'),{initialize:true});
 const b=save(dir);assert.equal(b.records.length,0);assert.equal(b.conflicts.length,1);
});
test('explicit missing, corrupt and tampered history cannot initialize or overwrite',t=>{
 const dir=sandbox(t);assert.throws(()=>save(dir));save(dir,undefined,{initialize:true});
 const file=path.join(dir,'history.json');fs.writeFileSync(file,'{"private":"SYNTHETIC"}');
 assert.throws(()=>save(dir),/JD_EXPORT_STORE_BLOCKED/);assert.equal(fs.readFileSync(file,'utf8'),'{"private":"SYNTHETIC"}');assert.throws(()=>save(dir,undefined,{initialize:true}));
});
test('failure before/after atomic commit leaves a durable review lock and coherent snapshot',t=>{
 for(const stage of ['before-commit','after-commit']){
  const dir=sandbox(t);save(dir,undefined,{initialize:true});
  assert.throws(()=>save(dir,header+row.replace('0009','0010'),{fault:point=>{if(point===stage)throw Error('SYNTHETIC_CRASH');}}),/SYNTHETIC_CRASH/);
  const s=JSON.parse(fs.readFileSync(path.join(dir,'history.json')));assert.equal(s.revision,stage==='before-commit'?1:2);
  assert.ok(fs.existsSync(path.join(dir,'.import-lock')));assert.throws(()=>save(dir));
 }
});
test('actual killed writer retains lock and competing process cannot publish',async t=>{
 const dir=sandbox(t),module=pathToFileURL(path.resolve('experiments/jd-export-import/store.mjs')).href;
 save(dir,undefined,{initialize:true});
 const code=`import {persistPreview} from ${JSON.stringify(module)};persistPreview({directory:${JSON.stringify(dir)},preview:${JSON.stringify(preview(header+row.replace('0009','0010')))},mapping:${JSON.stringify(mapping)},fault:p=>{if(p==='before-commit'){process.stdout.write('READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.on('exit',resolve));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child not ready')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
 try { assert.throws(()=>save(dir)); } finally {child.kill('SIGKILL');await exited;}
 assert.throws(()=>save(dir));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'history.json'))).revision,1);
});
test('published preview is complete and duplicate publication cannot replace it',t=>{
 const dir=sandbox(t),file=path.join(dir,'preview.json');publishNew(file,{a:'synthetic'});assert.throws(()=>publishNew(file,{a:'changed'}));assert.deepEqual(JSON.parse(fs.readFileSync(file)),{a:'synthetic'});
});

const python=process.platform==='win32'?'python':'python3';
const pythonOk=spawnSync(python,['--version']).status===0;
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const cells=values=>values.map((v,i)=>`<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${v}</t></is></c>`).join('');
function parts(){
 return {
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="SYNTHETIC" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><sheetData><row r="1">${cells(Object.values(mapping.columns))}</row><row r="2">${cells(row.trim().split(',')).replaceAll(/([A-E])1/g,'$12')}</row></sheetData></worksheet>`
 };
}
function zip(entries){
 const script='import sys,json,zipfile,io\np=json.load(sys.stdin);b=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:\n for k,v in p.items(): z.writestr(k,v)\nsys.stdout.buffer.write(b.getvalue())';
 const r=spawnSync(python,['-c',script],{input:JSON.stringify(entries),maxBuffer:12*1024*1024});assert.equal(r.status,0,r.stderr.toString());return r.stdout;
}
function parse(bytes,sheet='SYNTHETIC'){return spawnSync(python,['experiments/jd-export-import/xlsx-reader.py',sheet],{input:bytes,maxBuffer:12*1024*1024});}
test('bounded XLSX explicit text preserves IDs and timezone; CLI keeps original file hash',{skip:!pythonOk&&'NOT RUN: Python 3 unavailable'},t=>{
 const dir=sandbox(t),bytes=zip(parts());const p=parse(bytes);assert.equal(p.status,0,p.stderr.toString());const rows=JSON.parse(p.stdout);assert.equal(rows[1][0],'001');
 fs.writeFileSync(path.join(dir,'input.xlsx'),bytes);fs.writeFileSync(path.join(dir,'mapping.json'),JSON.stringify(mapping));
 const r=spawnSync(process.execPath,['experiments/jd-export-import/cli.mjs','--input',path.join(dir,'input.xlsx'),'--mapping',path.join(dir,'mapping.json'),'--sheet','SYNTHETIC','--output',path.join(dir,'preview.json')],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const result=JSON.parse(fs.readFileSync(path.join(dir,'preview.json')));assert.equal(result.records[0].accountId,'001');assert.equal(result.fileSummaries[0].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.realFormatValidated,false);
});
test('XLSX numeric IDs/dates, formulas including caches, hidden rows/sheets, DTD and external relationships reject',{skip:!pythonOk&&'NOT RUN: Python 3 unavailable'},()=>{
 const variants=[
  p=>p['xl/worksheets/sheet1.xml']=p['xl/worksheets/sheet1.xml'].replace('<c r="A2" t="inlineStr"><is><t>001</t></is></c>','<c r="A2"><v>1</v></c>'),
  p=>p['xl/worksheets/sheet1.xml']=p['xl/worksheets/sheet1.xml'].replace('<is><t>001</t></is>','<f>1+1</f><v>2</v>'),
  p=>p['xl/worksheets/sheet1.xml']=p['xl/worksheets/sheet1.xml'].replace('<row r="2">','<row r="2" hidden="1">'),
  p=>p['xl/workbook.xml']=p['xl/workbook.xml'].replace('sheetId="1"','sheetId="1" state="hidden"'),
  p=>p['xl/workbook.xml']='<!DOCTYPE x [<!ENTITY secret "SYNTHETIC">]>'+p['xl/workbook.xml'],
  p=>p['xl/_rels/workbook.xml.rels']=p['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/sheet1.xml"','Target="https://synthetic.invalid" TargetMode="External"'),
  p=>p['xl/vbaProject.bin']='SYNTHETIC_MACRO',
  p=>p['../escape.xml']='<x/>',
  p=>p['xl/worksheets/sheet1.xml']='A'.repeat(1024*1024)
 ];
 for(const mutate of variants){const p=parts();mutate(p);const r=parse(zip(p));assert.equal(r.status,1);assert.equal(r.stderr.toString().trim(),'XLSX_REQUIRES_REVIEW');}
 assert.equal(parse(zip(parts()),'WRONG_SHEET').status,1);
});
