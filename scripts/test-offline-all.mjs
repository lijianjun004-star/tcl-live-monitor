// One reproducible offline entry point, including nested candidate suites.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.test.mjs')?[path.join(dir,e.name)]:[]);
const files=['tests','external/cloudflare-jd-clock/tests','experiments/offline-observation','experiments/relay-ledger'].flatMap(p=>walk(path.join(root,p))).sort();
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',env:{...process.env,NODE_OPTIONS:'--require='+JSON.stringify(path.join(root,'scripts/offline-test-guard.cjs'))}});
if(r.error)console.error('OFFLINE_TEST_RUNNER_FAILED');
process.exitCode=r.status??1;
