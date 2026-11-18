import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stageLegacyHistory} from '../../scripts/r327-legacy-migration.mjs';
import {verifyRestored} from '../../scripts/restore-jd-fullday-state.mjs';
import {beijingDate,report as renderReport,update} from '../../probes/r327/jd-fullday.mjs';
import {verifyHistoryPair} from '../../probes/lib/history-files.mjs';

const repo='lijianjun004-star/tcl-live-monitor';
const workflow='.github/workflows/jd-fullday-rate.yml';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const iso=ms=>new Date(ms).toISOString();
const HOUR=3600000;
const apiRun=(id,created,conclusion,attempt=1)=>({
  id,created_at:iso(created),updated_at:iso(created+120000),head_sha:String(id%10).repeat(40),conclusion,
  run_attempt:attempt,status:'completed',head_branch:'main',path:workflow,event:'schedule',
  repository:{id:42,full_name:repo},head_repository:{id:42,full_name:repo},
});
const runRef=run=>({runId:run.id,runAttempt:run.run_attempt,headSha:run.head_sha});
const python=process.platform==='win32'?'python':'python3';
function makeZip(entries) {
  const script=[
    'import io,json,sys,zipfile',
    'result=io.BytesIO()',
    'with zipfile.ZipFile(result,"w",zipfile.ZIP_DEFLATED) as archive:',
    '  for key,value in json.load(sys.stdin):',
    '    archive.writestr(key,json.dumps(value))',
    'sys.stdout.buffer.write(result.getvalue())',
  ].join('\n');
  const r=spawnSync(python,['-c',script],{input:JSON.stringify(entries),windowsHide:true,maxBuffer:8*1024*1024});
  assert.equal(r.status,0,'synthetic ZIP creation failed');
  return r.stdout;
}

function fixture(t,{alterState,alterReport,alterEntries}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r327-migration-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=Date.now(),run0=apiRun(9101,now-60*HOUR,'success'),run1=apiRun(9102,now-40*HOUR,'failure'),
    run2=apiRun(9103,now-24*HOUR,'cancelled',2);
  const previousAt=iso(Date.parse(run0.created_at)+30000);
  const day=beijingDate(Date.parse(previousAt));
  const state={
    schemaVersion:327,platform:'jd',window:'08:00-24:00 Asia/Shanghai',
    rooms:{'101':{category:'合成',captureBound:true,extra:'SYNTHETIC_DO_NOT_EXPORT'}},
    days:{[day]:{'101':{morning:null,final:null,latest:{at:previousAt,minuteCount:23,latestMinuteAt:previousAt}}}},
    lastRunAt:previousAt,
  };
  alterState?.(state);
  const report={generatedAt:state.lastRunAt,window:state.window,warnings:[],rows:renderReport(state)
    .map(({roomId,date,totalDayMinutes,soFarMinutes})=>({roomId,date,totalDayMinutes,soFarMinutes}))};
  alterReport?.(report);
  const members=[['state.json',state],['report.json',report]];
  alterEntries?.(members);
  const zip=makeZip(members);
  const artifact={
    id:9123,name:'jd-fullday-state',size_in_bytes:zip.length,digest:'sha256:'+sha256(zip),expired:false,
    created_at:iso(Date.parse(run0.created_at)+90000),expires_at:iso(now+100*HOUR),
    workflow_run:{id:run0.id,head_sha:run0.head_sha,head_branch:'main',repository_id:42,head_repository_id:42},
  };
  const evidence={schemaVersion:1,observedAt:iso(now-60000),runs:{total_count:3,workflow_runs:[run0,run2,run1]},
    artifactsByRun:{[run0.id]:{total_count:1,artifacts:[artifact]},[run1.id]:{total_count:0,artifacts:[]},
      [run2.id]:{total_count:0,artifacts:[]}}};
  const approval={
    schemaVersion:1,purpose:'R327_STAGE_HISTORICAL_CARRY_FORWARD',repository:repo,workflow,approvalReference:'SYNTHETIC-FIXTURE',
    approvedAt:iso(now-30000),expiresAt:iso(now+HOUR),sourceRun:runRef(run0),blockedRun:runRef(run2),artifactId:artifact.id,
    archiveSha256:sha256(zip),
  };
  const files={evidenceFile:path.join(root,'evidence.json'),approvalFile:path.join(root,'approval.json'),
    archiveFile:path.join(root,'historical.zip'),outputDirectory:path.join(root,'out')};
  fs.mkdirSync(files.outputDirectory);
  fs.writeFileSync(files.archiveFile,zip);
  const write=()=>{
    const b=Buffer.from(JSON.stringify(evidence));
    approval.evidenceSha256=sha256(b);
    fs.writeFileSync(files.evidenceFile,b);
    fs.writeFileSync(files.approvalFile,JSON.stringify(approval));
  };
  write();
  return {root,now,previousAt,day,evidence,approval,run0,run1,run2,artifact,files,write,
    stage:()=>stageLegacyHistory({...files,now}),target:path.join(files.outputDirectory,`r327-migration-${run2.id}-${run2.run_attempt}`)};
}
const readJson=p=>JSON.parse(fs.readFileSync(p,'utf8'));

