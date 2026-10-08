#!/usr/bin/env bash
set -e
# Portable Linux setup: Ubuntu 26 / Debian / Fedora / RHEL / Arch / openSUSE / Alpine
# Only hard requirement is Docker. Backend itself runs in Docker, so host Node is optional.
if [ "$EUID" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi

msg() { echo "==> $*"; }

# 1. base tools per distro
if command -v apt-get >/dev/null; then
  msg "apt detected"
  apt-get update
  apt-get install -y git curl ca-certificates
elif command -v dnf >/dev/null; then
  msg "dnf detected"
  dnf install -y git curl ca-certificates
elif command -v yum >/dev/null; then
  msg "yum detected"
  yum install -y git curl ca-certificates
elif command -v pacman >/dev/null; then
  msg "pacman detected"
  pacman -Sy --noconfirm git curl ca-certificates
elif command -v zypper >/dev/null; then
  msg "zypper detected"
  zypper install -y git curl ca-certificates
elif command -v apk >/dev/null; then
  msg "apk detected"
  apk add git curl ca-certificates
else
  echo "unknown package manager - install git/curl manually"; 
fi

# 2. Docker (works on any distro incl. Ubuntu 26)
if ! command -v docker >/dev/null; then
  msg "installing docker via get.docker.com"
  curl -fsSL https://get.docker.com | sh
fi

# 3. compose v2 check, fallback to standalone binary
if docker compose version >/dev/null 2>&1; then
  msg "docker compose v2 ok"
elif command -v docker-compose >/dev/null; then
  msg "docker-compose v1 found, will use COMPOSE_BIN=docker-compose"
else
  msg "installing docker-compose-plugin"
  if command -v apt-get >/dev/null; then apt-get install -y docker-compose-plugin || true
  elif command -v dnf >/dev/null; then dnf install -y docker-compose-plugin || true
  elif command -v pacman >/dev/null; then pacman -S --noconfirm docker-compose || true
  fi
fi

# 3b. database admin UI images (keep in sync with backend/lib/db-tools.js TOOLS).
# Backgrounded by design: the installer must return fast so the panel can
# launch. A fresh/small server should not pull gigabytes synchronously.
# Reruns never contact the registry for images already present; upgrades
# are an explicit action in the panel.
mkdir -p /usr/local/lib/minipass
cat > /usr/local/lib/minipass/pull-db-images.sh <<'SCRIPT'
#!/usr/bin/env bash
# Single-flight background pull: skip when another pull is already running.
if command -v flock >/dev/null 2>&1; then
  exec 9> /tmp/minipass-db-images.lock
  flock -n 9 || exit 0
fi
for img in 'dpage/pgadmin4:9.18.0' 'phpmyadmin:5.2.3-apache' 'mongo-express:1.0.2-20-alpine3.19' 'rediscommander/redis-commander:latest'; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "already installed: $img"
  else
    echo "installing database admin image: $img"
    docker pull "$img" || echo "failed (will retry on next install/upgrade): $img"
  fi
done
SCRIPT
chmod +x /usr/local/lib/minipass/pull-db-images.sh
DBIMG_LOG="/var/log/minipass-db-images.log"
if ! touch "$DBIMG_LOG" 2>/dev/null; then
  mkdir -p /srv/panel-data
  DBIMG_LOG="/srv/panel-data/db-images.log"
  touch "$DBIMG_LOG" 2>/dev/null || DBIMG_LOG="/tmp/minipass-db-images.log"
fi
if command -v pgrep >/dev/null 2>&1 && pgrep -f pull-db-images.sh >/dev/null 2>&1; then
  msg "database admin image download already running in background (log: $DBIMG_LOG)"
else
  nohup /usr/local/lib/minipass/pull-db-images.sh >>"$DBIMG_LOG" 2>&1 &
  msg "basic install continues now; database admin images download in background (log: $DBIMG_LOG)"
fi

# 4. optional host Node (only for running backend without docker). Pass --with-node.
if [ "$1" = "--with-node" ]; then
  if ! command -v node >/dev/null; then
    msg "installing node 20"
    if command -v apt-get >/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs || apt-get install -y nodejs
    elif command -v dnf >/dev/null; then dnf module install -y nodejs:20/common || dnf install -y nodejs
    elif command -v pacman >/dev/null; then pacman -S --noconfirm nodejs npm
    elif command -v zypper >/dev/null; then zypper install -y nodejs20 npm
    elif command -v apk >/dev/null; then apk add nodejs npm
    fi
  fi
else
  msg "skipping host node (backend runs in docker). Use --with-node to add it."
fi

# 5. dirs + firewall (whichever exists)
# The panel has an admin password gate, but :3001 must still never face the
# open internet: it can start/stop containers and open terminals. Default is
# private LAN ranges only; override with e.g. PANEL_CIDR="203.0.113.7" or
# APPS_CIDR="0.0.0.0/0" (public apps, still keeps the panel private).
# NOTE: mongo-express ships with no login, and DB UI ports sit inside the app
# range - keep APPS_CIDR private unless every exposed app is meant to be public.
mkdir -p /srv/apps /srv/panel-data /opt/minipaas
# Install/update the host quota bridge and prepare supported quota mounts.
# Missing ext4 feature flags on a mounted root need ONE offline setup first.
# Never tune/reformat a mounted device or reboot from the installer.
INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$INSTALL_DIR/host/install-storage.sh" || msg "storage quota setup pending - review installer output"
PANEL_CIDR="${PANEL_CIDR:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"
APPS_CIDR="${APPS_CIDR:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"
if command -v ufw >/dev/null; then
  ufw allow 22/tcp || true
  # converge reruns: drop the old blanket rules before adding scoped ones
  ufw delete allow 3001/tcp || true
  ufw delete allow 8000:9000/tcp || true
  # shellcheck disable=SC2086
  for net in $PANEL_CIDR; do ufw allow from "$net" to any port 3001 || true; done
  # shellcheck disable=SC2086
  for net in $APPS_CIDR; do ufw allow from "$net" to any port 8000:9000 || true; done
  yes | ufw enable || true
elif command -v firewall-cmd >/dev/null; then
  firewall-cmd --permanent --remove-port=3001/tcp || true; firewall-cmd --permanent --remove-port=8000-9000/tcp || true
  # shellcheck disable=SC2086
  for net in $PANEL_CIDR; do firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$net port port=3001 protocol=tcp accept" || true; done
  # shellcheck disable=SC2086
  for net in $APPS_CIDR; do firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$net port port=8000-9000 protocol=tcp accept" || true; done
  firewall-cmd --reload || true
else
  msg "no ufw/firewalld - restrict TCP 3001 to your LAN/admin IP manually if needed"
fi

# 6. self-upgrade applier: the panel only BUILDS + flags (.pending-restart).
#    The recreate must run from OUTSIDE the container - a container that
#    `up -d`s itself gets SIGKILLed mid-recreate and never comes back.
if ! command -v crontab >/dev/null; then
  msg "installing cron"
  if command -v apt-get >/dev/null; then apt-get install -y cron || true
  elif command -v dnf >/dev/null; then dnf install -y cronie || true
  elif command -v yum >/dev/null; then yum install -y cronie || true
  elif command -v pacman >/dev/null; then pacman -S --noconfirm cronie || true
  elif command -v zypper >/dev/null; then zypper install -y cron || true
  fi
  if command -v systemctl >/dev/null; then systemctl enable --now cron 2>/dev/null || systemctl enable --now crond 2>/dev/null || true
  elif command -v service >/dev/null; then service cron start 2>/dev/null || service crond start 2>/dev/null || true
  fi
fi
if command -v crontab >/dev/null; then
  CRON="* * * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin cd /opt/minipass && [ -f .pending-restart ] && bash host/apply-upgrade.sh >> upgrade.log 2>&1"
  # NOTE: every stage carries `|| true` - under `set -e`, a bare
  # `crontab -l | grep -v` on an empty crontab kills the subshell before echo runs,
  # installing a headers-only (empty) crontab. That exact bug shipped once.
  TMP_CRON=$(mktemp)
  { crontab -l 2>/dev/null || true; } | grep -v 'pending-restart' > "$TMP_CRON" || true
  echo "$CRON" >> "$TMP_CRON"
  crontab "$TMP_CRON"
  rm -f "$TMP_CRON"
  if crontab -l 2>/dev/null | grep -q 'pending-restart'; then msg "upgrade cron installed + verified"
  else msg "WARNING: cron entry did not stick - upgrades need manual 'docker compose up -d'"; fi
else
  msg "no crontab available - panel self-upgrade needs manual 'docker compose up -d'"
fi

# 7. start docker (systemd or openrc/service)
if command -v systemctl >/dev/null; then systemctl enable --now docker || true
elif command -v service >/dev/null; then service docker start || true
elif command -v rc-service >/dev/null; then rc-service docker start || true
fi

docker --version
docker compose version || docker-compose --version || echo "compose missing - install docker-compose-plugin"
echo "done. copy minipaas to /opt/minipaas, then: cd /opt/minipaas && docker compose up -d --build"
echo "UI on http://SERVER_IP:3001, apps in /srv/apps"
