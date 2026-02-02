#!/bin/bash
# zylos-telegram upgrade script

set -e

SKILL_DIR="$HOME/.claude/skills/telegram"

echo "=== Upgrading zylos-telegram ==="

# 1. Pull latest code
cd "$SKILL_DIR"
git pull

# 2. Update dependencies
npm install --production

# 3. Restart service
pm2 restart zylos-telegram

echo "=== Upgrade complete ==="
