#!/usr/bin/env node
/** Offline manual/hourly audit runner: no platform requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {emptyLedger,parseLedger} from './lib/r14-tmall-durable.mjs';
import {recordUnverifiedHourlyAttempt,summarizeHourly,beijingTime} from './lib/r16-hourly.mjs';
const argv=process.argv.slice(2);
const arg=(flag,fallback)=>{const i=argv.indexOf(flag);return i<0?fallback:argv[i+1];};
const at=arg('--now',new Date().toISOString());
const trigger=arg('--trigger','manual');
const previous=arg('--ledger',null);
const out=arg('--out-dir','r16-hourly-preview');
const reason=arg('--reason','NO_APPROVED_SOURCE');
if(!out||!at||!trigger||!reason)throw Error('INVALID_ARGUMENT');
const ledger=previous?parseLedger(await fs.readFile(previous,'utf8')):emptyLedger();
const run=recordUnverifiedHourlyAttempt(ledger,{atIso:at,trigger,reason});
const report=summarizeHourly(run.ledger,{asOf:at});
const esc=x=>String(x??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const csvValue=x=>'"'+String(x??'').replace(/^[\s]*[=+\-@]/,m=>"'"+m).replaceAll('"','""')+'"';
const attemptsCsv='\ufeff'+[
 ['实际巡检（北京时间）','计划整点（北京时间）','触发方式','状态','失败原因','定时延迟（分钟）'],
 ...run.ledger.attempts.map(x=>[
  beijingTime(x.at),x.plannedSlotBeijing||'',x.trigger||'legacy','UNKNOWN / 未证实',x.failureCode||'',x.delayMinutes??''
 ])
].map(a=>a.map(csvValue).join(',')).join('\r\n')+'\r\n';
const rows=report.attempts.map(a=>'<tr><td>'+esc(beijingTime(a.at))+'</td><td>'+esc(a.plannedSlotAt?beijingTime(a.plannedSlotAt):'—')+'</td><td>'+esc(a.trigger)+'</td><td>UNKNOWN</td><td>'+esc(a.failureCode||'—')+'</td></tr>').join('');
const sessions=report.sessions.map(s=>'<tr><td>'+s.session+'</td><td>'+esc(s.status)+'</td><td>'+esc(s.firstLiveSeenAt?beijingTime(s.firstLiveSeenAt):'—')+'</td><td>'+esc(s.firstOfflineSeenAt?beijingTime(s.firstOfflineSeenAt):'—')+'</td><td>'+esc(s.observedAdjacentLiveSpanMinutes)+'（仅估算）</td></tr>').join('');
const html=['<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TCL 首店整点巡检记录</title><style>',
 'body{font:15px system-ui,-apple-system,sans-serif;background:#f4f7fb;color:#172941;margin:0;padding:16px}main{max-width:1080px;margin:auto}.panel{background:white;border:1px solid #e1e8f0;border-radius:14px;margin:14px 0;padding:16px;overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{padding:12px;text-align:left;border-bottom:1px solid #edf1f4;white-space:nowrap}h1{font-size:24px}.note{background:#fff8e6;border:1px solid #ecd596;border-radius:12px;padding:14px}small{color:#617387}</style></head><body><main><h1>TCL集团官方旗舰店 · 整点巡检</h1>',
 '<p><small>淘宝／天猫账号 2050532947 · 北京时间 · 无排班考核</small></p><section class="panel"><strong>当前状态：',esc(report.currentState),'</strong><p>巡检记录 ',report.attemptCount,' 次 · 周期 60 分钟 · 可手动触发</p><p>最近一次观测：',esc(report.lastObservationAt?beijingTime(report.lastObservationAt):'暂无'),'</p></section>',
 '<div class="note"><strong>数据来源尚未接通：</strong>本报告只记录巡检尝试，未获取真实淘宝直播状态；UNKNOWN 不表示下播。计划整点不等于实际执行时刻。测试阶段没有自动定时任务。</div>',
 '<section class="panel"><h2>巡检尝试明细</h2><table><thead><tr><th>实际北京时间</th><th>计划整点</th><th>触发方式</th><th>状态</th><th>原因</th></tr></thead><tbody>',rows||'<tr><td colspan="5">无记录</td></tr>','</tbody></table></section>',
 '<section class="panel"><h2>可核验的历史场次</h2><table><thead><tr><th>场次</th><th>状态</th><th>首次观测开播</th><th>首次观测停播</th><th>相邻LIVE跨度</th></tr></thead><tbody>',
 sessions||'<tr><td colspan="5">暂无真实 LIVE/OFFLINE 证据</td></tr>','</tbody></table></section>',
 '<p><small>生成 ',esc(beijingTime(report.asOf)),' · 手动巡检目前是 Actions 日志入口，不是直播页面的抓取按钮。</small></p></main></body></html>'].join('');
await fs.mkdir(out,{recursive:true});
const target=path.resolve(out),tmp=path.join(target,'.state.tmp');
await fs.writeFile(tmp,JSON.stringify(run.ledger,null,2)+'\n');
await fs.rename(tmp,path.join(target,'state.json'));
await Promise.all([
  fs.writeFile(path.join(target,'report.json'),JSON.stringify({...report,runAction:run.action},null,2)+'\n'),
  fs.writeFile(path.join(target,'attempts.csv'),attemptsCsv),
  fs.writeFile(path.join(target,'index.html'),html)
]);
console.log(JSON.stringify({action:run.action,trigger,plannedSlotAt:run.slot.plannedSlotAt,
 actualCheckAt:run.slot.actuallyStartedAt,state:report.currentState,
 attempts:report.attemptCount,sourceRequests:0,files:['state.json','report.json','attempts.csv','index.html']},null,2));
