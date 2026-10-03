#!/usr/bin/env bash
# usage: tunnel-add.sh <hostname> <service>  e.g. tunnel-add.sh myapp.example.com http://myapp-app-1:3000
set -e
HOSTNAME=$1; SERVICE=$2
CFG=${TUNNEL_CONFIG:-/etc/cloudflared/config.yml}
if [ -z "$HOSTNAME" ] || [ -z "$SERVICE" ]; then echo "usage: tunnel-add.sh <hostname> <service>"; exit 1; fi
touch "$CFG"
# insert before catch-all if present, else append
if grep -q "service: http_status:404" "$CFG"; then
  sed -i "/service: http_status:404/i\  - hostname: $HOSTNAME\n    service: $SERVICE" "$CFG"
else
  printf "  - hostname: %s\n    service: %s\n" "$HOSTNAME" "$SERVICE" >> "$CFG"
fi
echo "added $HOSTNAME -> $SERVICE in $CFG (restart cloudflared)"
