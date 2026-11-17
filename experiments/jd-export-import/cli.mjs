// Local-only staging CLI: restrictive new output, counts only on stdout.
import fs from 'node:fs';import path from 'node:path';
import {previewExports,LIMITS} from './import.mjs';
function read(file,limit){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>limit)throw Error('INPUT_INVALID');const buffer=Buffer.alloc(limit+1);let size=0,n;while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;if(size>limit)throw Error('INPUT_INVALID');return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));}finally{fs.closeSync(fd);}}
try{
 const args=process.argv.slice(2),inputs=[];let mappingFile,output;
 for(let i=0;i<args.length;i+=2){if(!args[i+1])throw Error('ARGUMENT_INVALID');if(args[i]==='--input')inputs.push(args[i+1]);else if(args[i]==='--mapping'&&!mappingFile)mappingFile=args[i+1];else if(args[i]==='--output'&&!output)output=args[i+1];else throw Error('ARGUMENT_INVALID');}
 if(!mappingFile||!output||inputs.length<1||inputs.length>LIMITS.files)throw Error('ARGUMENT_INVALID');
 const files=inputs.map(file=>{if(path.extname(file).toLowerCase()!=='.csv')throw Error('FORMAT_UNSUPPORTED');return {format:'csv',text:read(file,LIMITS.bytes)};});
 const mapping=JSON.parse(read(mappingFile,1024*1024));
 const result=previewExports({files,mapping,now:new Date().toISOString()});
 const fd=fs.openSync(output,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
 try{fs.writeFileSync(fd,JSON.stringify(result,null,2)+'\n');fs.fsyncSync(fd);}catch(e){fs.closeSync(fd);fs.unlinkSync(output);throw e;}
 fs.closeSync(fd);
 console.log(JSON.stringify({mode:result.mode,...result.counts}));
 if(result.errors.length)process.exitCode=2;
}catch(e){console.error(e.message==='FORMAT_UNSUPPORTED'?'JD_EXPORT_FORMAT_UNSUPPORTED':'JD_EXPORT_IMPORT_BLOCKED');process.exitCode=1;}
