// Local-only staging CLI. No source requests or production writes.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {previewExports,LIMITS} from './import.mjs';
import {readBytes,publishNew,persistPreview} from './store.mjs';
const decode=buffer=>new TextDecoder('utf-8',{fatal:true}).decode(buffer);
try {
  const args=process.argv.slice(2),inputs=[]; const options={};
  for(let i=0;i<args.length;i+=2) {
    if(!args[i+1]) throw Error('ARGUMENT_INVALID');
    if(args[i]==='--input') inputs.push(args[i+1]);
    else if(['--mapping','--output','--store','--initialize-store','--sheet'].includes(args[i]) && options[args[i]]===undefined) options[args[i]]=args[i+1];
    else throw Error('ARGUMENT_INVALID');
  }
  if(!options['--mapping'] || !!options['--output']===!!options['--store'] || inputs.length<1 || inputs.length>LIMITS.files || (options['--initialize-store']!==undefined && (options['--initialize-store']!=='true' || !options['--store']))) throw Error('ARGUMENT_INVALID');
  const files=inputs.map(file=>{
    const format=path.extname(file).toLowerCase();
    if(format!=='.csv' && !(format==='.xlsx' && options['--sheet'])) throw Error('FORMAT_UNSUPPORTED');
    const bytes=readBytes(file,LIMITS.bytes);
    if(format==='.csv') return {format:'csv',text:decode(bytes)};
    const parser=fileURLToPath(new URL('./xlsx-reader.py',import.meta.url));
    const parsed=spawnSync(process.platform==='win32'?'python':'python3',[parser,options['--sheet']],{input:bytes,timeout:15000,maxBuffer:12*1024*1024,windowsHide:true});
    if(parsed.error || parsed.status!==0) throw Error('XLSX_REQUIRES_REVIEW');
    const rows=JSON.parse(decode(parsed.stdout));
    const text=rows.map(row=>row.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(',')).join('\n');
    return {format:'csv',text,sourceFormat:'xlsx',sourceSheet:options['--sheet'],sourceSha256:createHash('sha256').update(bytes).digest('hex')};
  });
  const mapping=JSON.parse(decode(readBytes(options['--mapping'],1024*1024)));
  const preview=previewExports({files,mapping,now:new Date().toISOString()});
  let result=preview;
  if(options['--store']) result=persistPreview({directory:options['--store'],preview,mapping,initialize:options['--initialize-store']==='true'});
  else publishNew(options['--output'],preview);
  console.log(JSON.stringify({mode:result.mode,...result.counts}));
  if(preview.errors.length || result.conflicts?.length) process.exitCode=2;
} catch(e) {
  console.error(e.message==='FORMAT_UNSUPPORTED'?'JD_EXPORT_FORMAT_UNSUPPORTED':e.message==='XLSX_REQUIRES_REVIEW'?'JD_EXPORT_XLSX_REQUIRES_REVIEW':'JD_EXPORT_IMPORT_BLOCKED');
  process.exitCode=1;
}
