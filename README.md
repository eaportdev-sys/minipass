# minipass — self-hosted app platform

> **Release status: localhost testing only (v0.1).**
> This build is for running on your own machine or LAN while development
> continues. It now has an admin-password gate, but treat it as one layer:
> keep port `3001` on localhost or your private LAN (the installer firewalls
> it to private ranges by default). Do not expose it to the public internet
> yet. See [Security](#security).

## About

minipass turns a folder or git repo into a running site with one flow:

- Pick a type: **static, react, node, php** (+ multi-service sites, one folder → N services)
- Gets a container, local port (`8000+`), generated `.env`, optional PostgreSQL,
  MySQL, MariaDB 11.8 LTS, MongoDB, or Redis database
- Deploy by pushing git **directly to the box over SSH** (works with no GitHub),
  or connect GitHub (webhook or polling) when available
- Atomic deploys: build first, swap only on success, health-check, auto-rollback.
  A taken host port is automatically rebound to the next free one before the build.
- Extras: per-site terminal, file manager, environment editor, on-demand
  database UIs (pgAdmin, phpMyAdmin for MySQL/MariaDB, mongo-express, Redis Commander)

No build step for the panel UI — plain HTML/JS/CSS. One Express API (`:3001`)
serves the frontend and shells Docker for app containers.

## Layout

```
minipass/
  apps/               # generated per-site dirs (./apps locally, /srv/apps on Linux)
  backend/            # Node API :3001 + static frontend
  backend/lib/        # generator, services, detect, github, ssh, db-tools
  templates/          # Dockerfile starters per type
  frontend/           # wizard UI (no build step)
  docker-compose.yml  # panel service (project name pinned: minipass)
  install-linux.sh    # idempotent Linux provisioner (docker, firewall, cron)
```

## Quickstart — localhost (Windows dev box)

Requirements: Node 20+, git. No Docker needed for the panel UI itself
(app containers only build/run where Docker exists).

```powershell
cd minipaas\backend
npm install
$env:PORT='3001'
node server.js
# open http://localhost:3001
```

Create a site in the UI (`+ Create`), or test the API on a throwaway port:

```powershell
$env:PORT='31xx'
$p = Start-Process node -ArgumentList 'server.js' -WorkingDirectory '.\backend' -PassThru
Start-Sleep 5
# ... exercise endpoints ...
Stop-Process -Id $p.Id -Force
```

## Quickstart — Linux host (Ubuntu, `/opt/minipass`)
```bash
git clone <this-repo> /opt/minipass && cd /opt/minipass
sudo bash install-linux.sh
GIT_SHA=$(git rev-parse --short HEAD) docker compose -p minipass up -d --build
# open http://SERVER_IP:3001
```

Per-app: `cd /srv/apps/<id> && docker compose ps | docker compose logs --tail=30`.
Panel logs: `docker logs minipass-panel-1 --tail=30`.
Site metadata lives on the `/srv/panel-data` volume — never inside the container.

## Manual

### 1 · Create a site

Websites → `+ Create` → name, type (or auto-detect), optional repo/branch/subfolder,
optional database. The panel scaffolds `/srv/apps/<id>/` (`code/`, `.env`,
`docker-compose.yml`) and builds in the background.

### 2 · Push to deploy over SSH (no GitHub needed)

On the site's **Deploy** tab → *Push from your machine* → **enable local git push**.
On your machine, inside your repo:

```bash
git remote add minipass root@<panel-host>:/srv/apps/<id>/repo.git
git push minipass main   # or master
```

The hook builds an isolated checkout, so the GitHub working tree is untouched.
Each push records sha/branch in the deploy history; webhook/poll and local-push
sources each get their own status indicator.

### 3 · Or connect GitHub (optional)

Public repos need no token at all: paste the repo URL, detection + clone +
polling all work unauthenticated (webhook auto-register is the only thing a
token buys you there). For private repos, paste a fine-grained token on the
site (Contents read-only, Webhooks read+write),
pick a repo, done — webhook auto-registers when the panel is reachable, otherwise
turn on polling (every 1/5/15 min). Tokens stay server-side; the API never echoes
them back.

### 4 · Environment, files, databases

- **Environment tab**: generated keys are managed (read-only except `DOMAIN`);
  custom keys are fully editable and save pending a redeploy. The panel privately
  snapshots each service's `.env`/`.env.example` when first discovered;
  **Load defaults** restores missing keys from that stable snapshot. It maps localhost frontend/API
  URLs to the correct published service and replaces JWT/session-style secret
  placeholders with cryptographically random values. Repository files, existing
  custom remote URLs, and external credentials are never changed. A one-shot
  **Generate secret** box (base64url, hex, base64, UUID) fills any editable row
  or the new-variable field; the variable list scrolls past ~10 rows.
- **Files tab**: lazy folder tree + reader/editor; uploads accept zip, files, or a folder.
- **Databases**: add from the site page; admin UIs launch on demand
  (ports `8900–8999`) and stop when you close the popup, with a 30-minute fallback.
- **Terminal tab**: full PTY in the browser (`docker exec` into the live container).
- **Services**: each runnable folder becomes a service. If a folder lacks a
  Dockerfile and the type has no safe default, the panel says so instead of
  guessing — during create or Add service, click **use standard Dockerfile**
  to drop in the type template
  (box-local; commit it to the repo so fresh clones keep it).
  Published service links scan bounded source files for direct routes such as
  `app.get('/health')`, then verify likely health/API/docs paths at runtime.
- **Migrations**: Deploy tab → pre-deploy migration. Detection recognizes
  project scripts, Knex, Prisma, Sequelize, TypeORM, Drizzle, MikroORM, Django,
  Alembic, Laravel, Doctrine, Rails, Flyway, Liquibase, dbmate, EF Core, and raw
  SQL folders. It maps each project to the enabled service whose build context
  contains it, then calculates **Folder relative to that container**. For
  example, a `server` service built from `code/server` uses an empty Folder;
  an `app` service built from `code/` uses Folder `server`. Select a detected
  runner to fill the service, folder, command, and verification command.
  Ambiguous systems such as TypeORM without a declared script and raw SQL
  without a database client are reported but never guessed.
  The command runs after build in a one-off container with the site `.env`
  (so `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` resolve); failure aborts
  before the swap and running containers are untouched. **Run now** / **verify**
  execute the same way without deploying anything — they use whatever is in
  the boxes right now, so ad-hoc flows like `npm run db:init -- --db=newdbname`
  (or a `DB_NAME=other` prefix override) run without touching saved settings.

### 5 · Upgrade the panel
Upgrade page → **upgrade from git**: fetches `origin/main`, rebuilds the image in
the background, then a host cron job restarts from outside the container
(self-restart would kill its own runner mid-job). Watch the build log there;
running vs repo SHAs must match before trusting the UI version label.

## Security

- **Admin gate.** First visit shows a one-time setup: choose a 12+ character
  admin password (scrypt-hashed, `panel-auth.json` next to the data file —
  gitignored, kept on the `/srv/panel-data` volume). All `/api/*` routes and
  the web terminal need the session cookie after that. GitHub push webhooks
  stay open by design — each carries its own per-app token. Rotate under
  Upgrade → Maintenance.
- **Firewall.** `install-linux.sh` opens SSH + panel `:3001` + app ports
  `8000–9000` to **private LAN ranges only** (`10/8`, `172.16/12`,
  `192.168/16`). Override with `PANEL_CIDR` / `APPS_CIDR` when rerunning.
  Never expose `:3001` to the open internet in this build. DB admin UIs live
  inside the app range and some (mongo-express) have no login — keep that
  range private too.
- Change `WEBHOOK_SECRET` in `backend/.env` (see `backend/.env.example`).
- Never commit `backend/.env`, `backend/data.json`, `panel-auth.json`,
  `apps/*/`, or `panel-key*` — all are gitignored for a reason.

## Backups

- **Site:** site page → Files tab → *Backups* → download `.tar.gz`
  (code, `.env`, compose files, local git remote; `node_modules` excluded).
- **Database:** Setup → Attach databases → **dump** on any running database
  card (`.sql` for PostgreSQL/MySQL/MariaDB, `.archive` for MongoDB, `.rdb` for Redis).
- Restore is manual (extract / import, then rescan) and copies must live
  **off this box**. Until automated backups exist: you operate it, you back it up.

## Operator terms

Creating the admin password records acceptance of the in-app operator terms
(read them anytime via Terms in the sidebar): you operate the panel, you are
responsible for the content and behavior of everything you deploy, database
engines run under their own upstream licenses, and this testing build carries
no warranty.

## Third-party licenses

Panel code is MIT. Shipped alongside it: Node.js/Alpine + nginx + PHP base
images, `express/cors/multer/ws` (MIT), xterm.js (MIT, CDN-pinned), pgAdmin,
phpMyAdmin (GPL-2.0), mongo-express/redis-commander (MIT), and database images
PostgreSQL (permissive), Redis 7 (BSD), MySQL 8 and MariaDB 11.8
(**GPL-2.0**), MongoDB 7
(**SSPL** — not OSI open source). Commercial users should clear MySQL/MongoDB
for their own use case.

## Known limitations (v0.1)

- `minipaas` vs `minipass` naming is still mixed in a few paths/strings —
  rename decision still open (note: `minipass` collides with a popular npm
  package of the same name).
- Cloudflare Tunnel wiring is a stub.
- Backups are download-only; restore is manual.

## License

MIT — see [LICENSE](LICENSE). The license covers the code (copyright) only.

## Trademark

**minipass™** and its logos are trademarks of eaportdev-sys — forks must
rebrand, see [TRADEMARK.md](TRADEMARK.md).
