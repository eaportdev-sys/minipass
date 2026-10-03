#!/usr/bin/env bash
# kept for backwards compat - delegates to portable installer
exec bash "$(dirname "$0")/install-linux.sh" "$@"