test('real offline CLI stages an attested old ZIP as historical-only with the failed gap retained', t=>{
  const f=fixture(t);
  const entry=fileURLToPath(new URL('../../scripts/r327-legacy-migration.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[entry,'stage',...Object.values(f.files)],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).stage,'OFFLINE_HISTORICAL_ONLY');
  assert.doesNotMatch(r.stdout+r.stderr,/SYNTHETIC_DO_NOT_EXPORT/);
  const state=readJson(path.join(f.target,'historical-state.json'));
  const report=readJson(path.join(f.target,'historical-report.json'));
  verifyHistoryPair(state,report);
  assert.equal(state.sourceStatus,'UNKNOWN');
  assert.equal(state.lastSuccessfulSourceAt,null);
  assert.equal(state.rooms['101'].lastObservedAt,null);
  assert.equal(state.days[f.day]['101'].latest.at,f.previousAt);
  assert.equal(state.historicalMigration.stage,'OFFLINE_HISTORICAL_ONLY');
  assert.equal(state.historicalMigration.legacyGenerationVerified,false);
  assert.equal(state.historicalMigration.legacyReportCheck,'ROOM_DATE_AND_BASE_MINUTES_MATCH');
  assert.deepEqual(state.historicalMigration.failedRuns.map(r=>[r.runId,r.runAttempt,r.conclusion]),
    [[f.run2.id,2,'cancelled'],[f.run1.id,1,'failure']]);
  assert.equal(report.rows[0].observedAt,f.previousAt);
  assert.equal(report.rows[0].currentState,'UNKNOWN');
  assert.equal(report.rows[0].formalRatePercent,null);
  assert.equal(report.formalAttendanceReady,false);
  assert.doesNotMatch(JSON.stringify(state),/SYNTHETIC_DO_NOT_EXPORT/);
  assert.throws(()=>verifyRestored(f.target),/HISTORY_INPUT_UNAVAILABLE/);
  const named=path.join(f.root,'renamed-output');
  fs.mkdirSync(named);
  fs.copyFileSync(path.join(f.target,'historical-state.json'),path.join(named,'state.json'));
  fs.copyFileSync(path.join(f.target,'historical-report.json'),path.join(named,'report.json'));
  assert.throws(()=>verifyRestored(named),/R327_HISTORY_MIGRATION_NOT_ACTIVATED/);
  const operational=fileURLToPath(new URL('../../probes/r327/jd-fullday-cli.mjs',import.meta.url));
  const output=path.join(f.root,'must-not-collect.json');
  const blocked=spawnSync(process.execPath,[operational,'--previous',path.join(named,'state.json'),
    '--state-output',output,'--report-output',path.join(f.root,'must-not-report.json')],{
      encoding:'utf8',env:{...process.env,TCL_OPS_BASE_URL:'http://127.0.0.1:9'},
    });
  assert.equal(blocked.status,2,blocked.stderr);
  assert.match(blocked.stderr,/^R327_HISTORY_MIGRATION_NOT_ACTIVATED\s*$/);
  assert.equal(fs.existsSync(output),false);
  const afterFailedAttempt=update(state,[],f.now,{sourceStatus:'FAILED'});
  assert.equal(afterFailedAttempt.lastSuccessfulSourceAt,null);
  assert.equal(afterFailedAttempt.days[f.day]['101'].latest.at,f.previousAt);
  assert.deepEqual(afterFailedAttempt.historicalMigration,state.historicalMigration);
});

test('staging is once per blocked run and attempt in the same recovery workspace',async t=>{
  const f=fixture(t);
  await f.stage();
  const pathToState=path.join(f.target,'historical-state.json');
  const original=fs.readFileSync(pathToState);
  await assert.rejects(f.stage(),/R327_MIGRATION_OUTPUT_ALREADY_RESERVED/);
  assert.deepEqual(fs.readFileSync(pathToState),original);
});

test('modified history bytes and archive payload are both rejected before reserving output',async t=>{
  const f=fixture(t);
  fs.appendFileSync(f.files.evidenceFile,'\n');
  await assert.rejects(f.stage(),/R327_MIGRATION_DIGEST_MISMATCH/);
  f.write();
  fs.appendFileSync(f.files.archiveFile,'\n');
  await assert.rejects(f.stage(),/R327_MIGRATION_ARCHIVE_DIGEST_MISMATCH/);
  assert.deepEqual(fs.readdirSync(f.files.outputDirectory),[]);
});

test('rejects incomplete history, a later failure, and any available artifact from a failed attempt',async t=>{
  const f=fixture(t);
  f.evidence.runs.total_count=4;
  f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_HISTORY_INCOMPLETE/);
  f.evidence.runs.total_count=3;
  f.run2.run_attempt=3;
  f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_BLOCKED_RUN_MISMATCH/);
  f.approval.blockedRun=runRef(f.run2);
  f.evidence.artifactsByRun[f.run1.id]={total_count:1,artifacts:[{name:'failure-evidence'}]};
  f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_FAILURE_EVIDENCE_UNSAFE/);
  assert.deepEqual(fs.readdirSync(f.files.outputDirectory),[]);
});

