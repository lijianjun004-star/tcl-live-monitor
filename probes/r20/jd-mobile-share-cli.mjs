#!/usr/bin/env node
/**
 * Local only: read a JD App share message from stdin and print a SANITIZED
 * candidate. Does not store raw share texts or visit any host.
 * Usage: node probes/r20/jd-mobile-share-cli.mjs < /private/path/share.txt
 */
import {intakeJdAppShareText} from './jd-mobile-share-intake.mjs';

let raw='';
try{
 for await (const chunk of process.stdin){
  raw+=String(chunk);
  if(raw.length>12000)throw Error('SHARE_TEXT_TOO_LARGE');
 }
 const result=intakeJdAppShareText(raw);
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(e){
 console.error('JD_SHARE_INTAKE_BLOCKED:',String(e?.message||e).slice(0,100));
 process.exitCode=2;
}
