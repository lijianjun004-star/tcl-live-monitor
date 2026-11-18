/**
 * R3.27 JD fixed-window full-broadcast rate (pure, no I/O).
 * User rule 2026-11-14: JD rooms start between 07:00 and 08:00 and end between 24:00 and 01:00 (Beijing),
 * so the required window is 08:00-24:00 = 960 minutes per Beijing day.
 * Source: TCL OPS daily row per room (minute_count, latest_minute_ts). Minute data is capture data: when the
 * capture breaks while the stream continues the rate is UNDER-counted. No OFFLINE is ever inferred here.
 */
import {historyData,validateHistoryCommit} from '../lib/history-files.mjs';
export const WINDOW = Object.freeze({ startHour: 8, endHour: 24, requiredMinutes: 960 });
const DATE = /^\d{4}-\d\d-\d\d$/;
const dayStart = date => Date.parse(date + 'T00:00:00+08:00');
const validDate=date=>typeof date==='string'&&DATE.test(date)&&Number.isFinite(dayStart(date))&&beijingDate(dayStart(date))===date;
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const intOrNull = x => Number.isInteger(x) && x >= 0 && x <= 1440 ? x : null;
const tsOrNull = x => { const t = typeof x === 'string' || typeof x === 'number' ? Date.parse(x) : NaN; return Number.isFinite(t) ? t : null; };
export const beijingDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const hhmm = ms => ms === null ? null : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/** One reading of a room's daily row: only the two numbers needed. */
export function reading(dayRow, at) {
  const value=dayRow?.minute_count;
  const count=typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value)?intOrNull(Number(value)):null;
  return { at: new Date(at).toISOString(), minuteCount: count, latestMinuteAt: (t => t === null ? null : new Date(t).toISOString())(tsOrNull(dayRow?.latest_minute_ts)) };
}
/** A morning snapshot counts only when taken between 08:00 and 09:00 Beijing time of that day. */
export function isMorningSnapshot(date, r) {
  const t = tsOrNull(r?.at), s = dayStart(date);
  return t !== null && r?.minuteCount !== null && intOrNull(r?.minuteCount)===r?.minuteCount && t >= s + 8 * 3600e3 && t < s + 9 * 3600e3;
}
/** A final reading counts only when taken after that Beijing day has ended. */
export function isFinalReading(date, r) {
  const t = tsOrNull(r?.at);
  return t !== null && r?.minuteCount !== null && intOrNull(r?.minuteCount)===r?.minuteCount && t >= dayStart(date) + 24 * 3600e3 + 5 * 60e3;
}
export function computeDay(date, { morning = null, final = null } = {}) {
  if (!validDate(date)) throw new Error('DATE_INVALID');
  const s = dayStart(date), w0 = s + WINDOW.startHour * 3600e3, w1 = s + WINDOW.endHour * 3600e3, req = WINDOW.requiredMinutes;
  const out = { date, requiredMinutes: req, method: 'NO_FINAL_READING', inWindowMinutes: null, ratePercent: null,
    rangePercent: null, liveByWindowStart: null, lastMinuteBeijing: null, reachedWindowEnd: null, assumedContinuousMinutes: null, totalDayMinutes: null, routineAssumedRangePercent: null };
  const hasMorning = isMorningSnapshot(date, morning);
  if (hasMorning) {
    const lm = tsOrNull(morning.latestMinuteAt);
    // minute data within 3 minutes before 08:00 or later, seen by a snapshot taken after 08:00
    out.liveByWindowStart = lm !== null && lm >= w0 - 3 * 60e3 && lm <= tsOrNull(morning.at) + 60e3;
  }
  if (!isFinalReading(date, final)) return out;
  const total = final.minuteCount, last = tsOrNull(final.latestMinuteAt);
  out.totalDayMinutes = total;
  const lastInDay = last !== null && last >= s && last < w1 ? last : null;
  out.lastMinuteBeijing = hhmm(lastInDay);
  out.reachedWindowEnd = total === 0 ? false : lastInDay === null ? null : lastInDay >= w1 - 3 * 60e3;
  const pct = m => Math.round(Math.max(0, Math.min(req, m)) / req * 1000) / 10;
  if (hasMorning && morning.minuteCount <= total) {
    const lm = tsOrNull(morning.latestMinuteAt);
    // Minutes already inside the window at snapshot time: assumed continuous from 08:00 to the latest minute.
    const inside = lm !== null && lm >= w0 ? Math.min(morning.minuteCount, Math.floor((lm - w0) / 60e3) + 1) : 0;
    out.assumedContinuousMinutes = inside;
    out.inWindowMinutes = Math.max(0, Math.min(req, total - (morning.minuteCount - inside)));
    out.ratePercent = pct(out.inWindowMinutes);
    out.method = 'FROM_0800_SNAPSHOT';
    return out;
  }
  // No usable 08:00 snapshot: only bounds. Up to 480 minutes of the day lie before the window.
  out.method = 'RANGE_ONLY_NO_0800_SNAPSHOT';
  out.rangePercent = [pct(total - 480), pct(total)];
  // Narrower estimate that RELIES on the stated routine (start 07:00-08:00, end 24:00-01:00): at most
  // 120 minutes of the day lie outside the window. An estimate, not a measurement.
  out.routineAssumedRangePercent = [pct(total - 120), pct(total)];
  return out;
}

