# minipass — self-hosted app platform

> **Release status: localhost testing only (v0.1).**
> This build is for running on your own machine or LAN while development
> continues. It has **no login/auth** — anyone who can reach port `3001` can
> run containers and open terminals via the panel. Do not expose it to the
> public internet yet. See [Security](#security).

## About

minipass turns a folder or git repo into a running site with one flow:

- Pick a type: **static, react, node, php** (+ multi-service sites, one folder → N services)
- Gets a container, local port (`8000+`), generated `.env`, optional database
- Deploy by pushing git **directly to the box over SSH** (works with no GitHub),
  or connect GitHub (webhook or polling) when available
- Atomic deploys: build first, swap only on success, health-check, auto-rollback
- Extras: per-site terminal, file manager, environment editor, on-demand
  database UIs (pgAdmin, phpMyAdmin, mongo-express, Redis Commander)

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

Paste a fine-grained token on the site (Contents read-only, Webhooks read+write),
pick a repo, done — webhook auto-registers when the panel is reachable, otherwise
turn on polling (every 1/5/15 min). Tokens stay server-side; the API never echoes
them back.

### 4 · Environment, files, databases

- **Environment tab**: generated keys are managed (read-only except `DOMAIN`);
  custom keys are fully editable. Every save redeploys.
- **Files tab**: lazy folder tree + reader/editor; uploads accept zip, files, or a folder.
- **Databases**: add from the site page; admin UIs launch on demand
  (ports `8900–8999`) and stop when you close the popup, with a 30-minute fallback.
- **Terminal tab**: full PTY in the browser (`docker exec` into the live container).

### 5 · Upgrade the panel

Upgrade page → **upgrade from git**: fetches `origin/main`, rebuilds the image in
the background, then a host cron job restarts from outside the container
(self-restart would kill its own runner mid-job). Watch the build log there;
running vs repo SHAs must match before trusting the UI version label.

## Security

- **No auth (known blocker).** Bind to `localhost` or firewall `3001` to trusted
  IPs only until an admin gate lands.
- Change `WEBHOOK_SECRET` in `backend/.env` (see `backend/.env.example`).
- Never commit `backend/.env`, `backend/data.json`, `apps/*/`, or `panel-key*`
  — all are gitignored for a reason.

## Known limitations (v0.1)

- `minipaas` vs `minipass` naming is still mixed in a few paths/strings.
- Cloudflare Tunnel wiring is a stub.
- No `LICENSE` — fixed: MIT, see [LICENSE](LICENSE).

## License

MIT — see [LICENSE](LICENSE).
