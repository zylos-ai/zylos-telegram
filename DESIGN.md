# zylos-telegram 详细设计文档

**版本**: v2.0
**日期**: 2026-02-04
**作者**: Zylos Team
**仓库**: https://github.com/zylos-ai/zylos-telegram
**状态**: 已实现

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
~/zylos/.claude/skills/telegram/
├── SKILL.md              # 组件元数据 (v2 格式，含 lifecycle)
├── package.json          # 依赖定义
├── ecosystem.config.cjs  # PM2 配置
├── hooks/
│   ├── post-install.js   # 安装后钩子 (创建目录、配置 PM2)
│   └── post-upgrade.js   # 升级后钩子 (配置迁移)
├── scripts/
│   └── send.js           # C4 标准发送接口
└── src/
    ├── bot.js            # 主程序入口
    ├── admin.js          # 管理 CLI
    └── lib/
        ├── config.js     # 配置加载模块
        ├── auth.js       # 认证模块 (Owner 绑定 + 白名单)
        ├── context.js    # 群聊上下文管理
        └── media.js      # 媒体处理模块
```

> **注意**: v2 格式使用 `hooks/` 目录替代了原来的 `install.js`、`upgrade.js`、`uninstall.js`。
> 标准安装/卸载操作由 zylos CLI 处理，hooks 仅处理组件特定逻辑。

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
│  │  (Telegraf)  │    │ Owner+白名单  │                   │
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
│  │ c4-receive (comm-bridge)         │ → C4 Bridge       │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌──────────────┐                                       │
│  │   send.js    │  ← C4 调用发送消息                    │
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
| 上下文 | lib/context.js | 群聊消息日志 + @mention 上下文 |
| 发送 | scripts/send.js | C4 标准接口，发送文本和媒体 |

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
      │ 1. Owner 绑定 (首次用户)
      │ 2. 白名单验证
      │ 3. formatMessage() 格式化
      │    "[TG DM] username said: 消息内容"
      │    "[TG GROUP:groupname] username said: 消息内容"
      ▼
┌─────────────┐
│ c4-receive  │  comm-bridge 接口
└─────┬───────┘
      │ --channel telegram
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
┌──────────────────────────────────────────┐
│ ~/zylos/.claude/skills/telegram/scripts/send.js │
└─────┬────────────────────────────────────┘
      │ 1. 解析参数
      │ 2. 检查媒体前缀 [MEDIA:type]
      │ 3. 长消息自动分段
      │ 4. 调用 Telegram API
      ▼
┌─────────────┐
│ Telegram    │  用户收到消息
└─────────────┘
```

### 4.3 send.js 接口规范

```bash
# 位置: ~/zylos/.claude/skills/telegram/scripts/send.js
# 调用: node send.js <chat_id> <message>
# 返回: 0 成功, 非 0 失败

# 示例 - 纯文本
node send.js "8101553026" "Hello, this is a test message"

# 示例 - 发送图片
node send.js "8101553026" "[MEDIA:image]/path/to/photo.jpg"

# 示例 - 发送文件
node send.js "8101553026" "[MEDIA:file]/path/to/document.pdf"
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

  "allowed_groups": [],

  "smart_groups": [
    {
      "chat_id": "-100123456789",
      "name": "研发群"
    }
  ],

  "features": {
    "download_media": true
  },

  "message": {
    "context_messages": 10
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
| allowed_groups | object[] | @mention 时响应的群组 (chat_id + name) |
| smart_groups | object[] | 监听所有消息的群组 (chat_id + name) |
| features.download_media | boolean | 是否下载媒体文件 |
| message.context_messages | number | 群聊 @mention 时附带的最近消息数 (默认 10) |

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

所有未授权访问通过 console 记录，日志由 PM2 管理。

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
# send.js 解析 [MEDIA:type] 前缀

# 图片
node send.js "12345" "[MEDIA:image]/path/to/photo.jpg"
# → 调用 sendPhoto API

# 文件
node send.js "12345" "[MEDIA:file]/path/to/doc.pdf"
# → 调用 sendDocument API

# 纯文本
node send.js "12345" "Hello world"
# → 调用 sendMessage API
```

---

## 八、服务管理

### 8.1 PM2 配置

```javascript
// ecosystem.config.cjs (CJS format for PM2 compatibility)
const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-telegram',
    script: 'src/bot.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/telegram'),
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
pm2 start ~/zylos/.claude/skills/telegram/ecosystem.config.cjs

# 停止
pm2 stop zylos-telegram

# 重启
pm2 restart zylos-telegram

# 查看日志
pm2 logs zylos-telegram
```

---

## 九、生命周期管理 (v2 Hooks)

v2 格式使用 `SKILL.md` 中的 `lifecycle` 配置和 `hooks/` 目录，替代了原来的独立脚本。

### 9.1 SKILL.md lifecycle 配置

```yaml
lifecycle:
  npm: true                          # zylos CLI 执行 npm install
  service:
    name: zylos-telegram             # PM2 服务名
    entry: src/bot.js                # 入口文件
  data_dir: ~/zylos/components/telegram  # 数据目录
  hooks:
    post-install: hooks/post-install.js  # 安装后钩子
    post-upgrade: hooks/post-upgrade.js  # 升级后钩子
```

### 9.2 hooks/post-install.js

安装后钩子，处理组件特定设置：

- 创建子目录 (media/, logs/)
- 生成默认 config.json
- 检查环境变量
- 用 ecosystem.config.cjs 配置 PM2

### 9.3 hooks/post-upgrade.js

升级后钩子，处理配置迁移：

- 检查并添加新配置字段
- 迁移旧配置格式
- 保持向后兼容

### 9.4 安装/卸载流程

标准操作由 `zylos CLI` 处理：

```bash
# 安装
zylos install telegram
# 1. git clone 到 ~/zylos/.claude/skills/telegram
# 2. npm install
# 3. 创建 data_dir
# 4. PM2 注册服务
# 5. 执行 post-install hook

# 升级
zylos upgrade telegram
# 1. git pull
# 2. npm install
# 3. 执行 post-upgrade hook
# 4. PM2 重启服务

# 卸载
zylos uninstall telegram [--purge]
# 1. PM2 删除服务
# 2. 删除 skill 目录
# 3. --purge: 删除数据目录
```

---

## 十、验收标准

- [x] `zylos install telegram` 可在全新环境完成安装
- [x] `node send.js <chat_id> <message>` 正确发送消息
- [x] 私聊消息正确传递到 c4-receive
- [x] 图片下载并传递路径
- [x] Owner 自动绑定流程正常
- [x] Owner 可在任意群 @bot 触发响应
- [x] `zylos upgrade telegram` 保留用户配置并执行迁移
- [x] `zylos uninstall telegram` 正确清理

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