const empty = () => ({ schemaVersion: 327, platform: 'jd', window: '08:00-24:00 Asia/Shanghai', rooms: {}, days: {}, lastRunAt: null,
  lastAttemptedAt:null,lastSuccessfulSourceAt:null,sourceStatus:'UNKNOWN',formalAttendanceReady:false });
export function validateState(x) {
  if (x == null) return empty();
  validateHistoryCommit(x);
  if (x.schemaVersion !== 327 || x.platform !== 'jd' || typeof x.rooms !== 'object' || x.rooms === null || Array.isArray(x.rooms)||typeof x.days !== 'object' || x.days === null||Array.isArray(x.days)) throw new Error('BAD_STATE');
  for(const key of ['lastRunAt','lastAttemptedAt','lastSuccessfulSourceAt'])if(x[key]!=null&&!iso(x[key]))throw Error('BAD_STATE_TIME');
  if(x.lastSuccessfulSourceAt&&Date.parse(x.lastSuccessfulSourceAt)>Date.parse(x.lastAttemptedAt??x.lastRunAt))throw Error('BAD_STATE_TIME');
  for(const [id,room] of Object.entries(x.rooms)){
    if(!/^\d{1,16}$/.test(id)||!room||typeof room!=='object'||Array.isArray(room))throw Error('BAD_STATE_ROOM');
    for(const key of ['lastAttemptedAt','lastObservedAt'])if(room[key]!=null&&(!iso(room[key])||Date.parse(room[key])>Date.parse(x.lastAttemptedAt??x.lastRunAt)))throw Error('BAD_STATE_TIME');
  }
  for (const [d, rooms] of Object.entries(x.days)) {
    if (!validDate(d) || typeof rooms !== 'object' || rooms === null||Array.isArray(rooms)) throw new Error('BAD_STATE');
    for (const [id,slot] of Object.entries(rooms)){
      if (!/^\d{1,16}$/.test(id)||!x.rooms[id]||!slot||typeof slot!=='object'||Array.isArray(slot)) throw new Error('BAD_STATE');
      for(const key of ['morning','final','latest']){
        const r=slot[key];if(r==null)continue;
        if(!iso(r.at)||intOrNull(r.minuteCount)!==r.minuteCount||r.minuteCount===null||
          (r.latestMinuteAt!==null&&!iso(r.latestMinuteAt))||
          (x.lastRunAt&&Date.parse(r.at)>Date.parse(x.lastAttemptedAt??x.lastRunAt))||
          (r.latestMinuteAt&&Date.parse(r.latestMinuteAt)>Date.parse(r.at)+60000))throw Error('BAD_STATE_READING');
        if(key==='morning'&&!isMorningSnapshot(d,r)||key==='final'&&!isFinalReading(d,r))throw Error('BAD_STATE_READING');
      }
    }
  }
  return x;
}
export function validateOperationalPrevious(state) {
  if (state && Object.hasOwn(state,'historicalMigration')) throw Error('R327_HISTORY_MIGRATION_NOT_ACTIVATED');
  return validateState(state);
}
/**
 * Fold one source read into the state. rows: [{roomId, category, captureBound, days:[daily rows]}].
 * Keeps the FIRST valid morning snapshot and the LATEST final reading per room and day; 35 days of history.
 */
