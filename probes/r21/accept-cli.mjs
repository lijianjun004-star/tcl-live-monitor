#!/usr/bin/env node
import fs from 'node:fs/promises';
import {acceptJdOpsScan} from './accept-jd-ops-scan.mjs';
const [input,output]=process.argv.slice(2);
if(!input||!output||process.argv.length!==4)throw Error('Usage: node probes/r21/accept-cli.mjs jd-raw-sanitized.json jd-observed.json');
const data=JSON.parse(await fs.readFile(input,'utf8'));
const result=acceptJdOpsScan(data);
await fs.writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({readiness:result.readiness,reason:result.reason,room_count:result.room_count,
 live:result.live,unknown:result.unknown,offline:result.offline,formal_opening_rate_percent:result.formal_opening_rate_percent}));
if(result.readiness==='BLOCKED')process.exitCode=3;
