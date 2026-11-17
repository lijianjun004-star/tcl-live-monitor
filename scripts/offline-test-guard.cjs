// Test harness: only numeric loopback TCP destinations. Inherited by Node subprocesses.
const net=require('node:net'),dns=require('node:dns'),dgram=require('node:dgram');
const allowed=h=>['127.0.0.1','::1','localhost'].includes(h);
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const opts=net._normalizeArgs(args)[0];
 if(opts.port!=null&&!allowed(opts.host||'localhost'))throw Error('OFFLINE_TEST_EXTERNAL_NETWORK_DENIED');
 return connect.apply(this,args);
};
const lookup=dns.lookup;
dns.lookup=function(host,...args){if(!allowed(host))throw Error('OFFLINE_TEST_DNS_DENIED');return lookup.call(this,host,...args);};
dgram.Socket.prototype.send=function(){throw Error('OFFLINE_TEST_UDP_DENIED');};
require('node:module').syncBuiltinESMExports();