test('rejects expired approval, altered source commit, foreign workflow and expired artifact',async t=>{
  const f=fixture(t);
  f.approval.expiresAt=iso(f.now-1000); f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_APPROVAL_EXPIRED/);
  f.approval.expiresAt=iso(f.now+HOUR);
  f.approval.sourceRun.headSha='e'.repeat(40); f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_SOURCE_RUN_MISMATCH/);
  f.approval.sourceRun=runRef(f.run0);
  f.run0.path='.github/workflows/unrelated.yml'; f.write();
  await assert.rejects(f.stage(),/RUN_PROVENANCE_INVALID/);
  f.run0.path=workflow; f.artifact.expired=true; f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_ARTIFACT_MISMATCH/);
  assert.deepEqual(fs.readdirSync(f.files.outputDirectory),[]);
});

test('rejects an approved old success with reruns because the ZIP cannot be attributed to an attempt',async t=>{
  const f=fixture(t);
  f.run0.run_attempt=2;
  f.approval.sourceRun=runRef(f.run0);
  f.write();
  await assert.rejects(f.stage(),/R327_MIGRATION_SOURCE_ATTEMPT_UNSUPPORTED/);
  assert.deepEqual(fs.readdirSync(f.files.outputDirectory),[]);
});

test('archive with unexpected members or a mismatched report is refused even with matching digest',async t=>{
  const unsafe=fixture(t,{alterEntries:entries=>entries.push(['../outside.json',{}])});
  await assert.rejects(unsafe.stage(),/R327_MIGRATION_ARCHIVE_INVALID/);
  const wrongPair=fixture(t,{alterReport:r=>r.generatedAt=iso(Date.parse(r.generatedAt)+3000)});
  await assert.rejects(wrongPair.stage(),/R327_MIGRATION_LEGACY_TIME_MISMATCH/);
  const mixedRows=fixture(t,{alterReport:r=>r.rows[0].soFarMinutes+=1});
  await assert.rejects(mixedRows.stage(),/R327_MIGRATION_LEGACY_ROWS_MISMATCH/);
  const duplicate=fixture(t,{alterReport:r=>r.rows.push({...r.rows[0]})});
  await assert.rejects(duplicate.stage(),/R327_MIGRATION_LEGACY_ROWS_MISMATCH/);
  assert.deepEqual(fs.readdirSync(unsafe.files.outputDirectory),[]);
  assert.deepEqual(fs.readdirSync(wrongPair.files.outputDirectory),[]);
  assert.deepEqual(fs.readdirSync(mixedRows.files.outputDirectory),[]);
  assert.deepEqual(fs.readdirSync(duplicate.files.outputDirectory),[]);
});

