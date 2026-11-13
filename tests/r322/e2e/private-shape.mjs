// Reduces the plaintext private record (sealed E2E only) to counts and booleans, so the R3.23
// calibration diagnostics can be checked without any value leaving the sealed step.
import fs from 'node:fs';
const { priv } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ok = c => Array.isArray(c) && c.every(x => typeof x === 'string' && /^[a-z0-9]+(\[[A-Za-z_-]{0,40}\])?$/.test(x));
const side = s => s == null ? null : {
  liveAnchors: s.liveAnchors.map(x => ({ registeredRoom: x.registeredRoom, liveText: x.liveText,
    insideLiveEntry: x.ancestry.includes('section[live-entry]'), insideUserInfo: x.ancestry.includes('div[user-info]'), labelsSafe: ok(x.ancestry) })),
  ownerLinks: s.ownerLinks.map(x => ({ insideRoomOwner: x.ancestry.includes('div[room-owner]'), insideUserInfo: x.ancestry.includes('div[user-info]'), labelsSafe: ok(x.ancestry) })),
  keys: Object.keys(s).sort(), anchorKeys: [...new Set(s.liveAnchors.flatMap(Object.keys))].sort() };
console.log(JSON.stringify(priv.map(r => ({ key: r.key, profile: side(r.profileStructure), room: side(r.roomStructure) }))));
