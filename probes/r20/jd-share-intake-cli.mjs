#!/usr/bin/env node
/* One-link offline JD public-share intake; not a web scanner or redirect follower. */
import {parseJdConsumerLink} from './jd-share-intake.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--url')throw Error('USAGE: node probes/r20/jd-share-intake-cli.mjs --url <one-JD-share-URL>');
const result=parseJdConsumerLink(args[1]);
console.log(JSON.stringify({
 schema_version:20,source:'USER_SUBMITTED_PUBLIC_LINK',redirects_followed:false,
 public_page_checked:false,profile_and_ops_identity_verified:false,
 can_compute_opening_rate:false,room_current_state:'UNKNOWN',...result
},null,2));
