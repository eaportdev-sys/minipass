// Run read-only SQL in a bounded child, not on the panel event loop.
const { fork } = require('child_process');
function query(file, sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 4000) return Promise.reject(Object.assign(new Error('Enter a read-only query of at most 4000 characters'), { status: 400 }));
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [file], { execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const finish = action => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); action(); };
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error('Query exceeded the 3-second limit'), { status: 400 }))), 3000);
    child.once('message', message => finish(() => message.error ? reject(Object.assign(new Error(message.error), { status: 400 })) : resolve(message)));
    child.once('error', e => finish(() => reject(e)));
    child.once('exit', () => finish(() => reject(new Error('Read-only query process exited without a result'))));
    child.send({ sql });
  });
}
if (require.main === module) process.once('message', ({ sql }) => {
  const { DatabaseSync, constants: c } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(process.argv[2], { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const siteColumns = new Set(['id','name','type','state','created_at','updated_at','deleted_at','deleted_by_id','deleted_by','destroyed_at']);
    const functions = new Set(['count','sum','avg','min','max','date','datetime','strftime','julianday','unixepoch','lower','upper','length','substr','substring','trim','ltrim','rtrim','coalesce','ifnull','nullif','round','abs','like','glob','instr']);
    db.setAuthorizer((action, table, column, database, source) => {
      if (action === c.SQLITE_SELECT) return c.SQLITE_OK;
      if (action === c.SQLITE_READ && database === 'main' && (table === 'audit_events' || table === 'panel_sites' || table === 'sites' && source === 'panel_sites' && (siteColumns.has(column) || column === ''))) return c.SQLITE_OK;
      if (action === c.SQLITE_FUNCTION && functions.has(column)) return c.SQLITE_OK;
      return c.SQLITE_DENY;
    });
    const text = sql.trim().replace(/;\s*$/, '');
    const stmt = db.prepare('SELECT * FROM (' + text + ') LIMIT 201');
    stmt.setReadBigInts(true);
    const columns = stmt.columns().map(col => col.name);
    if (columns.length > 32) throw new Error('Select at most 32 columns');
    const rows = stmt.all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : String(value) : value])));
    process.send({ columns, rows: rows.slice(0, 200), truncated: rows.length > 200 });
  } catch (e) { process.send({ error: 'Only read-only queries of audit_events and panel_sites are allowed. ' + e.message }); }
  finally { if (db) db.close(); }
});
module.exports = { query };
