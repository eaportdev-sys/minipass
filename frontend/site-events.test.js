const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:''});return elements.get(id);};
const context=vm.createContext({currentApp:'alpha',document:{getElementById:element},safeHtml:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),toast(){},copyText:async()=>true});
vm.runInContext(fs.readFileSync(path.join(__dirname,'site-events.js'),'utf8'),context);
const run=s=>vm.runInContext(s,context);
async function main(){
 context.fetch=async()=>({ok:true,json:async()=>({events:[{at:'2026-10-14',level:'error',area:'deploy-create',message:'Compose service missing build <unsafe>'},{at:'2026-10-14',level:'warn',area:'create',message:'Unset DB_PASS'}]})});
 await run('loadSiteEvents()');assert(element('siteEvents').innerHTML.includes('Unset DB_PASS')&&element('siteEvents').innerHTML.includes('missing build &lt;unsafe&gt;'));
 let finish;context.fetch=()=>new Promise(r=>{finish=()=>r({ok:true,json:async()=>({events:[{message:'OLD SITE',level:'error'}]})})});const pending=run('loadSiteEvents()');context.currentApp='beta';context.fetch=async()=>({ok:true,json:async()=>({events:[{at:'now',level:'info',area:'create',message:'CURRENT SITE'}]})});await run('loadSiteEvents()');finish();await pending;assert(element('siteEvents').innerHTML.includes('CURRENT SITE')&&!element('siteEvents').innerHTML.includes('OLD SITE'));
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');assert(html.includes('id="siteEvents"')&&html.includes('site-events.js'));
 console.log('Site logs: durable warning/error rendering, escaping, current-site isolation and loaded UI: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
