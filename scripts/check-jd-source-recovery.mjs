import { checkJdSourceConfiguration } from '../probes/lib/jd-source-config.mjs';
import { sourceError } from '../probes/lib/source-error.mjs';
import { networkReader, scanJdSource } from '../probes/lib/tcl-jd-all.mjs';
import { acceptJdOpsScan } from '../probes/r21/accept-jd-ops-scan.mjs';

const configured = process.env.TCL_OPS_BASE_URL;
const targetRoomId = process.env.JD_RECOVERY_TARGET_ROOM_ID;
const configuration = checkJdSourceConfiguration({
  configured,
  approved: process.env.JD_APPROVED_SOURCE_ORIGIN,
  legacy: process.env.JD_LEGACY_SOURCE_ORIGIN,
});

async function verify() {
  if (configuration.status !== 'CONFIG_MATCH') return { reason: configuration.code };
  if (!/^\d{1,16}$/.test(targetRoomId ?? '')) return { reason: 'INTERNAL_ROOM_ID_REQUIRED' };

  const scan = await scanJdSource({ reader: networkReader(configured), clock: Date.now });
  const accepted = acceptJdOpsScan(scan);
  const coverage = accepted.readiness === 'BLOCKED' ? 'UNVERIFIED' :
    accepted.readiness === 'OBSERVED' && scan.monitoringCoverage?.exhaustive ? 'COMPLETE' : 'PARTIAL';
  const evidence = {
    coverage,
    roomCount: accepted.room_count,
    liveCount: accepted.live,
    unknownCount: accepted.unknown,
    sourceCodes: [...new Set(scan.errors.map(error => error.code))],
  };
  if (accepted.readiness === 'BLOCKED') return { ...evidence, reason: accepted.reason };

  const target = accepted.rooms.find(room => room.room_id === targetRoomId);
  if (!target) return { ...evidence, reason: 'TARGET_ROOM_MISSING' };
  if (scan.warnings.includes(`JD_ROOM_DUPLICATE:${targetRoomId}`) ||
      scan.warnings.includes(`CATEGORY_MAPPING_CONFLICT:${targetRoomId}`)) {
    return { ...evidence, reason: 'TARGET_IDENTITY_CONFLICT' };
  }
  if (target.state !== 'LIVE' || target.source_error || !target.observed_at) {
    return { ...evidence, reason: 'TARGET_LIVE_NOT_CONFIRMED' };
  }
  return { ...evidence, reason: 'TARGET_LIVE_CONFIRMED' };
}

let result;
try {
  result = await verify();
} catch (error) {
  result = { reason: 'SOURCE_CHECK_FAILED', sourceCodes: [sourceError(error)] };
}
const passed = result.reason === 'TARGET_LIVE_CONFIRMED';
console.log(JSON.stringify({ status: passed ? 'PASS' : 'BLOCKED', ...result }));
if (!passed) process.exitCode = 2;
