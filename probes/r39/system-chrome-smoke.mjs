/** R3.9: offline browser launch only, no pages, no network, no credentials. */
const {chromium}=await import('playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const version=browser.version();
 if(!/^\d+\./.test(version))throw Error('R39_SYSTEM_CHROME_VERSION_UNKNOWN');
 console.log('R39_SYSTEM_CHROME_LAUNCH_PASS '+version);
}finally{await browser.close();}
