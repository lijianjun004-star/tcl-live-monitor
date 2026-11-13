// R3.27 CLI: ONE read-only pass over the authorized TCL OPS source (GET only, allow-listed routes),
// then fold into the rolling state. Output: room ids, categories, dates, minute counts and rates only.
// Usage: TCL_OPS_BASE_URL=<origin> node probes/r327/jd-fullday-cli.mjs --previous FILE|- --state-output FILE --report-output FILE
import fs from 'node:fs';
import { networkReader, normalizeRoomList, SOURCE_ROUTES } from '../lib/tcl-jd-all.mjs';
import { update, report, beijingDate } from './jd-fullday.mjs';
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const prevFile = arg('--previous'), stateOut = arg('--state-output'), reportOut = arg('--report-output');
if (!stateOut || !reportOut) { console.error('USAGE'); process.exit(2); }
const previous = prevFile && prevFile !== '-' && fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : null;
const reader = networkReader(process.env.TCL_OPS_BASE_URL);
const now = Date.now();
const { rooms, warnings } = normalizeRoomList(await reader(SOURCE_ROUTES.rooms));
if (rooms.length === 0) throw new Error('NO_JD_ROOMS_IN_CATALOG');
const rows = [];
for (const room of rooms) {
  let days = [], dailyOk = false;
  try {
    const doc = await reader(SOURCE_ROUTES.daily, { start_date: beijingDate(now - 7 * 86400e3), end_date: beijingDate(now), platform: 'jd', live_room_id: room.roomId });
    if (Array.isArray(doc?.days)) { days = doc.days.map(d => ({ date: d?.date, minute_count: d?.minute_count, latest_minute_ts: d?.latest_minute_ts })); dailyOk = true; }
  } catch { /* this room stays without a reading for this run */ }
  rows.push({ roomId: room.roomId, category: room.category, captureBound: room.captureBound, days, dailyOk });
  await new Promise(r => setTimeout(r, 1000));
}
const state = update(previous, rows, now), rep = report(state);
fs.writeFileSync(stateOut, JSON.stringify(state));
fs.writeFileSync(reportOut, JSON.stringify({ generatedAt: new Date(now).toISOString(), window: state.window, warnings, rows: rep }, null, 1));
console.log('R327_JD_FULLDAY ' + JSON.stringify({ rooms: rooms.length, dailyOk: rows.filter(r => r.dailyOk).length, warnings: warnings.length,
  days: Object.keys(state.days).length, withRate: rep.filter(r => r.ratePercent !== null).length, rangeOnly: rep.filter(r => r.rangePercent !== null).length }));