export function update(previous, rows, at, {sourceStatus=null}={}) {
  const state = historyData(validateState(previous)), now = new Date(at).getTime();
  if (!Number.isFinite(now)) throw new Error('TIME_INVALID');
  const today = beijingDate(now);
  if(state.lastRunAt&&now<Date.parse(state.lastAttemptedAt??state.lastRunAt))throw Error('CLOCK_MOVED_BACKWARD');
  if(!Array.isArray(rows))throw Error('ROWS_INVALID');
  const ids=new Set();let latestSuccess=null,usableRows=0;
  for(const room of Object.values(state.rooms)){room.lastAttemptedAt=new Date(now).toISOString();room.sourceStatus='UNAVAILABLE';}
  for (const row of rows) {
    if (!/^\d{1,16}$/.test(String(row?.roomId))||ids.has(String(row.roomId))) throw new Error('ROOM_INVALID');
    const id = String(row.roomId);
    ids.add(id);
    const observedAt=row.observedAt??new Date(now).toISOString();
    const usable=row.dailyOk===true&&Array.isArray(row.days)&&row.days.length>0&&iso(observedAt)&&Date.parse(observedAt)<=now;
    const prior=state.rooms[id];
    state.rooms[id] = { category: String(row.category || '').slice(0, 48), captureBound: row.captureBound === true,
      lastAttemptedAt:new Date(now).toISOString(),lastObservedAt:usable?observedAt:(prior?.lastObservedAt??null),sourceStatus:usable?'OBSERVED':row.dailyOk===true?'NO_OBSERVATION':'FAILED' };
    if(usable){usableRows++;if(!latestSuccess||Date.parse(observedAt)>Date.parse(latestSuccess))latestSuccess=observedAt;}
    const byDate = new Map();
    for(const d of Array.isArray(row.days)?row.days:[]){if(!validDate(d?.date)||byDate.has(d.date))throw Error('DAILY_SCHEMA_INVALID');byDate.set(d.date,d);}
    for (let i = 0; i <= 7; i++) {
      const date = beijingDate(now - i * 86400e3);
      // A missing day is absent evidence, even when the HTTP call succeeded. Never invent zeros.
      const r = reading(usable?byDate.get(date):null,usable?observedAt:now);
      const slot = ((state.days[date] ??= {})[id] ??= { morning: null, final: null, latest: null });
      if (r.minuteCount === null) continue;
      if (date === today) { slot.latest = r; if (!slot.morning && isMorningSnapshot(date, r)) slot.morning = r; }
      else if (isFinalReading(date, r)) slot.final = r;
    }
  }
  const cutoff = beijingDate(now - 35 * 86400e3);
  for (const d of Object.keys(state.days)) if (d < cutoff) delete state.days[d];
  state.lastRunAt = new Date(now).toISOString();
  state.lastAttemptedAt=state.lastRunAt;
  state.lastSuccessfulSourceAt=latestSuccess??state.lastSuccessfulSourceAt??null;
  state.sourceStatus=sourceStatus??(latestSuccess&&usableRows===rows.length?'OBSERVED':latestSuccess?'PARTIAL':'FAILED');
  state.formalAttendanceReady=false;
  validateState(state);
  return state;
}
export function report(state) {
  const s = validateState(state), out = [];
  for (const date of Object.keys(s.days).sort().reverse()) for (const id of Object.keys(s.days[date]).sort((a, b) => Number(a) - Number(b))) {
    const slot = s.days[date][id];
    out.push({ roomId: id, category: s.rooms[id]?.category ?? '', captureBound: s.rooms[id]?.captureBound === true, ...computeDay(date, slot),
      soFarMinutes: slot.final ? null : slot.latest?.minuteCount ?? null,
      observedAt:slot.final?.at??slot.latest?.at??slot.morning?.at??null,
      lastAttemptedAt:s.rooms[id]?.lastAttemptedAt??s.lastAttemptedAt??s.lastRunAt,
      sourceStatus:s.rooms[id]?.sourceStatus??'UNKNOWN',currentState:'UNKNOWN',
      formalAttendanceReady:false,formalRatePercent:null,measurement:'HISTORICAL_CAPTURE_ESTIMATE' });
  }
  return out;
}
