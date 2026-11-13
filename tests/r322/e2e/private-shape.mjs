// Reduces the plaintext private record (sealed E2E only) to counts and booleans, so the R3.23
// calibration diagnostics can be checked without any value leaving the sealed step.
import fs from 'node:fs';
const { priv, blockedStaticHosts = null } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ok = c => Array.isArray(c) && c.every(x => typeof x === 'string' && /^[a-z0-9]+(\[[A-Za-z_-]{0,40}\])?$/.test(x));
const side = s => s == null ? null : {
  liveAnchors: s.liveAnchors.map(x => ({ registeredRoom: x.registeredRoom, liveText: x.liveText,
    insideLiveEntry: x.ancestry.includes('section[live-entry]'), insideUserInfo: x.ancestry.includes('div[user-info]'), labelsSafe: ok(x.ancestry) })),
  ownerLinks: s.ownerLinks.map(x => ({ insideRoomOwner: x.ancestry.includes('div[room-owner]'), insideUserInfo: x.ancestry.includes('div[user-info]'), labelsSafe: ok(x.ancestry) })),
  replay: s.replay == null ? null : { textNodes: s.replay.textNodes, inLiveReplaySection: s.replay.ancestry.some(c => c.includes('section[live-replay]')),
    labelsSafe: s.replay.ancestry.every(ok) },
  keys: Object.keys(s).sort(), anchorKeys: [...new Set(s.liveAnchors.flatMap(Object.keys))].sort() };
// R3.24 raw-HTML shape: key names must be letters/underscore only; values never appear.
const keysOk = d => [d.secUid, d.roomId, d.displayId, d.accountName].every(x => x.contexts.every(c => c.every(k => /^[A-Za-z_]{2,24}$/.test(k))))
  && d.status.every(s => Number.isInteger(s.value) && s.before.every(k => /^[A-Za-z_]{2,24}$/.test(k)));
const doc = d => d == null ? null : { renderData: d.renderData, paceScripts: d.paceScripts, titleTagEmpty: d.titleTagEmpty,
  secUidUnderOwnerKey: d.secUid.contexts.some(c => c.at(-1) === 'sec_uid' && c.includes('owner')),
  roomIdUnderWebRid: d.roomId.contexts.some(c => c.at(-1) === 'web_rid'), statusValues: d.status.map(s => s.value), keysOk: keysOk(d),
  replayText: d.replayText, replayKeysOk: d.replayKeys.every(k => /^[A-Za-z_]{1,32}$/.test(k)),
  fields: Object.keys(d).sort().join(',') };
const hosts = blockedStaticHosts && { synthetic: Object.keys(blockedStaticHosts).filter(k => k.endsWith('|static.synthetic-cdn.test')).sort(),
  keysOk: Object.keys(blockedStaticHosts).every(k => /^(profile|room)\|[a-z0-9.-]+$/.test(k)), countsOk: Object.values(blockedStaticHosts).every(Number.isInteger) };
console.log(JSON.stringify({ hosts, rows: priv.map(r => ({ key: r.key, profile: side(r.profileStructure), room: side(r.roomStructure),
  profileDoc: doc(r.profileDoc), roomDoc: doc(r.roomDoc) })) }));
