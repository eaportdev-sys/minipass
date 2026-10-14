// Local publication is independent of public DNS. HTTPS-only repositories keep
// their CSP/cookies; a per-site CA signs the actual LAN/loopback address.
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { declarations } = require('./compose-inputs');
const ORIGIN = /^(?:APP|SITE|PUBLIC|FRONTEND|CLIENT|WEB|CORS)(?:_BASE)?_(?:URL|ORIGIN|ORIGINS)$/;
function derivedOrigins(root, selection) {
  const result=[];
  for(const [name,service] of Object.entries(declarations(root,selection).services)) {
    const values=Array.isArray(service.environment)?Object.fromEntries(service.environment.map(v=>{const at=v.indexOf('=');return [at<0?v:v.slice(0,at),at<0?null:v.slice(at+1)];})):service.environment || {};
    for(const [field,value] of Object.entries(values)) {
      const match=ORIGIN.test(field)&&typeof value==='string'&&/^(https?):\/\/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^{}]*)?\}\/?$/.exec(value);
      if(match)result.push({service:name,field,key:match[2],scheme:match[1]});
      const direct=ORIGIN.test(field)&&typeof value==='string'&&/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^{}]*)?\}$/.exec(value);
      if(direct)result.push({service:name,field,key:direct[1],scheme:null,direct:true});
    }
  }
  return result;
}
function hostname(value) {
  const host=String(value || 'localhost').replace(/^\[|\]$/g,'');
  if(!net.isIP(host)&&(!/^[A-Za-z0-9.-]+$/.test(host)||host.length>253||host.split('.').some(p=>!p||p.length>63||p.startsWith('-')||p.endsWith('-'))))throw new Error('Local access needs a plain IP address or hostname, not a URL');
  return host;
}
function address(meta, root, selection, port=meta.hostPort) {
  const host=hostname(meta.accessHost);
  if(!Number.isInteger(Number(port))||Number(port)<8000||Number(port)>8999)throw new Error('Local publication port is not allocated');
  const secure=Object.values(declarations(root,selection).services).some(s=>Object.entries(s.environment || {}).some(([k,v])=>/^(?:COOKIE_SECURE|SECURE_COOKIES|SESSION_COOKIE_SECURE)$/.test(k)&&String(v)==='true'));
  const scheme=meta.localScheme==='https'||secure||derivedOrigins(root,selection).some(o=>o.scheme==='https')?'https':'http';
  return `${scheme}://${net.isIP(host)===6?'['+host+']':host}:${port}/`;
}
function isLocal(meta) { return meta.accessMode==='local'||(!meta.publicUrl&&!meta.domain&&meta.accessMode!=='public'); }
function validPublicUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Site address must be a plain HTTP/HTTPS URL without credentials/query/fragment');
  return u.toString();
}
function applyOrigins(config,dir,root,selection,meta) {
  const warnings=[];
  if(!isLocal(meta)||!meta.localUrl)return warnings;
  let inputs={};try{inputs=JSON.parse(fs.readFileSync(path.join(dir,'.compose-inputs.json'),'utf8')).origins || {};}catch{}
  for(const origin of derivedOrigins(root,selection)) {
    const s=config.services[origin.service];
    if(!s||!s.environment)continue;
    if(inputs[origin.key]&&(origin.direct?s.environment[origin.field]===inputs[origin.key]:s.environment[origin.field]===`${origin.scheme}://${inputs[origin.key]}`||s.environment[origin.field]===`${origin.scheme}://${inputs[origin.key]}/`))s.environment[origin.field]=new URL(meta.localUrl).origin;
    let actual;try{actual=new URL(s.environment[origin.field]).origin;}catch{continue;}
    if(actual!==new URL(meta.localUrl).origin)warnings.push(`Saved origin ${origin.key} differs from the local address; its value was preserved. Update it if local access needs it.`);
  }
  return warnings;
}
function validateTarget(url, meta, sites) {
  if(!url)return;
  const u=new URL(url);
  const hosts=new Set(['localhost','127.0.0.1','::1','host.docker.internal',meta.accessHost].filter(Boolean).map(hostname));
  if(!hosts.has(u.hostname.replace(/^\[|\]$/g,'')))return;
  const port=Number(u.port || (u.protocol==='https:'?443:80));
  for(const other of sites.filter(s=>s.id!==meta.id)) {
    const ports=[other.hostPort,...(other.services || []).map(s=>s.hostPort),...(other.composePorts || []).map(p=>p.published)];
    if(ports.some(p=>Number(p)===port))throw Object.assign(new Error(`That local port belongs to another site. Use local/LAN access for this site's allocated address instead.`),{status:409});
  }
}
async function ensureTls({dir,host,run}) {
  host=hostname(host);
  const folder=path.join(dir,'.local-tls');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const caFile=path.join(folder,'ca.crt'),keyFile=path.join(folder,'server.key'),certFile=path.join(folder,'server.crt');
  if(fs.existsSync(caFile)) {
    const ca=new crypto.X509Certificate(fs.readFileSync(caFile));
    if(!ca.ca||Date.parse(ca.validTo)<Date.now()+86400000||!fs.existsSync(path.join(folder,'ca.key')))throw new Error('Local TLS authority is incomplete or expired; repair it explicitly, not by silently replacing device trust');
    if(fs.existsSync(certFile)&&fs.existsSync(keyFile)) {
      const cert=new crypto.X509Certificate(fs.readFileSync(certFile));
      if(cert.verify(ca.publicKey)&&cert.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(keyFile)))&&Date.parse(cert.validTo)>Date.now()+7*86400000&&(net.isIP(host)?cert.checkIP(host):cert.checkHost(host)))return {cert:fs.readFileSync(certFile,'utf8'),key:fs.readFileSync(keyFile,'utf8'),ca:fs.readFileSync(caFile,'utf8')};
    }
  }
  const temporary=fs.mkdtempSync(path.join(folder,'issue-'));
  try {
    const bin=process.env.OPENSSL_BIN || 'openssl';
    const ca=fs.existsSync(caFile)?folder:temporary;
    if(ca===temporary)await run(bin,['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','3650','-keyout',path.join(ca,'ca.key'),'-out',path.join(ca,'ca.crt'),'-subj','/CN=Minipass local site CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    const names=[...new Set([host,'localhost','127.0.0.1','::1','host.docker.internal'])];
    fs.writeFileSync(path.join(temporary,'extensions.cnf'),'[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName='+names.map(h=>(net.isIP(h)?'IP:':'DNS:')+h).join(',')+'\n');
    await run(bin,['req','-new','-newkey','rsa:2048','-nodes','-keyout',path.join(temporary,'server.key'),'-out',path.join(temporary,'server.csr'),'-subj','/CN=Minipass local site']);
    await run(bin,['x509','-req','-sha256','-days','365','-in',path.join(temporary,'server.csr'),'-CA',path.join(ca,'ca.crt'),'-CAkey',path.join(ca,'ca.key'),'-set_serial','0x'+crypto.randomBytes(16).toString('hex'),'-extfile',path.join(temporary,'extensions.cnf'),'-extensions','leaf','-out',path.join(temporary,'server.crt')]);
    for(const name of [...(ca===temporary?['ca.key','ca.crt']:[]),'server.key','server.crt']) {fs.copyFileSync(path.join(temporary,name),path.join(folder,name));fs.chmodSync(path.join(folder,name),name.endsWith('.key')?0o600:0o644);}
    return {cert:fs.readFileSync(certFile,'utf8'),key:fs.readFileSync(keyFile,'utf8'),ca:fs.readFileSync(caFile,'utf8')};
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={derivedOrigins,hostname,address,isLocal,validateTarget,validPublicUrl,ensureTls,applyOrigins};
