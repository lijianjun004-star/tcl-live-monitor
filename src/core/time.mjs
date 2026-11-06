// All business dates/times are Beijing time (Asia/Shanghai, fixed UTC+08:00, no DST).
export const MINUTE = 60_000;
export const TZ = 'Asia/Shanghai';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function bjParts(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d)) {
    if (x.type !== 'literal') p[x.type] = x.value;
  }
  return p;
}

export function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+08:00`))
    && bjDate(Date.parse(`${s}T00:00:00+08:00`)) === s;
}
export function isTime(s) { return typeof s === 'string' && (TIME_RE.test(s) || s === '24:00'); }

/** Beijing wall-clock date + HH:MM -> epoch ms. '24:00' means next midnight. */
export function bjTs(date, hhmm) {
  if (!isDate(date) || !isTime(hhmm)) throw new RangeError(`非法北京时间: ${date} ${hhmm}`);
  if (hhmm === '24:00') return Date.parse(`${date}T00:00:00+08:00`) + 1440 * MINUTE;
  return Date.parse(`${date}T${hhmm}:00+08:00`);
}

export function bjDate(ts) {
  const p = bjParts(ts);
  if (!p) throw new RangeError('Invalid timestamp');
  return `${p.year}-${p.month}-${p.day}`;
}
export function bjHHMM(ts) {
  const p = bjParts(ts);
  if (!p) throw new RangeError('Invalid timestamp');
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
export function addDays(date, n) { return bjDate(bjTs(date, '00:00') + n * 1440 * MINUTE); }
