/** Build a static offline preview using only sanitized identity/status projection. */
import fs from 'node:fs/promises';
const args=process.argv.slice(2),arg=(f,d=null)=>{const i=args.indexOf(f);return i>=0?args[i+1]:d;};
const input=arg('--view'),out=arg('--out');
if(!input||!out){console.error('Usage: node probes/render-offline-preview.mjs --view safe-view.json --out preview.html');process.exit(2);}
const [view,template]=await Promise.all([fs.readFile(input,'utf8').then(JSON.parse),fs.readFile(new URL('../preview/template.html',import.meta.url),'utf8')]);
if(view?.schemaVersion!==1||!Array.isArray(view.rows)||view.rows.some(x=>!['jd','tmall','douyin'].includes(x.platform)))throw Error('VIEW_INVALID');
// HTML script contexts require escaping '<' so untrusted external shop names cannot close the JSON script tag.
const safe=JSON.stringify(view).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026');
if(!template.includes('__EMBED_DATA__'))throw Error('PREVIEW_TEMPLATE_MISSING');
await fs.writeFile(out,template.replace('__EMBED_DATA__',safe),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({output:out,rows:view.rows.length,sourceShops:view.sourceShops?.length??0}));
