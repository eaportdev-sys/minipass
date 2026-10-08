#!/usr/bin/env bash
# Called from HOST cron, never from the panel container it recreates.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
exec 9> .host-upgrade.lock
flock -n 9 || exit 0
[ -f .pending-restart ] || exit 0
# Pending offline quota setup is non-fatal to an upgrade. Creating a quota site
# stays disabled until the bridge can prove real enforcement.
bash host/install-storage.sh || echo 'Storage installer failed; inspect quota setup before creating new sites.'
GIT_SHA=$(cat .pending-restart) docker compose -p minipass up -d
rm -f .pending-restart .upgrade-lock
