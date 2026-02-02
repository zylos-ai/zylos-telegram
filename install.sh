#!/bin/bash
# zylos-telegram install script

set -e

SKILL_DIR="$HOME/.claude/skills/telegram"
DATA_DIR="$HOME/zylos/components/telegram"
ENV_FILE="$HOME/zylos/.env"

echo "=== Installing zylos-telegram ==="

# 1. Create data directories
mkdir -p "$DATA_DIR/media"
mkdir -p "$DATA_DIR/logs"

# 2. Install dependencies
cd "$SKILL_DIR"
npm install --production

# 3. Create default config (don't overwrite)
if [ ! -f "$DATA_DIR/config.json" ]; then
  cat > "$DATA_DIR/config.json" << 'EOF'
{
  "enabled": true,
  "owner": { "chat_id": null, "username": null, "bound_at": null },
  "whitelist": { "chat_ids": [], "usernames": [] },
  "smart_groups": [],
  "features": { "auto_split_messages": true, "max_message_length": 4000, "download_media": true }
}
EOF
  echo "Created default config.json"
fi

# 4. Check environment variables
if ! grep -q "TELEGRAM_BOT_TOKEN" "$ENV_FILE" 2>/dev/null; then
  echo ""
  echo "[!] Add TELEGRAM_BOT_TOKEN to $ENV_FILE"
fi

# 5. Start PM2 service
pm2 start "$SKILL_DIR/ecosystem.config.js"
pm2 save

echo ""
echo "=== Installation complete ==="
echo "Next: Add TELEGRAM_BOT_TOKEN to ~/zylos/.env and restart"
