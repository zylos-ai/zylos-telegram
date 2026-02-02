# zylos-telegram 详细设计文档

**版本**: v1.0 Draft
**日期**: 2026-02-02
**作者**: Zylos10
**仓库**: https://github.com/zylos-ai/zylos-telegram
**状态**: 待 Review

---

## 一、概述

### 1.1 组件定位

zylos-telegram 是 Zylos0 的核心通讯组件，负责通过 Telegram Bot API 实现用户与 Claude Agent 的双向消息交互。

| 属性 | 值 |
|------|-----|
| 类型 | 通讯组件 (Communication) |
| 优先级 | P0 |
| 依赖 | C4 Communication Bridge |
| 基础代码 | zylos-infra/telegram-bot (~80% 复用) |

### 1.2 核心功能

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 私聊消息接收 | 接收授权用户的私聊消息 | P0 |
| 消息发送 | 通过 C4 发送消息到指定用户 | P0 |
| Owner 自动绑定 | 首个用户自动成为管理员 | P0 |
| 用户白名单 | 限制只有授权用户可使用 | P0 |
| 群聊 @mention | 接收群聊中 @bot 的消息 | P1 |
| Smart Groups | 接收指定群的所有消息 | P1 |
| 图片接收 | 下载并传递图片路径给 Claude | P1 |
| 文件接收 | 下载并传递文件路径给 Claude | P2 |
| 长消息分段 | 自动拆分超长回复 | P1 |

### 1.3 不包含的功能

- 语音消息处理 (由 voice 组件负责)
- 视频处理
- 内联查询 (Inline Query)
- 支付功能

---

## 二、目录结构

### 2.1 Skills 目录 (代码)

```
~/.claude/skills/telegram/
├── SKILL.md              # 组件说明文档
├── install.sh            # 安装脚本
├── uninstall.sh          # 卸载脚本
├── upgrade.sh            # 升级脚本
├── package.json          # 依赖定义
├── ecosystem.config.js   # PM2 配置
└── src/
    ├── bot.js            # 主程序入口
    ├── send.sh           # C4 标准发送接口 (支持文本和媒体)
    └── lib/
        ├── config.js     # 配置加载模块
        ├── auth.js       # 认证模块 (白名单 + Product Key)
        └── media.js      # 媒体处理模块
```

### 2.2 Data 目录 (数据)

```
~/zylos/components/telegram/
├── config.json           # 运行时配置
├── media/                # 媒体文件存储 (图片、文件等)
└── logs/                 # 日志目录 (PM2 管理)
```

---

## 三、架构设计

### 3.1 组件架构图

```
┌─────────────────────────────────────────────────────────┐
│                    zylos-telegram                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │   bot.js     │───▶│   auth.js    │                   │
│  │  (Telegraf)  │    │ 白名单+Key   │                   │
│  └──────┬───────┘    └──────────────┘                   │
│         │                                                │
│         │ 消息接收                                       │
│         ▼                                                │
│  ┌──────────────┐                                       │
│  │   media.js   │  下载媒体到本地                        │
│  └──────┬───────┘                                       │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────────────────────┐                   │
│  │ c4-receive (~/zylos/core/)       │ → C4 Bridge       │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌──────────────┐                                       │
│  │   send.sh    │  ← C4 调用发送消息                    │
│  └──────────────┘                                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| 主程序 | bot.js | Telegraf 初始化、事件监听、消息格式化、调用 c4-receive |
| 配置 | lib/config.js | 加载 .env + config.json |
| 认证 | lib/auth.js | Owner 绑定 + 白名单验证 |
| 媒体 | lib/media.js | 下载图片/文件到本地 |
| 发送 | send.sh | C4 标准接口，发送文本和媒体 |

---

## 四、C4 集成

### 4.1 接收流程 (Telegram → Claude)

```
用户发送消息
     │
     ▼
