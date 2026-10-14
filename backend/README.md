# Backend sections

Node **24.10+** (the panel image uses Node 24). `server.js` only starts the application.

- `context.js`: shared configuration, paths, command runners and component wiring.
- `network.js`: HTTP listener, WebSocket terminal and graceful shutdown.
- `routes/`: independent HTTP sections: `sites`, `deployment`, `services`, `git`,
  `databases`, `migrations`, `environment`, `files`, `lifecycle`, `storage`,
  `doctor`, `remediation`, `panel`, `webhooks`, `auth`, and `audit`.
- `lib/deployment-executor.js`: build/swap/runtime checks and repository Compose execution.
- `lib/deployment-state.js`: deployment queue/history, source summary and landing routes.
- `lib/source-detection.js`: repository detection and checkout/service discovery.
- `lib/site-configuration.js`: service, database and environment wiring.
- `lib/site-lifecycle.js` + `deletion-queue.js`: bounded cleanup, cancellation and Trash.
- `lib/panel-store.js`: SQLite records, migration, transactions and durable audit events.
- `lib/panel-accounts.js`: named users, password hashes and hashed session tokens.
- `lib/audit-query.js`: isolated, bounded read-only SQL queries.

## Records and migration

`panel.sqlite` lives next to `DATA_FILE` (normally `/data/panel.sqlite` on the
persistent panel-data volume). `PANEL_DB_FILE` can override it. JSON files are
**legacy migration inputs**, not the active site/session database.

The first SQLite startup imports live sites, Trash and the existing admin password.
Original JSON files and owner-only `.sqlite-migration-backup` copies are retained.
Migration runs once in a transaction and stops on invalid records rather than
silently discarding them. Site files, running applications and customer database
volumes are not migrated by this change.

The existing login becomes **admin**, with its existing password. Anonymous legacy
sessions are invalidated; each operator must log in with a named account. Disabled
accounts remain in history, and the last administrator cannot be disabled.

Each site is an independent SQLite row. Snapshot saves apply only changed records,
and merge changes without rewriting unrelated sites from older asynchronous work.
Delete/restore/destroy metadata and their audit event commit together. Destroyed
sites retain a public tombstone (name, ID, dates and actor), not private configuration.
Old deletions without recorded actors are labeled unknown, never attributed to a
newly created account.

## Audit panel

The sidebar **Audit & accounts** view provides history filters, pagination, named
operator management, and a read-only SQL editor. Queryable datasets are:

```sql
SELECT occurred_at, actor_username, action, site_name, site_id, outcome
FROM audit_events
WHERE action IN ('site.deleted', 'site.restored', 'site.destroyed')
ORDER BY id DESC;

SELECT id, name, state, deleted_at, deleted_by, destroyed_at FROM panel_sites;
```

Query execution cannot modify records or read password hashes, sessions or private
site JSON. It runs outside the panel event loop, with a three-second deadline and
200-row result limit. Audit records cannot be edited/deleted through the panel.
This does not claim protection against an administrator replacing the physical
database file outside the panel.

## Deletion and storage contract

Multiple deletion requests are accepted and queued internally. Only one heavy
cleanup runs at a time. Site directories are removed asynchronously; queued
permanent deletions share a single unused-build-cache cleanup after the batch.
Bulk Empty Trash still performs one shared cache cleanup, not one per site.

**Every new site receives an enforced storage allowance** after its capacity check.
There is no opt-out flag and no successful creation with a fake unenforced limit.
An unready host quota bridge needs repair; it is not permission to disable quotas.
Limits apply to the panel and ordinary application/database containers, including
uid 0. A privileged host administrator with `CAP_SYS_RESOURCE` can override kernel
quotas, just as they can change the filesystem itself; the live smoke test drops
that override while keeping uid 0 to verify actual `EDQUOT` enforcement.

## Verification

`npm test`, `npm run test:workflow-api`, `npm run test:cleanup-api`, and
`npm run test:audit-api` use isolated metadata. Lifecycle I/O in the audit API test
is synthetic; real Docker/Compose and quota tests remain explicit Linux-only tests.
