# minipaas - lean hPanel alternative for Debian

Click -> pick type -> container + DB + .env -> git auto-deploy -> Cloudflare Tunnel -> web terminal.

## Layout
```
minipaas/
  apps/               # generated per app: /srv/apps on Debian, ./apps locally
  backend/            # Node API :3001 + static frontend
  templates/          # Dockerfile starters per type
  frontend/           # wizard UI
  docker-compose.yml  # panel + cloudflared
  install-debian.sh   # one-shot Debian setup
```

## Linux quickstart (any distro: Ubuntu 26 / Debian / Fedora / Arch / openSUSE)
```bash
git clone <this> /opt/minipaas && cd /opt/minipaas
sudo bash install-linux.sh
# optional host node (not needed if backend runs in docker):
# sudo bash install-linux.sh --with-node
# edit cloudflared token in docker-compose.yml, then:
docker compose up -d --build || docker-compose up -d --build
# open http://SERVER_IP:3001
# data in /srv/apps, metadata in backend/data.json
# override compose binary if needed: COMPOSE_BIN=docker-compose
```

## Flow you asked for
1. UI wizard: type (static/react/node/php) + repo URL + DB + domain
2. Backend copies `templates/<type>`, writes `.env` with generated passwords
3. `docker compose up --build -d` in `/srv/apps/<name>`
4. Git deploy: connect once (deploy key shown), then GitHub webhook `POST /webhook/<id>?token=...` auto pulls + rebuilds
5. Tunnel: `tunnel-add.sh <hostname> <container:port>` appends ingress to cloudflared config
6. Terminal: xterm.js in UI -> WS `/terminal?app=<name>` -> `docker exec -i`
