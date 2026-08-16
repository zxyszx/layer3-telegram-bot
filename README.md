# Layer3 Telegram Bot

使用 Telegram 查询 Layer3 Cloud 余额、实例状态和预计可用时间，并控制指定虚拟机：

- **启动**：持续运行，取消旧的自动关机任务。
- **启动 1 小时**：启动并在 60 分钟后执行控制台 `Power Off`。
- **立即关机**：二次确认后执行控制台 `Power Off`。
- **查看状态**：显示余额、运行状态、剩余小时和按每天 1 小时估算的天数。

当前已适配实例：`default-828 / vm-f9k5yf10c`，参考价格 `NGN 22.37702/小时`。

## 部署位置

机器人必须部署在另一台长期在线的 VPS、NAS 或家庭服务器上，不能安装在它要控制的 Layer3 虚拟机中，否则目标机器关机后机器人也会离线。

## 一键 Docker 部署

服务器需要预先安装 Docker Engine、Docker Compose 插件和 Git：

```bash
gh auth login
gh repo clone zxyszx/layer3-telegram-bot
cd layer3-telegram-bot
./scripts/setup.sh
```

仓库是私有的，因此服务器需要先安装并登录 GitHub CLI。完成过 `gh auth login` 后，以后更新不需要重新登录。

已登录 GitHub 的服务器可以直接运行一条命令：

```bash
gh repo clone zxyszx/layer3-telegram-bot && cd layer3-telegram-bot && ./scripts/setup.sh
```

脚本会询问 Telegram Token、Chat ID、Layer3 邮箱和密码，然后构建并启动容器。

常用命令：

```bash
./scripts/start.sh   # 构建并启动
./scripts/logs.sh    # 查看日志
./scripts/stop.sh    # 停止机器人容器，不操作 Layer3 VM
./scripts/update.sh  # 拉取仓库更新并重新构建
```

## 在哪里填写账号密码

推荐直接运行 `./scripts/setup.sh`，密码输入时不会显示。脚本将配置写入项目根目录的 `.env`：

```dotenv
LAYER3_EMAIL=你的登录邮箱
LAYER3_PASSWORD_BASE64=脚本自动生成的Base64密码
```

也可以复制 `.env.example` 后手动填写 `LAYER3_PASSWORD`。`.env` 权限应为 `600`，已经在 `.gitignore` 和 `.dockerignore` 中排除，绝不能提交到 GitHub。

首次登录遇到验证码或二次验证时，需在带桌面的服务器上运行 `npm run login` 保存浏览器会话；详细步骤和安全说明见 [完整中文部署文档](README.zh-CN.md)。

## Telegram 准备

1. 联系 Telegram 的 `@BotFather`，使用 `/newbot` 创建机器人并取得 Token。
2. 向新机器人发送一条消息。
3. 打开 `https://api.telegram.org/bot<你的Token>/getUpdates`，从 `message.chat.id` 取得 Chat ID。
4. 运行 `./scripts/setup.sh` 填入 Token 和 Chat ID。

## Docker 镜像

仓库包含 `Dockerfile` 和 `docker-compose.yml`。GitHub Actions 会运行测试，并在推送到 `main` 或创建版本标签时构建镜像到：

`ghcr.io/<GitHub用户名>/<仓库名>:latest`

## 安全说明

- Telegram 操作仅接受 `TELEGRAM_ALLOWED_CHAT_IDS` 白名单。
- 付费启动和 Power Off 均要求二次确认。
- Telegram 更新编号和自动关机任务均持久化，进程重启不会重复执行付费操作或丢失关机任务。
- Layer3 当前页面提供的是 `Power Off`，可能是强制断电；执行前必须保存数据并正常停止应用。
- 真实费用以 Layer3 账单为准。

## 验证

```bash
npm ci
npm test
```

首次上线建议把 `AUTO_STOP_MINUTES` 改为 `5`，使用无重要数据的实例完成一次启动/停止测试，再改回 `60`。
