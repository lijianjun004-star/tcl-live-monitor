import { createHash, randomUUID } from 'node:crypto';

export function hourlySlot(at = new Date().toISOString()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid check time');
  date.setUTCMinutes(0, 0, 0); // Asia/Shanghai has an integral UTC offset.
  return date.toISOString();
}

export function createCheck({ platform = 'tmall', account_id = '2050532947', mode = 'manual', request_id, planned_check_at, actual_check_at = new Date().toISOString() } = {}) {
  if (!['hourly', 'manual'].includes(mode)) throw new TypeError('Invalid check mode');
  const actual = new Date(actual_check_at).toISOString();
  const planned = mode === 'hourly' ? hourlySlot(planned_check_at ?? actual) : new Date(planned_check_at ?? actual).toISOString();
  const request = mode === 'manual' ? String(request_id ?? randomUUID()) : null;
  const store_key = `${platform}:accountId:${account_id}`;
  const key = [store_key, mode, mode === 'hourly' ? planned : request].join('|');
  return { check_id: createHash('sha256').update(key).digest('hex'), store_key, platform, account_id: String(account_id), mode, request_id: request, planned_check_at: planned, actual_check_at: actual };
}

export function nextEligibleAt(actual, cooldownMs = 3_600_000) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new TypeError('Invalid cooldown');
  return new Date(new Date(actual).getTime() + cooldownMs).toISOString();
}
