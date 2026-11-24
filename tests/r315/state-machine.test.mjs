import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservation as evaluate } from '../../probes/r315/state-machine.mjs';

const policy = () => ({
  evaluatedAt: new Date('2026-11-12T12:00:00Z'),
  maxObservationAgeMinutes: 5, maxSourceAgeMinutes: 5,
});
const classifyObservation = evidence => evaluate(evidence, policy());

const valid = () => ({
  accessBlocked: false, sourceValid: true, schemaValid: true, catalogComplete: true,
  captureBound: true, heartbeatValid: true, platformMatched: true, identityVerified: true,
  conflictingEvidence: false, checkedAt: '2026-11-12T12:00:00Z',
  sourceUpdatedAt: '2026-11-12T11:59:00Z', maxAgeMinutes: 5,
  liveEvidence: true, offlineEvidence: false, offlineRuleValidated: false,
});

test('only corroborated, fresh live evidence yields LIVE', () => {
  assert.equal(classifyObservation(valid()).status, 'LIVE');
});

test('missing, false or malformed safety flags fail closed', () => {
  for (const key of ['sourceValid', 'schemaValid', 'catalogComplete', 'captureBound', 'heartbeatValid', 'platformMatched', 'identityVerified']) {
    for (const value of [false, undefined, 'true', 1]) {
      assert.equal(classifyObservation({ ...valid(), [key]: value }).status, 'UNKNOWN', `${key}: ${value}`);
    }
  }
  for (const key of ['accessBlocked', 'conflictingEvidence']) {
    for (const value of [true, undefined, 'false', 0]) {
      assert.equal(classifyObservation({ ...valid(), [key]: value }).status, 'UNKNOWN', `${key}: ${value}`);
    }
  }
  assert.equal(classifyObservation(null).status, 'UNKNOWN');
});

test('unknown, negative, invalid and future freshness cannot establish status', () => {
  for (const override of [
    { checkedAt: undefined }, { sourceUpdatedAt: undefined }, { sourceUpdatedAt: 'not a date' },
    { sourceUpdatedAt: '2026-11-12T11:59:00' }, { sourceUpdatedAt: '2026-11-12' },
    { sourceUpdatedAt: '2026-02-30T11:59:00Z' },
    { sourceUpdatedAt: '2026-11-12T12:01:00Z' }, { sourceUpdatedAt: '2026-11-12T11:54:59Z' },
    { maxAgeMinutes: undefined }, { maxAgeMinutes: -1 }, { maxAgeMinutes: Infinity }, { maxAgeMinutes: '5' },
  ]) assert.equal(classifyObservation({ ...valid(), ...override }).status, 'UNKNOWN');
  assert.equal(classifyObservation({ ...valid(), sourceUpdatedAt: '2026-11-12T11:55:00Z' }).status, 'LIVE');
});

test('OFFLINE requires a calibrated rule and explicit independent evidence', () => {
  const off = { ...valid(), liveEvidence: false, offlineEvidence: true };
  assert.equal(classifyObservation(off).status, 'UNKNOWN');
  assert.equal(classifyObservation({ ...off, offlineRuleValidated: true }).status, 'OFFLINE');
  assert.equal(classifyObservation({ ...off, liveEvidence: undefined, offlineRuleValidated: true }).status, 'UNKNOWN');
  assert.equal(classifyObservation({ ...valid(), liveEvidence: false, offlineEvidence: false }).status, 'UNKNOWN');
});

test('contradictory LIVE and OFFLINE evidence remains UNKNOWN', () => {
  assert.equal(classifyObservation({ ...valid(), offlineEvidence: true, offlineRuleValidated: true }).status, 'UNKNOWN');
});

test('rejects replayed observations, future timestamps and old source data at evaluation time', () => {
  const late = { ...policy(), evaluatedAt: new Date('2026-11-12T12:06:00Z') };
  assert.equal(evaluate(valid(), late).status, 'UNKNOWN');
  assert.equal(evaluate({ ...valid(), checkedAt: '2026-11-12T12:00:01Z' }, policy()).status, 'UNKNOWN');
  assert.equal(evaluate({ ...valid(), checkedAt: '2026-11-12T11:59:00Z',
    sourceUpdatedAt: '2026-11-12T11:54:59Z' }, policy()).status, 'UNKNOWN');
  assert.equal(evaluate({ ...valid(), checkedAt: '2026-11-12T11:55:00Z',
    sourceUpdatedAt: '2026-11-12T11:55:00Z' }, policy()).status, 'LIVE');
});

test('requires independent clock and bounded source and observation policies', () => {
  for (const invalid of [undefined, null, {},
    { ...policy(), evaluatedAt: new Date(NaN) },
    { ...policy(), evaluatedAt: '2026-11-12T12:00:00Z' },
    { ...policy(), maxObservationAgeMinutes: -1 },
    { ...policy(), maxObservationAgeMinutes: Infinity },
    { ...policy(), maxSourceAgeMinutes: 1441 },
    { ...policy(), maxSourceAgeMinutes: 1e308 },
    { ...policy(), maxSourceAgeMinutes: '5' },
  ]) assert.equal(evaluate(valid(), invalid).status, 'UNKNOWN');
  for (const maxAgeMinutes of [6, 1441, 1e308]) {
    assert.equal(evaluate({ ...valid(), maxAgeMinutes }, policy()).status, 'UNKNOWN');
  }
  assert.equal(evaluate(valid(), { ...policy(), maxSourceAgeMinutes: 4 }).status, 'UNKNOWN');
});
