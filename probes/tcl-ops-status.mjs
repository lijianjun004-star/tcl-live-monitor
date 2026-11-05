// Multi-round status poll of TCL ops platform rooms. Prints ONLY states (no business metrics).
import fs from 'node:fs/promises';
import { classifyTclOps, liveMinutesDelta, trackSessionGap } from './lib/tcl-ops.mjs';
import { beijingDate } from './lib/tcl-jd-all.mjs';
const BASE = process.env.BASE;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const ROUNDS = Math.min(Math.max(arg('--rounds', 1), 1), 12), INTERVAL = Math.min(Math.max(arg('--interval-min', 5), 1), 15);
const get = async p => { const r = await fetch(new URL(p, BASE), { method: 'GET', signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); };
const bjDate = d => beijingDate(d);
const bjTime = t => t ? new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)) : '-';
const rows = []; const last = {}; const gapState = {}; const events = [];
for (let r = 1; r <= ROUNDS; r++) {
  const t0 = Date.now();
  let rooms = [], hb = {};
  try { rooms = (await get('/api/capture/rooms')).rooms || []; hb = Object.fromEntries(((await get('/api/assistant/active-rooms')).rooms || []).map(x => [x.id, x.last_heartbeat_at])); } catch (e) { console.log('round', r, 'list error', String(e).slice(0, 80)); }
  const today = bjDate(new Date());
  for (const room of rooms) {
    let day = null, err = null;
    try { const j = await get(`/api/capture/room-overview/daily?start_date=${today}&end_date=${today}&platform=${room.platform}&live_room_id=${room.id}`); day = (j.days || []).find(d => d.date === today) || null; } catch (e) { err = 'API_ERROR'; }
    const now = Date.now();
    const c = err ? { state: 'UNKNOWN', reason: err } : classifyTclOps({ day, heartbeatAt: hb[room.id] || null, now });
    const delta = liveMinutesDelta(last[room.id], c.minuteCount); last[room.id] = c.minuteCount;
    const sessionCount = Number.isInteger(day?.session_count) ? day.session_count : null;
    const g = trackSessionGap(gapState[room.id], { date: today, state: c.state, offlineCandidate: !!c.offlineCandidate, sessionCount, at: now });
    gapState[room.id] = g.next;
    if (g.event) events.push({ round: r, at: new Date(now).toISOString(), roomId: room.id, platform: room.platform, category: room.category, event: g.event,
      gapOpenedBJ: g.gapOpenedAt ? bjTime(g.gapOpenedAt) : (g.next.gapOpenedAt ? bjTime(g.next.gapOpenedAt) : null), sessionCount });
    rows.push({ round: r, at: new Date(now).toISOString(), roomId: room.id, platform: room.platform, category: room.category, state: c.state, reason: c.reason,
      offlineCandidate: !!c.offlineCandidate, minuteAgeMin: c.minuteAgeMin, agentAlive: c.agentAlive, liveMinutesSinceLastPoll: delta,
      latestMinuteBJ: bjTime(Date.parse(day?.latest_minute_ts || '') || null), sessionCount });
  }
  console.log(`round ${r}/${ROUNDS}: ` + rows.filter(x => x.round === r).map(x => `${x.platform}-${x.roomId}(${x.category})=${x.state}${x.offlineCandidate ? '?' : ''}`).join(' '));
  if (r < ROUNDS) await new Promise(res => setTimeout(res, Math.max(0, t0 + INTERVAL * 60000 - Date.now())));
}
const md = ['| 轮 | 直播间 | 品类 | 状态 | 停播候选 | 最新分钟(北京) | 距今(分) | 采集端在线 | 本轮新增直播分钟 | 当日场次 | 原因 |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.filter(x => x.platform === 'jd').map(x => `| ${x.round} | jd-${x.roomId} | ${x.category} | ${x.state} | ${x.offlineCandidate ? '是' : ''} | ${x.latestMinuteBJ} | ${x.minuteAgeMin ?? '-'} | ${x.agentAlive ? '是' : '否'} | ${x.liveMinutesSinceLastPoll ?? '-'} | ${x.sessionCount ?? '-'} | ${x.reason} |`)].join('\n');
const ev = ['| 轮 | 直播间 | 品类 | 事件 | 空白开始(北京) | 当日场次 |', '|---|---|---|---|---|---|',
  ...events.map(e => `| ${e.round} | ${e.platform}-${e.roomId} | ${e.category} | ${e.event} | ${e.gapOpenedBJ ?? '-'} | ${e.sessionCount ?? '-'} |`)].join('\n');
await fs.writeFile('tcl-ops-summary.md', `# TCL运营平台 京东状态（只含状态，无业务数据）\n\n${md}\n\n## 停播候选校准事件\nGAP_CLOSED_NEW_SESSION = 平台自己把空白前后切成两场（真停播）；GAP_CLOSED_SAME_SESSION = 同一场（候选为假阳性/采集卡顿）。\n\n${ev}\n`);
console.log(md);
console.log('EVENTS'); for (const e of events) console.log('event ' + JSON.stringify(e));
