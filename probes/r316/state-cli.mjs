// CLI: decrypt|encrypt <input.json> <output.json>. No key or identifiers are ever logged.
import fs from 'node:fs';
import { parseStateKey, sealState, openState } from './state-cipher.mjs';
const [action, input, output] = process.argv.slice(2);
if (!['decrypt','encrypt'].includes(action) || !input || !output) throw Error('STATE_CLI_USAGE');
const key=parseStateKey(process.env.R316_STATE_KEY);
const value=JSON.parse(fs.readFileSync(input,'utf8'));
const result=action==='decrypt'?openState(value,key):sealState(value,key);
fs.writeFileSync(output,JSON.stringify(result)+'\n',{mode:0o600});
console.log('R316_STATE_'+(action==='decrypt'?'RESTORED':'SEALED')+'_PRIVATE_NO_IDENTIFIERS');
