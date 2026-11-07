#!/usr/bin/env node
/** Offline-only input adapter and mobile HTML report; NO requests to Taobao.
 * Usage: node probes/r13-single-store-report.mjs
 *   --input docs/evidence/r12-tmall-tcl-group-archived-samples.json
 *   --output-dir r13-preview
 * Input: array of raw independent samples, {"observations":[...]}, or archived {"runs":[...]}.
 * Summary-only observations are not accepted as timestamped evidence.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {reduceTmallSingleStore, renderR13Markdown} from './lib/r13-tmall-interval-monitor.mjs';
const args=process.argv.slice(2);
const arg=(name, fallback)=>{const p=args.indexOf(name);return p>=0?args[p+1]:fallback;};
const input=arg('--input','docs/evidence/r12-tmall-tcl-group-archived-samples.json');
const outputDir=arg('--output-dir','r13-preview');
const asOf=arg('--as-of',new Date().toISOString());
if(!input||!outputDir||!asOf)throw new Error('Missing CLI argument value');
const original=JSON.parse(await fs.readFile(input,'utf8'));
let samples;
if(Array.isArray(original))samples=original;
else if(Array.isArray(original.observations))samples=original.observations;
else if(Array.isArray(original.runs))samples=original.runs.flatMap(x=>
  Array.isArray(x.samples)?x.samples.filter(s=>s?.kind!=='summary-only'):[]
);
else throw new Error('Input must be raw observation records, not summary-only results');
const report=reduceTmallSingleStore(samples,{asOf});
report.reportType='OFFLINE_EVIDENCE_ONLY';
report.inputRecords=samples.length;
report.observationSource=path.basename(input);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const zh=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未确认';
const row=s=>'<tr><td>'+s.sequence+'</td><td>'+esc(s.status)+'</td><td>'+esc(zh(s.firstLiveDetectedAt))+
 '</td><td>'+esc(zh(s.firstOfflineDetectedAt))+'</td><td>'+esc(zh(s.endedConfirmedAt))+
 '</td><td>'+esc(s.estimatedContinuousLiveMinutes)+' 分钟（估算）</td></tr>';
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
 '<meta name="viewport" content="width=device-width,initial-scale=1"><title>TCL 淘宝直播观测｜R1.3</title>'+
 '<style>:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light;background:#f4f6fa;color:#182638}*{box-sizing:border-box}body{margin:0;padding:20px}main{max-width:1040px;margin:auto}.head{display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:12px}.card{background:#fff;border:1px solid #e5e9f1;border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 4px 15px #11213c08}h1{font-size:23px;margin:8px 0}h2{font-size:18px;margin:0 0 14px}.muted{color:#617087}.pill{display:inline-block;border-radius:30px;background:#eef2f7;padding:8px 12px;font-size:13px;font-weight:650}.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.kpi>div{background:#f7f9fc;padding:12px;border-radius:10px;min-width:0}.value{font-size:20px;font-weight:720;margin-top:6px;overflow-wrap:anywhere}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{padding:12px;border-bottom:1px solid #e5e9f1;text-align:left;font-size:13px}th{color:#475569}.alert{background:#fff8e6;border:1px solid #f2dea0;border-radius:10px;padding:13px;font-size:13px;line-height:1.7}small{color:#617087}code{word-break:break-all}</style></head><body><main>'+
 '<div class="head"><div><small>R1.3 · 淘宝／天猫单店 · 只读报告</small><h1>TCL集团官方旗舰店</h1><div class="muted">账号 '+esc(report.accountId)+' · 历史房间 '+esc(report.historicalRoomNum)+'</div></div><span class="pill">当前：'+esc(report.currentStatus)+'</span></div>'+
 '<div class="card"><h2>状态总览</h2><div class="kpi">'+
 [['最新状态',report.currentStatus],['最新观测',zh(report.lastObservationAt)],['本次报告场次',report.sessions.length],
 ['当前模式',report.mode],['建议下次间隔',report.recommendedNextIntervalMinutes+' 分钟'],
 [' LIVE / OFFLINE / UNKNOWN ',report.observationCounts.LIVE+' / '+report.observationCounts.OFFLINE+' / '+report.observationCounts.UNKNOWN]]
 .map(x=>'<div><small>'+esc(x[0])+'</small><div class="value">'+esc(x[1])+'</div></div>').join('')+
 '</div></div><div class="card"><h2>历史场次统计</h2><div class="table"><table><thead><tr><th>场次</th><th>过程</th><th>首次检测开播</th><th>首次检测下播</th><th>确认下播</th><th>估算直播跨度</th></tr></thead><tbody>'+
 (report.sessions.length?report.sessions.map(row).join(''):'<tr><td colspan="6">暂无足够证据确认场次</td></tr>')+
 '</tbody></table></div></div><div class="alert"><strong>证据说明：</strong>开播、下播时间是巡检首次发现时间，不是平台精确开关播时间。相邻LIVE时间差仅供估算，UNKNOWN和漏检区间不自动补时。确认下播需要两个相邻有效OFFLINE样本。报告使用离线历史数据，不代表已启用实时巡检、自动调度或正式考核。</div>'+
 '<p><small>报告生成：'+esc(zh(report.asOf))+'（北京时间） · 数据来源：'+esc(report.observationSource)+' · 自动计分：关闭 · 实时平台接入：待验证</small></p></main></body></html>';
await fs.mkdir(outputDir,{recursive:true});
await Promise.all([
 fs.writeFile(path.join(outputDir,'state.json'),JSON.stringify(report,null,2)+'\n'),
 fs.writeFile(path.join(outputDir,'report.md'),renderR13Markdown(report)+'\n'),
 fs.writeFile(path.join(outputDir,'index.html'),html)
]);
console.log(JSON.stringify({status:report.currentStatus,mode:report.mode,sessions:report.sessions.length,
 sampleCounts:report.observationCounts,source:report.observationSource,
 files:['state.json','report.md','index.html'].map(x=>path.join(outputDir,x))},null,2));
