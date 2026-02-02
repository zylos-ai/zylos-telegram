#!/bin/bash
# zylos-telegram uninstall script
# Usage: uninstall.sh [--purge]

set -e

SKILL_DIR="$HOME/.claude/skills/telegram"
DATA_DIR="$HOME/zylos/components/telegram"
PURGE=false

[[ "$1" == "--purge" ]] && PURGE=true

echo "=== Uninstalling zylos-telegram ==="

# 1. Stop PM2 service
pm2 stop zylos-telegram 2>/dev/null || true
pm2 delete zylos-telegram 2>/dev/null || true
pm2 save

# 2. Remove skill directory
rm -rf "$SKILL_DIR"
echo "Removed skill directory"

# 3. Optionally remove data
if $PURGE; then
  rm -rf "$DATA_DIR"
  echo "Removed data directory"
else
  echo "Data preserved: $DATA_DIR"
fi

echo "=== Uninstall complete ==="
