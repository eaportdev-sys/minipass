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
  **Redeploy** pulls the repo first (recovery path for broken box edits);
  **local rebuild** skips the pull and builds the box files as-is.
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
  install-linux.sh    # idempotent Linux provisioner (docker, firewall, cron, quotas; DB admin images pull in background)
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

Windows can exercise the UI and read-only API. Creating new sites with enforced
storage allowances requires the Linux host quota bridge; unsupported hosts fail
closed rather than saving an unenforced limit. To test the API on a throwaway port:

```powershell
$env:PORT='31xx'
$p = Start-Process node -ArgumentList 'server.js' -WorkingDirectory '.\backend' -PassThru
Start-Sleep 5
# ... exercise endpoints ...
Stop-Process -Id $p.Id -Force
```

## Quickstart — Linux host (Ubuntu, `/opt/minipass`)
One block, run on the server. The repo is private: use your GitHub username and
a PAT (Settings → Developer settings → Personal access tokens, `repo` scope) at
the password prompt. The installer adds you to the `docker` group, pulls DB
admin images in the background, and starts the panel itself on a blank host.
```bash
git clone https://github.com/eaportdev-sys/minipass.git ~/minipass
sudo mv ~/minipass /opt/minipass
sudo chown -R $USER:$USER /opt/minipass
cd /opt/minipass
sudo bash install-linux.sh
# if docker says permission denied: log out/in once (or: newgrp docker)
# open http://SERVER_IP:3001 and set the admin password
```

Per-app: `cd /srv/apps/<id> && docker compose ps | docker compose logs --tail=30`.
Panel logs: `docker logs minipass-panel-1 --tail=30`.
Site metadata lives on the `/srv/panel-data` volume — never inside the container.

## Manual

### 1 · Create a site

Websites → `+ Create` → name, type (or auto-detect), optional repo/branch/subfolder,
optional database, and **storage allowance in GB** (5/20/200 presets or a manually
typed amount, including decimals). GitHub detection shows an approximate source
size for the selected branch; truncated trees are labeled as a lower bound. This
excludes Git history, LFS downloads, dependencies, build output and database growth,
so it is not a recommended quota or a predicted final disk requirement.
The panel scaffolds `/srv/apps/<id>/` (`code/`, `.env`,
`docker-compose.yml`) and builds in the background.

Jekyll repositories (`Gemfile` + `_config.yml` and Jekyll markers) are detected as
**Static**, including those with a Webpack `package.json`. Their standard build
uses Ruby 3.3 + Node 24, then nginx serves `_site/` (or the declared destination).
Declared Node/Ruby versions are shown, not silently downgraded to obsolete runtimes.
For legacy builds, **Modernize legacy build dependencies** explicitly replaces
direct `node-sass` with Sass, updates old Webpack 5, and refreshes Ruby gems within
Gemfile constraints **inside the build stage only**. Repository manifests and
lockfiles remain unchanged; custom Dockerfiles are never replaced. This is a
bounded compatibility adapter, not a guarantee for every old dependency or plugin.
Explicit `node-sass` CLI scripts require a repository migration first.
Previously misclassified sites can use **Setup → Use Jekyll static build**, then
redeploy. Plain HTML sites and the other standard templates are unchanged.

**Overview → Storage allowance** leads with the enforced limit, aggregate used
space and remaining allowance. **Site files + managed database data share one
ext4 project quota**. Managed database named volumes use local-driver binds into
the site's `.dbdata/` directory. Quotas apply to root-owned/database writes too;
full sites receive a disk-quota error, so choose sufficient room for DB operations.
Container writable layers/logs, shared images, downloaded base images and build
cache are **outside** that quota and need host-wide headroom. Existing sites and
their volumes are not migrated automatically; they remain labeled as legacy with
no enforced allowance. Renaming into Trash keeps the project assignment and
budget until permanent cleanup removes all files/volumes and open inodes.

Creation checks unallocated capacity after outstanding site/Trash allowances and
a 2 GiB host reserve. Allowances are maximums and metadata reservations, not
preallocated space; other host/Docker writes can still exhaust the filesystem.
Only aggregate kernel quota/statfs/Docker metadata is measured, on demand; no
file contents or usage history are collected, and no list/status polling is added.

#### Linux quota setup (install + upgrades)

