// One reproducible offline entry point, including nested candidate suites.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.test.mjs')?[path.join(dir,e.name)]:[]);
const files=['tests','external/cloudflare-jd-clock/tests','experiments/offline-observation','experiments/relay-ledger'].flatMap(p=>walk(path.join(root,p))).sort();
const env={...process.env,NODE_OPTIONS:'--require='+JSON.stringify(path.join(root,'scripts/offline-test-guard.cjs'))};
// Node's socket guard does not cover native curl/gh subprocesses. Test stubs
// still run, while an accidentally selected real client cannot reach a service.
for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])env[key]='http://127.0.0.1:9';
env.NO_PROXY=env.no_proxy='localhost,127.0.0.1,::1';
for(const key of Object.keys(env))if(/^(GH_TOKEN|GITHUB_TOKEN|RESULTS_DISPATCH_TOKEN|CLOUDFLARE_API_TOKEN)$/i.test(key))delete env[key];
console.log('OFFLINE_TEST_ENV '+JSON.stringify({node:process.version,platform:process.platform,browser:env.R320_BROWSER_SMOKE==='1',nativeProxy:'loopback-deny'}));
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',env});
if(r.error)console.error('OFFLINE_TEST_RUNNER_FAILED');
process.exitCode=r.status??1;
