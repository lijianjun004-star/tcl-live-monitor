// CBC is not authenticated. Verify this tag BEFORE decrypting/extracting evidence.
// Never print the password, decrypted evidence or native exception text.
import fs from 'node:fs';
import path from 'node:path';
import {createHmac, hkdfSync, timingSafeEqual} from 'node:crypto';
export function authenticateEvidence(mode, keyFile, directory) {
  if (!['write','verify'].includes(mode)) throw Error('INTEGRITY_MODE');
  const secret=fs.readFileSync(keyFile,'utf8');
  if (!/^[0-9a-f]{64}\n$/.test(secret)) throw Error('KEY_FORMAT');
  const key=hkdfSync('sha256',Buffer.from(secret.trim(),'hex'),Buffer.alloc(0),'douyin-evidence-hmac-v1',32);
  const mac=createHmac('sha256',key);
  for (const name of ['p.enc','k.enc']) {
    const bytes=fs.readFileSync(path.join(directory,name));
    mac.update(name+'\0'+bytes.length+'\0');mac.update(bytes);
  }
  const expected=mac.digest();
  const file=path.join(directory,'integrity.txt');
  if (mode==='write') fs.writeFileSync(file,'DY-HMAC-SHA256-V1 '+expected.toString('hex')+'\n',{mode:0o600,flag:'wx'});
  else {
    const tag=fs.readFileSync(file,'utf8');
    if (!/^DY-HMAC-SHA256-V1 [0-9a-f]{64}\n$/.test(tag) ||
        !timingSafeEqual(expected,Buffer.from(tag.trim().split(' ')[1],'hex'))) throw Error('INTEGRITY_FAILED');
  }
}
if (process.argv[1] && import.meta.url===new URL('file:'+process.argv[1]).href) {
  try {authenticateEvidence(...process.argv.slice(2));}
  catch {console.error('EVIDENCE_INTEGRITY_FAILED');process.exitCode=1;}
}