┌─────────────┐
│  bot.js     │  监听 Telegram API
└─────┬───────┘
      │ 1. 白名单验证
      │ 2. Product Key 验证 (首次用户)
      ▼
┌─────────────┐
│ message.js  │  格式化消息
└─────┬───────┘
      │ 格式: "[TG DM] username said: 消息内容"
      │       "[TG GROUP:groupname] username said: 消息内容"
      ▼
┌─────────────┐
│ c4-receive  │  C4 Bridge 接口
└─────┬───────┘
      │ --source telegram
      │ --endpoint <chat_id>
      │ --content "..."
      ▼
┌─────────────┐
│   Claude    │  处理消息
└─────────────┘
```

### 4.2 发送流程 (Claude → Telegram)

```
Claude 需要回复
      │
      ▼
┌─────────────┐
│  c4-send    │  C4 Bridge
└─────┬───────┘
      │ c4-send telegram <chat_id> "消息内容"
      ▼
┌─────────────────────────────────────┐
│ ~/.claude/skills/telegram/src/send.sh │
└─────┬───────────────────────────────┘
      │ 1. 解析参数
      │ 2. 检查媒体前缀 [MEDIA:type]
      │ 3. 长消息自动分段
      │ 4. 调用 Telegram API
      ▼
┌─────────────┐
│ Telegram    │  用户收到消息
└─────────────┘
```

### 4.3 send.sh 接口规范

```bash
# 位置: ~/.claude/skills/telegram/src/send.sh
# 调用: send.sh <chat_id> <message>
# 返回: 0 成功, 非 0 失败

# 示例 - 纯文本
send.sh "8101553026" "Hello, this is a test message"

# 示例 - 发送图片
send.sh "8101553026" "[MEDIA:image]/path/to/photo.jpg"

# 示例 - 发送文件
send.sh "8101553026" "[MEDIA:file]/path/to/document.pdf"
```

### 4.4 消息格式规范

**接收消息格式:**

```
# 私聊
[TG DM] howardzhou said: 你好

# 群聊 @mention
[TG GROUP:研发群] howardzhou said: @bot 帮我查一下

# 带图片
[TG DM] howardzhou said: [发了一张图片] 这是什么 ---- file: ~/zylos/components/telegram/media/photos/xxx.jpg
```

**路由信息 (由 c4-receive 追加):**

```
---- reply via: c4-send telegram "8101553026"
```

---

## 五、配置设计

### 5.1 config.json 结构

```json
{
  "enabled": true,

  "owner": {
    "chat_id": null,
    "username": null,
    "bound_at": null
  },

  "whitelist": {
    "chat_ids": [],
    "usernames": []
  },

  "smart_groups": [
    {
      "chat_id": "-100123456789",
      "name": "研发群"
    }
  ],

  "features": {
    "auto_split_messages": true,
    "max_message_length": 4000,
    "download_media": true
  }
}
```

### 5.2 配置说明

| 字段 | 类型 | 说明 |
|------|------|------|
| enabled | boolean | 组件启用开关 |
| owner.chat_id | string | 管理员 chat_id (首次交互自动绑定) |
| owner.username | string | 管理员用户名 |
| owner.bound_at | string | 绑定时间 |
| whitelist.chat_ids | string[] | 允许的 Telegram chat_id 列表 |
| whitelist.usernames | string[] | 允许的 Telegram 用户名列表 |
| smart_groups | object[] | 监听所有消息的群组 (chat_id + name) |
| features.auto_split_messages | boolean | 自动分段长消息 |
| features.max_message_length | number | 单条消息最大长度 |
| features.download_media | boolean | 是否下载媒体文件 |

### 5.3 环境变量 (~/zylos/.env)

```bash
# Telegram Bot Token (必须)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# 代理地址 (可选，中国大陆需要)
TELEGRAM_PROXY_URL=http://192.168.3.9:7890
```

**说明:** 密钥和代理统一在 .env 中配置，不在 config.json 中重复。

---

## 六、安全设计

### 6.1 Owner 自动绑定

**设计原则**: 第一个与 Bot 交互的用户自动成为 Owner (管理员)

```
用户发送 /start
      │
      ▼
