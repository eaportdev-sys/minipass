#!/usr/bin/env bash
# Called from HOST cron, never from the panel container it recreates.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
exec 9> .host-upgrade.lock
flock -n 9 || exit 0
[ -f .pending-restart ] || exit 0
# Never recreate the panel mid-deploy: site deploys drop a marker on the
# shared data volume, and an upgrade restart would orphan them with a stale
# status. A fresh marker defers the restart to the next minute; stale ones
# (killed panel) are ignored and cleaned up.
for m in /srv/panel-data/.deploy-*; do
  [ -e "$m" ] || continue
  age=$(( $(date +%s) - $(stat -c %Y "$m" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 1800 ]; then echo "site deploy active ($(basename "$m")) - upgrade deferred"; exit 0; fi
  rm -f "$m"
done
# Pending offline quota setup is non-fatal to an upgrade. Creating a quota site
# stays disabled until the bridge can prove real enforcement.
bash host/install-storage.sh || echo 'Storage installer failed; inspect quota setup before creating new sites.'
GIT_SHA=$(cat .pending-restart) docker compose -p minipass up -d
rm -f .pending-restart .upgrade-lock
