const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',style:{}});return elements.get(id);};
const context=vm.createContext({URLSearchParams,document:{getElementById:element},panelUser:{role:'operator'},safeHtml:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),toast(){},uiConfirm:async()=>true});
vm.runInContext(fs.readFileSync(path.join(__dirname,'audit.js'),'utf8'),context);
const run=s=>vm.runInContext(s,context);
async function main(){
 context.columns=['<img onerror=bad>'];context.rows=[{'<img onerror=bad>':'<script>bad</script>'}];const html=run('auditTable(columns,rows)');assert(html.includes('&lt;img')&&!html.includes('<script>'));
 context.fetch=async()=>({ok:true,json:async()=>({rows:[{actor_username:'alice',action:'site.deleted',site_name:'<unsafe>',occurred_at:'2026-10-14',details:'safe'}],total:1,offset:0})});
 await run('loadAudit(true)');assert(element('auditHistory').innerHTML.includes('alice')&&element('auditHistory').innerHTML.includes('&lt;unsafe&gt;'));assert(element('auditNext').disabled);
 run("auditExample('sites')");assert(element('auditSql').value.includes('panel_sites'));
 context.fetch=async()=>({ok:false,json:async()=>({error:'Read-only queries only'})});await run('runAuditQuery()');assert.equal(element('auditQueryResult').textContent,'Read-only queries only');assert(!element('auditQueryBtn').disabled);
 console.log('Audit UI: escaped tables/results, deletion attribution, pagination, SQL examples and visible query failures: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
