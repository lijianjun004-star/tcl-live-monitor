// Offline import; never requests network or modifies existing monitor target configuration.
import fs from 'node:fs/promises';
import {normalizeOpsCatalog,normalizeJdReport,assembleRegistry,targetsToTagged} from './lib/ops-room-registry.mjs';
const flags=process.argv.slice(2);const get=(f,d=null)=>{const i=flags.indexOf(f);return i===-1?d:flags[i+1];};
const rooms=get('--rooms'),jdReport=get('--jd-report'),targets=get('--targets'),shops=get('--shops'),out=get('--out','room-registry.private.json'),unmapped=get('--unmapped');
if((!rooms&&!jdReport)||(rooms&&jdReport)||!targets){console.error('Usage: node probes/import-ops-room-registry.mjs (--rooms rooms.json | --jd-report sanitized-jd-report.json) --targets config/probe-targets.json [--shops shops.json] [--unmapped ops-unmapped.json] [--out private-preview.json]');process.exit(2)}
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const r=jdReport?normalizeJdReport(await read(jdReport)):normalizeOpsCatalog(await read(rooms),shops?await read(shops):null);
const cfg=await read(targets);
const others=unmapped?await read(unmapped):[];
const merged=assembleRegistry({opsCatalog:r,configuredTargets:targetsToTagged(cfg),unmappedOpsRoomRows:others});
// Full registry includes internal shop/room names, so keep private: chmod 0600.
await fs.writeFile(out,JSON.stringify(merged,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({output:out,numbers:merged.numbers,completeness:merged.roomCompleteness,warnings:merged.warnings}));
