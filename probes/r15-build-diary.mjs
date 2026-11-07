#!/usr/bin/env node
/** Generate a self-contained mobile status diary from archived samples or R1.4 ledger.
 * No network and no platform requests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {compileR15Diary,toR15Csv} from './lib/r15-session-diary.mjs';
const argv=process.argv.slice(2);
const arg=(flag,fallback)=>{const i=argv.indexOf(flag);return i<0?fallback:argv[i+1];};
const input=arg('--input','docs/evidence/r12-tmall-tcl-group-archived-samples.json');
const outputDir=arg('--output-dir','r15-diary-preview');
const asOf=arg('--as-of',new Date().toISOString());
if(!input||!outputDir||!asOf)throw Error('MISSING_REQUIRED_ARG_VALUE');
const diary=compileR15Diary(JSON.parse(await fs.readFile(input,'utf8')),{asOf});
const escapeHTML=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'无足够证据';
const status=x=>({LIVE:'已观测开播',OFFLINE:'该时点未开播',UNKNOWN:'无法确认',PENDING_END:'疑似下播，待复核',ENDED_OBSERVED:'本场已下播',OFFLINE_OBSERVED:'未观测到本场开播',OPEN:'场次进行中',CLOSED:'已确认下播'})[x]||x;
const td=x=>'<td>'+escapeHTML(x)+'</td>';
const tableRow=a=>'<tr>'+a.map(td).join('')+'</tr>';
const sessionRows=diary.sessions.length?diary.sessions.map(s=>tableRow([
  s.sequence,status(s.status),fmt(s.firstLiveDetectedAt),fmt(s.firstOfflineDetectedAt),
  fmt(s.endedConfirmedAt),s.estimatedObservedLiveMinutes+' 分钟（估算）'
])).join(''):'<tr><td colspan="6">暂无可确认的直播场次</td></tr>';
const obsRows=diary.timeline.length?diary.timeline.map(s=>
  '<tr class="obs" data-day="'+escapeHTML(s.day)+'">'+[
    fmt(s.at),status(s.state),s.isEvidence?'有效':'不确定',s.reason
  ].map(td).join('')+'</tr>').join(''):
  '<tr><td colspan="4">暂无真实状态采样记录</td></tr>';
const opts=diary.days.map(d=>'<option value="'+escapeHTML(d.date)+'">'+
  escapeHTML(d.date)+'（'+d.samples+' 条）</option>').join('');
const metrics=[
 ['当前状态',status(diary.latestPhase)],['最近采样时间',fmt(diary.latestObservationAt)],
 ['已确认下播的场次',diary.confirmedSessions],['已记录场次',diary.sessions.length],
 ['有效状态记录',diary.validStateObservations+' / '+diary.retainedObservations],
 ['直播中目标查询间隔','15 分钟']
].map(([name,value])=>'<div class="metric"><small>'+escapeHTML(name)+'</small><div class="value">'+escapeHTML(value)+'</div></div>').join('');
const css=':root{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fa;color:#17273b}*{box-sizing:border-box}body{margin:0;padding:18px}main{max-width:1100px;margin:auto}h1{font-size:23px;margin:8px 0}h2{font-size:18px;margin:0 0 15px}p{line-height:1.6}.muted,small{color:#67768a;font-size:12px}.card{background:#fff;border:1px solid #e5eaf1;border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 3px 12px #18293a0b}.pill{display:inline-block;border-radius:24px;padding:9px 13px;background:#eff2f5;font-size:13px;font-weight:650}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.metric{padding:12px;border-radius:10px;background:#f7f9fc}.value{font-size:19px;font-weight:700;overflow-wrap:anywhere;margin-top:6px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e5eaf1;padding:12px;text-align:left;white-space:nowrap}th{font-weight:600;color:#546477}.warning{background:#fff9ea;border:1px solid #efd68f;padding:15px;border-radius:12px;line-height:1.7;font-size:13px}.head,.tools{display:flex;align-items:start;justify-content:space-between;gap:12px;flex-wrap:wrap}.tools{align-items:center}select{border:1px solid #cbd5e1;padding:9px;border-radius:8px;background:#fff}@media(max-width:640px){body{padding:11px}h1{font-size:21px}.card{padding:13px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.value{font-size:16px}th,td{padding:9px}}';
const html=['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
 '<title>淘宝／天猫｜TCL集团直播场次</title><style>',css,'</style></head><body><main>',
 '<div class="head"><div><small>R1.5 · 淘宝／天猫第一家 · 只读报告</small><h1>TCL集团官方旗舰店</h1><p class="muted">账号 ',
 escapeHTML(diary.accountId),' · 历史房间 ',escapeHTML(diary.historicalRoomNum),
 '</p></div><span class="pill">',escapeHTML(status(diary.latestPhase)),'</span></div>',
 '<section class="card"><h2>时间点与状态</h2><div class="metrics">',metrics,'</div></section>',
 '<section class="card"><h2>每场直播的开播、下播与时长</h2><div class="scroll"><table><thead><tr><th>场次</th><th>场次状态</th><th>首次发现开播</th><th>首次发现下播</th><th>再次确认下播</th><th>估算时间跨度</th></tr></thead><tbody>',
 sessionRows,'</tbody></table></div></section>',
 '<section class="card"><div class="tools"><h2>所有采样时间点</h2><label for="d">日期</label><select id="d"><option value="">全部日期</option>',
 opts,'</select></div><div class="scroll"><table><thead><tr><th>北京时间</th><th>状态</th><th>有效证据</th><th>原因</th></tr></thead><tbody>',
 obsRows,'</tbody></table></div></section>',
 '<div class="warning"><strong>核验说明：</strong>只记录真正取得的状态，漏检不能补记为 LIVE/OFFLINE；无法确认显示 UNKNOWN。首次发现开播／下播并非平台真实时间，相邻 LIVE 样本时间跨度也不是经过验证的实际直播时长。本报告生成过程不访问淘宝，',
 diary.reportKind==='ARCHIVED_GITHUB_ACTIONS_NOT_REALTIME'?'当前使用 2026-11-07 历史 GitHub 证据。':'当前使用离线提供的观察记录。',
 '</div><p class="muted">报告生成：',escapeHTML(fmt(diary.generatedAt)),'（北京时间） · 来源：',
 escapeHTML(diary.reportKind),' · 平台请求：0 · 正式评分：关闭</p>',
 '</main><script>document.getElementById("d").addEventListener("change",function(){const v=this.value;document.querySelectorAll("tr.obs").forEach(r=>{r.hidden=!!v&&r.dataset.day!==v;});});</script></body></html>'].join('');
await fs.mkdir(outputDir,{recursive:true});
await Promise.all([
 fs.writeFile(path.join(outputDir,'index.html'),html),
 fs.writeFile(path.join(outputDir,'diary.json'),JSON.stringify(diary,null,2)+'\n'),
 fs.writeFile(path.join(outputDir,'timeline.csv'),toR15Csv(diary,{kind:'timeline'})),
 fs.writeFile(path.join(outputDir,'sessions.csv'),toR15Csv(diary,{kind:'sessions'})),
 fs.writeFile(path.join(outputDir,'README.md'),
 '# TCL 淘宝／天猫 R1.5 单店场次记录\n\n手机浏览器打开 index.html。timeline.csv 为状态时间点，sessions.csv 为场次。\n\n本报告不访问淘宝。数据来源：'+diary.reportKind+'。当前直播状态只能在取得新证据后确认。\n')
]);
console.log(JSON.stringify({source:diary.reportKind,status:diary.latestStatus,
 records:diary.retainedObservations,valid:diary.validStateObservations,
 sessions:diary.sessions.length,closed:diary.confirmedSessions,
 files:['index.html','diary.json','timeline.csv','sessions.csv','README.md']},null,2));