┌─────────────────┐
│ 检查 owner      │
│ 是否为空?       │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
   空        非空
    │         │
    ▼         ▼
绑定为 owner   走普通验证流程
保存 config
回复 "您已成为管理员"
```

**绑定时记录**:
- chat_id (Telegram API 自动获取，唯一)
- username (如有)
- bound_at (绑定时间)

### 6.2 用户验证流程

```
用户发送消息
      │
      ▼
┌─────────────────┐
│ 是 owner?       │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
   Yes       No
    │         │
    ▼         ▼
  放行    ┌─────────────────┐
         │ 在白名单中?      │
         └────────┬────────┘
                  │
             ┌────┴────┐
             │         │
            Yes       No
             │         │
             ▼         ▼
           放行      拒绝
                   "Bot is private"
```

### 6.3 Owner 权限

Owner 拥有特殊权限:
- 添加/移除白名单用户 (通过命令)
- 查看 Bot 状态
- 未来可扩展更多管理功能

### 6.4 安全日志

所有未授权访问记录到 `logs/access.log`:

```
2026-02-02T10:30:45Z [BLOCKED] chat_id=123456 username=unknown action=message
2026-02-02T10:31:00Z [KEY_INVALID] chat_id=123456 key=ZYLOS-XXXX-XXXX
2026-02-02T10:32:00Z [KEY_VALID] chat_id=123456 key=ZYLOS-A7K2-... auto_whitelist=true
```

---

## 七、媒体处理

### 7.1 接收流程

```
用户发送图片/文件
      │
      ▼
┌─────────────┐
│  bot.js     │  监听 photo/document 事件
└─────┬───────┘
      │
      ▼
┌─────────────┐
│  media.js   │  1. 获取 file_id
└─────┬───────┘  2. 调用 Telegram API 获取 file_path
      │          3. 下载到 ~/zylos/components/telegram/media/
      │          4. 文件名: {type}-{timestamp}.{ext}
      ▼
返回本地路径，组装到消息中传给 c4-receive
```

### 7.2 发送流程

```bash
# send.sh 解析 [MEDIA:type] 前缀

# 图片
send.sh "12345" "[MEDIA:image]/path/to/photo.jpg"
# → 调用 sendPhoto API

# 文件
send.sh "12345" "[MEDIA:file]/path/to/doc.pdf"
# → 调用 sendDocument API

# 纯文本
send.sh "12345" "Hello world"
# → 调用 sendMessage API
```

---

## 八、服务管理

### 8.1 PM2 配置

```javascript
// ecosystem.config.js
const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-telegram',
    script: 'src/bot.js',
    cwd: path.join(os.homedir(), '.claude/skills/telegram'),
    env: {
      NODE_ENV: 'production'
    }
  }]
};

// 注意: .env 由 bot.js 中的 dotenv 加载，路径: ~/zylos/.env
```

### 8.2 服务命令

```bash
# 启动
pm2 start ~/.claude/skills/telegram/ecosystem.config.js

# 停止
pm2 stop zylos-telegram

# 重启
pm2 restart zylos-telegram

# 查看日志
pm2 logs zylos-telegram
```

---

## 九、安装脚本

### 9.1 install.sh

```bash
#!/bin/bash
# zylos-telegram 安装脚本

set -e

SKILL_DIR="$HOME/.claude/skills/telegram"
DATA_DIR="$HOME/zylos/components/telegram"
ENV_FILE="$HOME/zylos/.env"

echo "=== Installing zylos-telegram ==="

# 1. 创建 Data 目录
mkdir -p "$DATA_DIR/media"
mkdir -p "$DATA_DIR/logs"

