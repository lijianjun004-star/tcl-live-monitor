/** A check invokes its source at most once. Cooldown also applies to manual checks. */
export async function runCheck({ store, adapter, check, cooldown_ms = 3_600_000 }) {
  const release = store.acquireTarget(check.store_key);
  try {
  const before = store.snapshot();
  if (before.checks[check.check_id]) return { duplicate: true, observation: before.observations.find(o => o.observation_id === check.check_id), snapshot: before, next_eligible_at: before.cooldowns[check.store_key]?.next_eligible_at ?? null };
  const cooldown = before.cooldowns[check.store_key];
  const base = { platform: check.platform, account_id: check.account_id, expected_account_id: check.account_id, planned_check_at: check.planned_check_at, actual_check_at: check.actual_check_at, source_type: 'unverified', source_attested: false, state: 'UNKNOWN' };
  let observation;
  if (cooldown && new Date(check.actual_check_at) < new Date(cooldown.next_eligible_at)) {
    observation = { ...base, failure_code: 'COOLDOWN_ACTIVE' };
  } else {
    try {
      const result = await (typeof adapter === 'function' ? adapter(check) : adapter.observe(check));
      observation = { ...base, ...result };
    } catch (error) {
      observation = { ...base, failure_code: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'NETWORK_ERROR' };
    }
  }
  // Browser capture can finish later than invocation. Planned slot/idempotency stay fixed.
  const effectiveCheck = { ...check, actual_check_at: observation.actual_check_at };
  observation.planned_check_at = check.planned_check_at;
  observation.evidence_ref = check.check_id;
  const evidence = { reason_code: observation.failure_code ?? 'OBSERVATION_CAPTURED', http_status: observation.http_status, body_sha256: observation.body_sha256 };
  const result = store.record(observation, { check: effectiveCheck, cooldown_ms, evidence });
  return { ...result, next_eligible_at: result.snapshot.cooldowns[check.store_key]?.next_eligible_at ?? null };
  } finally { release(); }
}
