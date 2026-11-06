// Schedule import (standard CSV template) + preview diff + freeze-after-start.
// The user's original Excel layout has not been received yet; once it is, add a mapper that
// converts it into the same row shape and reuse planImport().
import { bjTs, bjDate, isDate, isTime, MINUTE } from './time.mjs';

const HEADER_ALIASES = {
  date: ['date', '日期', '排班日期'],
  roomId: ['room_id', 'roomid', '实体直播间', '直播间', '直播间id'],
  start: ['start', '开始', '开始时间'],
  end: ['end', '结束', '结束时间'],
  accountIds: ['account_ids', 'accounts', '账号', '平台账号'],
  status: ['status', '状态'],
};

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** Parse CSV text -> { slots, errors }. Cross-midnight rows (end <= start) end on the next day. */
export function parseScheduleCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { slots: [], errors: [{ line: 0, error: '空文件' }] };
  const head = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADER_ALIASES)) col[k] = head.findIndex(h => names.includes(h));
  const missing = ['date', 'roomId', 'start', 'end'].filter(k => col[k] < 0);
  if (missing.length) return { slots: [], errors: [{ line: 1, error: `缺少列: ${missing.join(',')}` }] };
  const slots = [], errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const get = k => (col[k] >= 0 ? cells[col[k]] ?? '' : '');
    const date = get('date').replace(/\//g, '-');
    const roomId = get('roomId'), start = get('start').padStart(5, '0'), end = get('end').padStart(5, '0');
    if (!isDate(date) || !roomId || !isTime(start) || !isTime(end) || start === end) {
      errors.push({ line: i + 1, error: '日期/直播间/时间不合法' }); continue;
    }
    const s = bjTs(date, start);
    let e = bjTs(date, end);
    const crossesMidnight = e <= s;
    if (crossesMidnight) e += 1440 * MINUTE;
    const status = /cancel|取消/i.test(get('status')) ? 'cancelled' : 'planned';
    const accountIds = get('accountIds') ? get('accountIds').split(/[;|]/).map(x => x.trim()).filter(Boolean) : null;
    slots.push({ key: `${date}|${roomId}|${start}`, scheduleDate: date, roomId, start: s, end: e, crossesMidnight, status, accountIds });
  }
  return { slots, errors };
}

/**
 * Preview what an import would change. Slots whose planned start is <= now are frozen:
 * they are never modified or removed by an import (scoring basis locked at start).
 */
export function planImport(existing, incoming, now) {
  const ex = new Map(existing.map(s => [s.key, s]));
  const inc = new Map(incoming.map(s => [s.key, s]));
  const plan = { add: [], update: [], cancel: [], unchanged: [], rejectedFrozen: [] };
  for (const [k, n] of inc) {
    const o = ex.get(k);
    if (!o) { (n.start <= now ? plan.rejectedFrozen : plan.add).push(n.start <= now ? { key: k, reason: 'ALREADY_STARTED_CANNOT_ADD' } : n); continue; }
    const same = o.end === n.end && o.status === n.status && JSON.stringify(o.accountIds) === JSON.stringify(n.accountIds);
    if (same) plan.unchanged.push(k);
    else if (o.start <= now) plan.rejectedFrozen.push({ key: k, reason: 'ALREADY_STARTED_FROZEN' });
    else plan.update.push({ before: o, after: n });
  }
  for (const [k, o] of ex) if (!inc.has(k)) {
    if (o.start <= now) plan.rejectedFrozen.push({ key: k, reason: 'ALREADY_STARTED_FROZEN' });
    else if (o.status !== 'cancelled') plan.cancel.push(o);
  }
  return plan;
}

/** Split a slot at Beijing midnight for daily statistics; attribution stays with scheduleDate. */
export function splitByStatDay(slot) {
  if (!slot.crossesMidnight) return [{ ...slot, statDate: slot.scheduleDate }];
  const mid = bjTs(slot.scheduleDate, '24:00');
  const next = bjDate(mid);
  return [{ ...slot, end: mid, statDate: slot.scheduleDate }, { ...slot, start: mid, statDate: next }];
}