# 2. 安装依赖
cd "$SKILL_DIR"
npm install --production

# 3. 生成默认配置 (不覆盖)
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
fi

# 4. 检查环境变量
if ! grep -q "TELEGRAM_BOT_TOKEN" "$ENV_FILE" 2>/dev/null; then
  echo "[!] Add TELEGRAM_BOT_TOKEN to $ENV_FILE"
fi

# 5. 启动服务
pm2 start "$SKILL_DIR/ecosystem.config.js"
pm2 save

echo "=== Done ==="
```

### 9.2 uninstall.sh

```bash
#!/bin/bash
# zylos-telegram 卸载脚本
# 用法: uninstall.sh [--purge]
#   --purge: 同时删除数据目录

set -e

SKILL_DIR="$HOME/.claude/skills/telegram"
DATA_DIR="$HOME/zylos/components/telegram"
PURGE=false

[[ "$1" == "--purge" ]] && PURGE=true

echo "=== Uninstalling zylos-telegram ==="

# 1. 停止 PM2 服务
pm2 stop zylos-telegram 2>/dev/null || true
pm2 delete zylos-telegram 2>/dev/null || true
pm2 save

# 2. 删除 Skills 目录
rm -rf "$SKILL_DIR"

# 3. 可选删除数据
if $PURGE; then
  rm -rf "$DATA_DIR"
  echo "Data directory removed."
else
  echo "Data directory preserved: $DATA_DIR"
fi

echo "=== Done ==="
```

### 9.3 upgrade.sh

```bash
#!/bin/bash
# zylos-telegram 升级脚本

set -e

SKILL_DIR="$HOME/.claude/skills/telegram"

echo "=== Upgrading zylos-telegram ==="

# 1. 拉取最新代码
echo "Pulling latest code..."
cd "$SKILL_DIR"
git pull

# 2. 更新依赖
echo "Updating dependencies..."
npm install

# 3. 重启服务
echo "Restarting service..."
pm2 restart zylos-telegram

echo ""
echo "=== Upgrade complete ==="
```

---

## 十、开发计划

### 10.1 阶段划分

| 阶段 | 任务 | 预期产出 |
|------|------|----------|
| 1 | 项目初始化 | 仓库结构、package.json、SKILL.md |
| 2 | 核心重构 | bot.js 模块化拆分、config.js |
| 3 | C4 对接 | send.sh 实现、c4-receive 集成 |
| 4 | 白名单功能 | whitelist.js、product-key.js |
| 5 | 媒体处理 | media.js、send-photo.sh |
| 6 | 安装脚本 | install.sh、uninstall.sh、upgrade.sh |
| 7 | 测试验证 | 端到端测试、文档完善 |

### 10.2 从现有代码迁移

| 现有文件 | 迁移目标 | 改动 |
|----------|----------|------|
| bot.js | src/bot.js | 拆分 auth/media 模块 |
| send-reply.sh | src/send.sh | 重命名，支持 chat_id 参数，合并媒体发送 |
| config.json | Data/config.json | 简化 schema |
| .env | ~/zylos/.env | 统一管理 |

### 10.3 验收标准

- [ ] `git clone` + `install.sh` 可在全新环境完成安装
- [ ] `send.sh <chat_id> <message>` 正确发送消息
- [ ] 私聊消息正确传递到 c4-receive
- [ ] 图片下载并传递路径
- [ ] Product Key 验证流程正常
- [ ] `upgrade.sh` 保留用户配置
- [ ] `uninstall.sh` 正确清理

---

## 附录

### A. 依赖列表

```json
{
  "dependencies": {
    "telegraf": "^4.x",
    "https-proxy-agent": "^7.x",
    "dotenv": "^16.x"
  }
}
```

### B. 参考资料

- [Telegraf 文档](https://telegraf.js.org/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [zylos0-components-design.md](https://zylos10.jinglever.com/zylos0-components-design.md)

---

*文档结束*