test('legacy zero minutes without a source timestamp cannot become a duration in the staged report',async t=>{
  let emptyDay;
  const f=fixture(t,{alterState:state=>{
    emptyDay=beijingDate(Date.parse(state.lastRunAt)-48*HOUR);
    state.days[emptyDay]={'101':{morning:null,latest:null,final:{at:state.lastRunAt,minuteCount:0,latestMinuteAt:null}}};
  }});
  const priorDigest=sha256(fs.readFileSync(f.files.archiveFile));
  await f.stage();
  assert.equal(sha256(fs.readFileSync(f.files.archiveFile)),priorDigest);
  const staged=readJson(path.join(f.target,'historical-state.json'));
  const report=readJson(path.join(f.target,'historical-report.json'));
  assert.equal(staged.historicalMigration.ambiguousZeroReadingsOmitted,1);
  assert.equal(staged.days[emptyDay]['101'].final,null);
  assert.equal(report.rows.find(row=>row.date===emptyDay).totalDayMinutes,null);
});

test('operational CLI retains safe failed snapshots for missing and malformed source configuration',t=>{
  const f=fixture(t), last=f.now-30000;
  const entry=fileURLToPath(new URL('../../probes/r327/jd-fullday-cli.mjs',import.meta.url));
  const oldDay=beijingDate(last);
  const original=update(null,[{roomId:'101',dailyOk:true,days:[{
    date:oldDay,minute_count:23,latest_minute_ts:iso(last),
  }]}],last);
  const previous=path.join(f.root,'previous.json');
  fs.writeFileSync(previous,JSON.stringify(original));
  for(const [code, base] of [['BASE_NOT_SET',null],['BASE_URL_INVALID','MALFORMED_PRIVATE_CONFIG_FIXTURE']]){
    const state=path.join(f.root,code+'-state.json'),report=path.join(f.root,code+'-report.json');
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='TCL_OPS_BASE_URL'));
    if(base!==null)env.TCL_OPS_BASE_URL=base;
    const r=spawnSync(process.execPath,[entry,'--previous',base===null?'-':previous,'--state-output',state,'--report-output',report],{
      encoding:'utf8',env,
    });
    assert.equal(r.status,2,r.stderr);
    assert.doesNotMatch(r.stdout+r.stderr,/MALFORMED_PRIVATE_CONFIG_FIXTURE/);
    const saved=readJson(state),summary=readJson(report);
    assert.equal(saved.sourceStatus,'FAILED');
    assert.deepEqual(summary.errors,[{stage:'CATALOG',code}]);
    verifyHistoryPair(saved,summary);
    if(base===null){assert.equal(saved.lastSuccessfulSourceAt,null);assert.deepEqual(saved.days,{});}
    else{
      assert.equal(saved.lastSuccessfulSourceAt,original.lastSuccessfulSourceAt);
      assert.deepEqual(saved.days,original.days);
    }
  }
});
