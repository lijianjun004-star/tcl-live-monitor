// Offline aggregate: room registry + already-produced read-only probe results.
import fs from 'node:fs/promises';
import {mergeLiveObservations} from './lib/merge-live-observations.mjs';
const argv=process.argv.slice(2),arg=n=>{const i=argv.indexOf(n);return i<0?null:argv[i+1]};
const registry=arg('--registry');if(!registry){console.error('Usage: node probes/build-three-platform-view.mjs --registry room-registry.json [--jd-report jd.json] [--public-report probe-report.json] --out view.json');process.exit(2)}
const read=async p=>p?JSON.parse(await fs.readFile(p,'utf8')):null;
const imported=await read(registry);
const result=mergeLiveObservations(imported,{jdReport:await read(arg('--jd-report')),publicReport:await read(arg('--public-report'))});
result.sourceShops=imported.shops??[];
result.sourceCatalogCompleteness=imported.roomCompleteness??{};
const dest=arg('--out')??'three-platform-view.private.json';
await fs.writeFile(dest,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output:dest,byPlatform:result.byPlatform,scope:result.scope}));
