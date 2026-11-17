import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {parseCsv,parseInstant,previewExports,LIMITS} from '../experiments/jd-export-import/import.mjs';
const folder='experiments/jd-export-import/fixtures/';
const mapping=JSON.parse(fs.readFileSync(folder+'FICTIONAL-mapping.json'));
const csv=fs.readFileSync(folder+'FICTIONAL-export.csv','utf8');
const now='2026-11-17T10:00:00.000Z';
const preview=(text=csv,m=mapping)=>previewExports({files:[{format:'csv',text}],mapping:m,now});
const header='fictional_account,fictional_session,fictional_start,fictional_end,fictional_source\n';
const line='001,0009,2026-11-16T10:00:00+08:00,2026-11-16T11:00:00+08:00,SYNTHETIC_EXPORT\n';
test('fictional sample imports history only with duplicate and incomplete end preview',()=>{
 const r=preview();assert.equal(r.realFormatValidated,false);assert.equal(r.records.length,2);assert.equal(r.duplicates.length,1);
 assert.ok(r.records.every(x=>x.currentState==='UNKNOWN'&&x.historicalOnly&&x.identity==='UNVERIFIED'&&x.evidenceKind==='synthetic'));
 assert.equal(r.records[1].recordCompleteness,'END_TIME_MISSING');assert.equal(r.productionWrite,false);
});
test('CSV handles BOM, CRLF, quoting, escaped quote and embedded newline',()=>{
 assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x,y","z""q\nend"\r\n'),[['a','b'],['x,y','z"q\nend']]);
 for(const bad of ['a\n"unterminated','a\n"b"x','a\nb"x','a\rb','a\n\u0000'])assert.throws(()=>parseCsv(bad));
});
test('CSV size, rows, columns and cell limits are enforced',()=>{
 for(const text of ['a'.repeat(LIMITS.bytes+1),'a\n'.repeat(LIMITS.rows+2),Array(65).fill('a').join(','),'a'.repeat(LIMITS.cell+1)])assert.throws(()=>parseCsv(text));
});
test('identifiers preserve leading zeros and explicit timezone normalizes to UTC',()=>{
 const r=preview(header+line).records[0];assert.equal(r.accountId,'001');assert.equal(r.sessionId,'0009');assert.equal(r.startedAt,'2026-11-16T02:00:00.000Z');
});
test('duplicate exports deduplicate across files retaining provenance',()=>{
 const r=previewExports({files:[{format:'csv',text:header+line},{format:'csv',text:header+line}],mapping,now});assert.equal(r.records.length,1);assert.equal(r.duplicates.length,1);assert.equal(r.records[0].provenance.length,2);
});
test('conflicting session time or source quarantines all rows independent of order',()=>{
 for(const changed of [line.replace('11:00','12:00'),line.replace('SYNTHETIC_EXPORT','OTHER_SOURCE')])for(const lines of [line+changed,changed+line]){
  const r=preview(header+lines);assert.equal(r.records.length,0);assert.equal(r.errors.length,2);assert.ok(r.errors.every(x=>x.code==='SESSION_CONFLICT'));
 }
});
test('bad rows do not discard valid history and error preview contains no cell values',()=>{
 const r=preview(header+line+'PRIVATE_MARKER,one\n');assert.equal(r.records.length,1);assert.equal(r.errors[0].code,'CSV_ROW_WIDTH');assert.ok(!JSON.stringify(r.errors).includes('PRIVATE_MARKER'));
});
test('formula-like cells including ignored columns are rejected without execution',()=>{
 for(const value of ['=HYPERLINK("private")','+1','-1','@cmd','  =cmd']){
  const text=header.trim()+',ignored\n'+line.trim()+',"'+value.replaceAll('"','""')+'"\n';const r=preview(text);assert.equal(r.records.length,0);assert.equal(r.errors[0].code,'FORMULA_LIKE_CELL_REJECTED');
 }
});
test('unknown real schema never guesses headers or timezone/date serials',()=>{
 assert.equal(preview('account,session\n1,2\n').errors[0].code,'MAPPED_COLUMN_MISSING');
 assert.equal(preview(header+line.replace('2026-11-16T10:00:00+08:00','46000')).errors[0].code,'TIME_FORMAT_INVALID');
 for(const value of ['2026-02-30T00:00:00Z','2026-11-16 10:00:00','2026-11-16T10:00:00+14:01','2026-11-16T24:00:00Z'])assert.equal(parseInstant(value),null);
});
test('future, reversed and after-export sessions remain errors',()=>{
 for(const text of [line.replace('2026-11-16T10:00','2026-11-18T10:00'),line.replace('11:00','09:00'),line.replace('11:00','15:00')])assert.equal(preview(header+text).errors[0].code,'TIME_ORDER_INVALID');
 assert.throws(()=>preview(csv,{...mapping,exportedAt:'2099-01-01T00:00:00Z'}),/EXPORT_CLOCK_INVALID/);
});
test('mapping and duplicate headers are validated explicitly',()=>{
 assert.throws(()=>preview(csv,{...mapping,columns:{...mapping.columns,sessionId:mapping.columns.accountId}}),/MAPPING_COLUMNS_INVALID/);
 assert.throws(()=>preview(csv,{...mapping,evidenceKind:'real-verified'}),/MAPPING_INVALID/);
 assert.equal(preview('a,a\n1,2').errors[0].code,'CSV_HEADER_INVALID');
});
test('identity assertions require exact account/source and unexpired review; never LIVE',()=>{
 const b={accountId:'001',sourceId:'SYNTHETIC_EXPORT',internalRoomId:'synthetic-room',reviewed:true,reviewRef:'synthetic-review',reviewedAt:'2026-11-16T00:00:00Z',expiresAt:'2026-11-18T00:00:00Z'};
 assert.equal(preview(header+line,{...mapping,bindings:[b]}).records[0].identity,'REVIEWED_MAPPING_INPUT');
 for(const bindings of [[{...b,accountId:'other'}],[{...b,sourceId:'other'}],[{...b,expiresAt:now}],[{...b,reviewed:false}]])assert.equal(preview(header+line,{...mapping,bindings}).records[0].identity,'UNVERIFIED');
 const r=preview(header+line,{...mapping,bindings:[b,b]}).records[0];assert.equal(r.identity,'CONFLICT');assert.equal(r.internalRoomId,null);assert.equal(r.currentState,'UNKNOWN');
});
test('XLSX/ZIP content is not unpacked; valid other file remains isolated',()=>{
 const r=previewExports({files:[{format:'xlsx',text:'PK SYNTHETIC ZIP'},{format:'csv',text:header+line}],mapping,now});assert.equal(r.errors[0].code,'FORMAT_UNSUPPORTED');assert.equal(r.records.length,1);
});
const cli=path.resolve('experiments/jd-export-import/cli.mjs');
function sandbox(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jd-export-'));try{fs.writeFileSync(dir+'/input.csv',csv);fs.writeFileSync(dir+'/mapping.json',JSON.stringify(mapping));fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const invoke=(dir,extra=[])=>spawnSync(process.execPath,[cli,'--input',dir+'/input.csv','--mapping',dir+'/mapping.json','--output',dir+'/preview.json',...extra],{encoding:'utf8'});
test('CLI writes private historical staging, stdout counts only, never overwrites',()=>sandbox(dir=>{
 const r=invoke(dir);assert.equal(r.status,0,r.stderr);assert.ok(!r.stdout.includes('SYNTHETIC_ACCOUNT'));assert.equal(fs.statSync(dir+'/preview.json').mode&0o777,0o600);
 const saved=fs.readFileSync(dir+'/preview.json','utf8');assert.equal(invoke(dir).status,1);assert.equal(fs.readFileSync(dir+'/preview.json','utf8'),saved);
}));
test('CLI rejects symlink, bad UTF8 and XLSX, leaving no staging file',()=>sandbox(dir=>{
 fs.unlinkSync(dir+'/input.csv');fs.writeFileSync(dir+'/actual.csv',csv);fs.symlinkSync(dir+'/actual.csv',dir+'/input.csv');assert.equal(invoke(dir).status,1);fs.unlinkSync(dir+'/input.csv');
 fs.writeFileSync(dir+'/input.csv',Buffer.from([0xff]));assert.equal(invoke(dir).status,1);
 const r=spawnSync(process.execPath,[cli,'--input',dir+'/fake.xlsx','--mapping',dir+'/mapping.json','--output',dir+'/preview.json'],{encoding:'utf8'});assert.equal(r.stderr.trim(),'JD_EXPORT_FORMAT_UNSUPPORTED');assert.equal(fs.existsSync(dir+'/preview.json'),false);
}));
test('CLI partial row failure uses review exit 2 and never prints raw contents',()=>sandbox(dir=>{
 fs.writeFileSync(dir+'/input.csv',header+line+'PRIVATE_SYNTHETIC_MARKER\n');const r=invoke(dir);assert.equal(r.status,2);assert.ok(!r.stdout.includes('PRIVATE_SYNTHETIC_MARKER'));assert.equal(JSON.parse(fs.readFileSync(dir+'/preview.json')).errors[0].row,3);
}));
test('pure preview has no fetch, preserves inputs and ignores extra credentials',()=>{
 const old=globalThis.fetch;globalThis.fetch=()=>assert.fail('network');try{
 const m=Object.freeze({...mapping,token:'PRIVATE_MARKER'});const r=preview(csv,m);assert.ok(!JSON.stringify(r).includes('PRIVATE_MARKER'));
 }finally{globalThis.fetch=old;}
});
