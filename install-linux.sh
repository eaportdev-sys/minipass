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
mkdir -p /srv/apps /srv/panel-data /opt/minipaas
if command -v ufw >/dev/null; then
  ufw allow 22/tcp || true; ufw allow 3001/tcp || true; ufw allow 8000:9000/tcp || true; yes | ufw enable || true
elif command -v firewall-cmd >/dev/null; then
  firewall-cmd --permanent --add-port=3001/tcp || true; firewall-cmd --permanent --add-port=8000-9000/tcp || true; firewall-cmd --reload || true
else
  msg "no ufw/firewalld - open TCP 3001 manually if needed"
fi

# 6. self-upgrade applier: the panel only BUILDS + flags (.pending-restart).
#    The recreate must run from OUTSIDE the container - a container that
#    `up -d`s itself gets SIGKILLed mid-recreate and never comes back.
if command -v crontab >/dev/null; then
  CRON="* * * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin cd /opt/minipass && [ -f .pending-restart ] && GIT_SHA=\$(cat .pending-restart) docker compose -p minipass up -d >> upgrade.log 2>&1 && rm -f .pending-restart .upgrade-lock"
  (crontab -l 2>/dev/null | grep -v 'pending-restart'; echo "$CRON") | crontab -
  msg "upgrade cron installed"
else
  msg "no crontab - panel self-upgrade needs manual 'docker compose up -d'"
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
