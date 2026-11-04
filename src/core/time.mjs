// All business dates/times are Beijing time (Asia/Shanghai, fixed UTC+08:00, no DST).
export const MINUTE = 60_000;
export const TZ = 'Asia/Shanghai';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
export function bjHHMM(ts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
}
export function addDays(date, n) { return bjDate(bjTs(date, '00:00') + n * 1440 * MINUTE); }
