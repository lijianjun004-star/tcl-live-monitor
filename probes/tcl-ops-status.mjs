// Multi-round status poll of TCL ops platform rooms. Prints ONLY states (no business metrics).
import fs from 'node:fs/promises';
import { classifyTclOps, liveMinutesDelta } from './lib/tcl-ops.mjs';
const BASE = process.env.BASE;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const ROUNDS = Math.min(Math.max(arg('--rounds', 1), 1), 12), INTERVAL = Math.min(Math.max(arg('--interval-min', 5), 1), 15);
const get = async p => { const r = await fetch(new URL(p, BASE), { method: 'GET', signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); };
const bjDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
const bjTime = t => t ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)) : '-';
const rows = []; const last = {};
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
    rows.push({ round: r, at: new Date(now).toISOString(), roomId: room.id, platform: room.platform, category: room.category, state: c.state, reason: c.reason,
      offlineCandidate: !!c.offlineCandidate, minuteAgeMin: c.minuteAgeMin, agentAlive: c.agentAlive, liveMinutesSinceLastPoll: delta,
      latestMinuteBJ: bjTime(Date.parse(day?.latest_minute_ts || '') || null) });
  }
  console.log(`round ${r}/${ROUNDS}: ` + rows.filter(x => x.round === r).map(x => `${x.platform}-${x.roomId}(${x.category})=${x.state}${x.offlineCandidate ? '?' : ''}`).join(' '));
  if (r < ROUNDS) await new Promise(res => setTimeout(res, Math.max(0, t0 + INTERVAL * 60000 - Date.now())));
}
const md = ['| 轮 | 直播间 | 品类 | 状态 | 停播候选 | 最新分钟(北京) | 距今(分) | 采集端在线 | 本轮新增直播分钟 | 原因 |', '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.filter(x => x.platform === 'jd').map(x => `| ${x.round} | jd-${x.roomId} | ${x.category} | ${x.state} | ${x.offlineCandidate ? '是' : ''} | ${x.latestMinuteBJ} | ${x.minuteAgeMin ?? '-'} | ${x.agentAlive ? '是' : '否'} | ${x.liveMinutesSinceLastPoll ?? '-'} | ${x.reason} |`)].join('\n');
await fs.writeFile('tcl-ops-summary.md', `# TCL运营平台 京东状态（只含状态，无业务数据）\n\n${md}\n`);
console.log(md);