`sudo bash install-linux.sh` installs the root-only **minipass-storage** systemd
bridge and prepares supported ext4 quota mounts. New installs and the updated
host upgrade cron rerun this setup idempotently. **Existing installations must
rerun the installer once** to install the service and replace the old cron entry.
The panel talks over `/srv/panel-data/storage-quotas.sock` (0600); it is not made
privileged and never gets host block devices. Preserve/backup
`/srv/panel-data/storage-quota-state.json` alongside panel metadata.

#### Disk sizing (system vs storage)

Minipass is designed for a dedicated VM/standalone host with one disk split in two:

| Disk | System — root LV | Site storage (`/srv/apps`) | Example fit |
| --- | --- | --- | --- |
| 40 GB min | 30 GB | ~10 GB | one small site + Trash |
| 100 GB | 50 GB | ~50 GB | e.g. four 10 GB sites |
| 200 GB+ | 50 GB | rest | scale site count/size to taste |

System covers Ubuntu, Docker, the panel image, all container images, build
cache and logs — container images and build cache stay on the system disk by
design. Site storage covers per-site files + managed database data under one
enforced allowance each, plus 48-hour Trash retention and a 2 GiB host reserve.

Fresh-install recipe (single disk): in the Ubuntu installer's custom storage
layout, give root a fixed LV (e.g. 50 GB of 100 GB) and **leave the rest
unallocated in the VG**. The minipass installer then creates the storage volume
from the free extents with quota features baked in at format time, mounts
`/srv/apps` (fstab backup retained), migrates any existing site files, and
enables enforcement — no rescue session, no reboot dance. A spare
partition or whole disk works the same way if one is attached later. If
containers are running and site files exist, the installer stops short and says
so instead of moving data under live containers — stop sites/panel and rerun.

If the whole disk went to root with no free space, the installer reports the
shortfall and changes nothing: sites keep working with honestly-unenforced
allowances until space is provided. Last resort on a fully-allocated single
disk is enabling quota features from a rescue environment with the root device
**unmounted**:

```bash
sudo python3 prepare-storage.py --offline /dev/your-ext4-device
```

This checks the device and filesystem before/after enabling features; it never
formats, partitions, resizes or forces repairs, and refuses mounted devices.
Boot normally, rerun the installer to add `prjquota` to the matching `/etc/fstab`
entry (backup retained), and reboot during maintenance if requested. No automatic
reboot or live root remount happens. Unsupported/unready hosts still allow site
creation, but the requested allowance is recorded as NOT enforced (Overview
says so plainly) until quota setup completes; an entered number is never
advertised as enforcement by itself.

On a prepared Ubuntu host, explicitly verify root and database-container hard
limits, Trash retention and cleanup with synthetic temporary files:

```bash
sudo python3 host/quota-smoke.py
```

Requires 0.1 GB available allowance and cached `redis:7-alpine`; does not pull
images or inspect customer data. Portable logic tests: `python host/storage-quotas.test.py`.

Deleted sites remain in **Trash for 48 hours**. Destroy, Empty trash, and the
expiry worker use the same awaited cleanup: original Compose project containers,
managed database volumes/networks, site-built images (including recorded older
versions), and the site directory. Permanent cleanup also prunes **all unused
Docker build cache**, so other sites may rebuild more slowly. Shared/tagged
images still needed elsewhere, the panel image, and cached database/admin images
are preserved; shared layers are not exclusive site data. No system/image/volume
prune runs. The expiry worker checks every minute while the panel is running;
startup retries expired entries. Docker/filesystem failures keep the entry with
a visible error and retry action instead of reporting success. Once destructive
cleanup starts, Restore is disabled. A name held in Trash cannot be reused.
Images orphaned by older releases whose Trash records were already erased are
not automatically guessed/deleted; those need separately scoped manual cleanup.

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

Public repos need no token at all: paste the repo URL and detection, clone, and
manual repo redeploys work unauthenticated. GitHub automation is deliberately
off when a site is created; enable it from Deploy only when webhook or polling
deploys are wanted. Enabling snapshots the current head first, so it never
redeploys the initial commit as a false change. For private repos, paste a
fine-grained token on the site (Contents read-only, Webhooks read+write).
Tokens stay server-side; the API never echoes them back.

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
  (box-local; commit it to the repo so fresh clones keep it). The React template
  serves either Vite `dist/` or CRA `build/` output.
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
The updated host cron also installs/refreshes quota support before recreation.
For a manual update, run `sudo bash host/install-storage.sh` from the updated
checkout before `docker compose -p minipass up -d --build`. Rerun the full
installer once on older installations to replace their legacy cron entry.

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
