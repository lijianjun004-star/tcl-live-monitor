/** Standalone mobile-readable experiment report. Values are always escaped. */
const escape = v => String(v ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function buildReport(snapshot) {
  const observations = snapshot.observations ?? [];
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : Object.values(snapshot.sessions ?? {}).flat();
  return { experiment: 'R1.8', generated_at: new Date().toISOString(), store: 'TCL集团官方旗舰店',
    exact_start_end_time: false, observations, sessions,
    current_sessions: sessions.filter(s => !s.ended_at && !['CLOSED','REPLACED_BY_NEW_LIVE_ID'].includes(s.status ?? s.state)),
    warning: '实验观测；UNKNOWN 不等于停播。上下播时间仅为观测窗口，非平台精确时间。' };
}
export function renderReport(report) {
  const columns = [['platform','平台'],['planned_check_at','计划时间'],['actual_check_at','实际时间'],['state','状态'],['live_id','liveId'],['room_id','roomId'],['source_type','来源'],['source_attested','来源核验'],['evidence_ref','证据'],['failure_code','异常']];
  const rows = report.observations.map(o=>`<tr>${columns.map(([k])=>`<td>${escape(o[k])}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TCL R1.8 实验报告</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#f4f6f9;color:#172234}main{max-width:1200px;margin:auto;padding:20px}section{background:white;padding:16px;margin:16px 0;border-radius:12px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd;white-space:nowrap}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{max-width:75ch}</style><main><h1>TCL 直播监控 R1.8</h1><p>${escape(report.store)} · 独立安全实验</p><section><strong>${escape(report.warning)}</strong><p>是否为精确上下播时间：否。观测时间以 ISO 8601 保存；北京时间为 UTC+08:00。生成时间：${escape(report.generated_at)}</p></section><section><h2>巡检观测</h2><div class="scroll"><table><thead><tr>${columns.map(([,v])=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>当前场次</h2><pre>${escape(JSON.stringify(report.current_sessions,null,2))}</pre><h2>全部与历史场次</h2><pre>${escape(JSON.stringify(report.sessions,null,2))}</pre></section><p>已登录会话、真实换场及 24 小时连续运行是否通过，请以独立测试矩阵为准。</p></main></html>`;
}
