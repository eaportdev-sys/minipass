#!/usr/bin/env bash
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then echo 'Storage setup needs root on the host.'; exit 1; fi
if ! command -v python3 >/dev/null || ! command -v tune2fs >/dev/null || ! command -v findmnt >/dev/null || ! command -v parted >/dev/null; then
  if command -v apt-get >/dev/null; then apt-get install -y python3 e2fsprogs util-linux parted
  elif command -v dnf >/dev/null; then dnf install -y python3 e2fsprogs util-linux parted
  elif command -v yum >/dev/null; then yum install -y python3 e2fsprogs util-linux parted
  elif command -v pacman >/dev/null; then pacman -S --needed --noconfirm python e2fsprogs util-linux parted
  elif command -v zypper >/dev/null; then zypper install -y python3 e2fsprogs util-linux parted
  elif command -v apk >/dev/null; then apk add python3 e2fsprogs util-linux parted
  fi
fi
if ! command -v python3 >/dev/null || ! command -v systemctl >/dev/null; then
  echo 'Storage quotas need Python 3 and a systemd Linux host. No limits will be advertised as enforced.'
  exit 0
fi
mkdir -p /usr/local/lib/minipass /srv/panel-data /srv/apps
install -m 0644 "$HERE/storage-quotas.py" /usr/local/lib/minipass/storage-quotas.py
python3 "$HERE/prepare-storage.py" || echo 'Storage setup pending: review host filesystem configuration.'
cat > /etc/systemd/system/minipass-storage.service <<'UNIT'
[Unit]
Description=Minipass root-only site storage quota bridge
After=local-fs.target
Before=docker.service
[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/lib/minipass/storage-quotas.py
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable minipass-storage.service
systemctl restart minipass-storage.service
