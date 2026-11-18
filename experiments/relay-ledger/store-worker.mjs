// Synthetic subprocess fixture; never imported by the adapter or Worker.
import {LocalRelayStore} from './durable-store.mjs';
import {TARGET} from './feedback.mjs';
const [directory, mode, value] = process.argv.slice(2);
const store = new LocalRelayStore(directory, {fault: stage => {
  if (mode === 'crash' && stage === value) process.exit(73);
}});
process.stdout.write('READY\n');
process.stdin.once('data', () => {
  try {
    const r = store.reserve({expectedRevision: 0, attemptId: 'attempt-' + (mode === 'crash' ? 'crash' : value),
      now: 1001, slotMs: 1001, target: {...TARGET, headSha: 'a'.repeat(40)},
      leaseOwner: 'worker-' + (mode === 'crash' ? 'crash' : value), leaseUntil: 2000});
    process.stdout.write(JSON.stringify({accepted: r.accepted, reason: r.reason, dispatch: r.dispatch}) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({accepted: false, reason: e.message, dispatch: false}) + '\n');
  }
  process.stdin.pause();
});
