const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-telegram',
    script: 'src/bot.js',
    cwd: path.join(os.homedir(), '.claude/skills/telegram'),
    env: {
      NODE_ENV: 'production'
    },
    // Restart on failure
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // Logs managed by PM2
    error_file: path.join(os.homedir(), 'zylos/components/telegram/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/telegram/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
