#!/usr/bin/env node
/** R1.4 safe dry-run CLI: reads/writes one portable JSON ledger, zero network calls.
 * This runner NEVER accepts LIVE/OFFLINE from CLI. It emits UNKNOWN when source is absent.
 * It is not a production monitor, and is deliberately not scheduled.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {emptyLedger,parseLedger,recordR14Tick,planTmallTick,ALLOWED_FAILURE_CODES} from './lib/r14-tmall-durable.mjs';
import {renderR13Markdown} from './lib/r13-tmall-interval-monitor.mjs';
const argv=process.argv.slice(2);
const arg=(flag,defaultValue)=>{const i=argv.indexOf(flag);return i<0?defaultValue:argv[i+1];};
const now=arg('--now',new Date().toISOString());
const input=arg('--ledger',null);
const output=arg('--out','r14-preview/state.json');
const failure=arg('--failure','NO_APPROVED_SOURCE');
if(!output||!now||!ALLOWED_FAILURE_CODES.includes(failure))throw Error('INVALID_CLI_ARGUMENT');
let ledger;
if(input){
 const read=await fs.readFile(input,'utf8');
 ledger=parseLedger(read);
}else ledger=emptyLedger();
const update=recordR14Tick(ledger,{nowIso:now,failureCode:failure});
const current=update.ledger;
const outputPath=path.resolve(output);
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const temp=outputPath+'.tmp';
await fs.writeFile(temp,JSON.stringify(current,null,2)+'\n',{flag:'w'});
await fs.rename(temp,outputPath);
const plan=planTmallTick(current,{nowIso:now});
const summaryPath=path.join(path.dirname(outputPath),'summary.json');
await fs.writeFile(summaryPath,JSON.stringify({
 schemaVersion:14,
 type:'SAFE_DRY_RUN_NO_SOURCE',
 sourceConnected:false,
 currentStatus:plan.latestStatus,
 currentMode:plan.mode,
 nextDueAt:plan.nextDueAt,
 intervalMinutes:plan.intervalMinutes,
 recordedObservations:current.observations.length,
 attempts:current.attempts.length,
 sessions:plan.sessions,
 scoreEligible:false,
 action:update.action,
 reason:failure
},null,2)+'\n');
await fs.writeFile(path.join(path.dirname(outputPath),'summary.md'),
 '# 淘宝／天猫 R1.4 单店状态（未接入实时数据）\n\n'+
 '本报告为没有实时状态数据源时的安全运行演示，不能代表淘宝状态。\n\n'+
 '| 项目 | 结果 |\n|---|---|\n'+
 '| 账号 | TCL集团官方旗舰店 / 2050532947 |\n'+
 '| 本轮状态 | '+plan.latestStatus+' |\n'+
 '| 当前场次模式 | '+plan.mode+' |\n'+
 '| 下一次建议时点 | '+plan.nextDueAt+' |\n'+
 '| 历史观测条数 | '+current.observations.length+' |\n'+
 '| 来源状态 | 未接入，实际请求：0 |\n'+
 '| 计分 | 关闭 |\n\n'+
 '无数据时，LIVE/OFFLINE 不得伪造；缺少获准数据源，不启动真实定时巡检。\n'
);
console.log(JSON.stringify({
 run:'R1.4 dry run (no platform access)',
 action:update.action,status:plan.latestStatus,mode:plan.mode,
 nextDueAt:plan.nextDueAt,observations:current.observations.length,
 attempts:current.attempts.length,sourceAccess:'NOT_CONFIGURED',
 output,sourceRequests:0
},null,2));
