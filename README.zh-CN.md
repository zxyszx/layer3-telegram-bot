# Layer3 Telegram 机器控制机器人

通过 Telegram 查询 Layer3 Cloud 余额和机器状态，并在确认后启动机器、默认运行 1 小时后自动关机，或随时手动关机。

> 机器人必须部署在另一台长期在线的服务器上，不能部署在它要控制的 Layer3 虚拟机中；否则目标机器关机后，机器人也会离线，无法重新启动目标机器。

## 功能

- `/status`：余额、机器状态、预计可运行小时/天数/年数
- `/startvm`：二次确认后持续启动机器，并取消旧的自动关机任务
- `/start1h`：二次确认后启动机器，并在 1 小时后自动关机
- `/stopvm`：二次确认后立即安全关机
- 白名单限制可操作的 Telegram Chat ID
- 自动关机状态持久化，机器人重启后继续执行
- 重用本地浏览器登录会话；会话过期时可选择人工重新登录或使用环境变量刷新登录

## 重要限制

Layer3 目前没有公开的实例启停 API 文档。本项目通过 Playwright 控制 Layer3 控制台，因此页面改版后可能需要调整 `src/layer3-browser.js` 中的文本定位规则。首次正式使用前，必须在测试机器上验证 `/status`、启动和关机按钮。

当前实例详情页提供的快捷操作是 `Power Off`，不是温和的 `Shut down`。Telegram 会在执行前二次确认并提示保存数据；一小时自动关机同样使用该控制台操作。重要数据应先正常停止应用并写盘，不能把 `Power Off` 当成无风险关机。

## 准备 Telegram Bot

1. 在 Telegram 中打开 `@BotFather`。
2. 发送 `/newbot` 并取得 Bot Token。
3. 给机器人发送任意消息，再访问：

   `https://api.telegram.org/bot<你的Token>/getUpdates`

4. 从返回结果中的 `message.chat.id` 取得 Chat ID。

## 配置

```bash
cp .env.example .env
chmod 600 .env
```

至少填写：

```dotenv
TELEGRAM_BOT_TOKEN=BotFather提供的Token
TELEGRAM_ALLOWED_CHAT_IDS=你的ChatID
LAYER3_PROJECT_SLUG=default-828
LAYER3_INSTANCE_NAME=vm-f9k5yf10c
INSTANCE_HOURLY_NGN=22.37702
```

多个 Chat ID 使用逗号分隔。`INSTANCE_HOURLY_NGN` 应填写控制台当前完整小时总价；价格变化后需要同步更新，否则“剩余时间”估算会不准确。

当前已核对的目标实例是 `vm-f9k5yf10c`，项目为 `default-828`。机器人会直接访问该实例详情页，在每次操作前核对页面状态和电源按钮提示，避免把重启或删除按钮当成启停操作。

## 登录 Layer3

推荐使用一次人工登录产生持久浏览器会话：

```bash
npm install
npx playwright install chromium
npm run login
```

登录完成后，浏览器会话保存在 `data/browser-profile`。该目录包含敏感登录信息，权限应限制为仅部署用户可读，绝不能上传到 GitHub 或发送给其他人。

纯命令行服务器可以临时使用桌面/VNC完成首次登录。也可以在 `.env` 中设置 `LAYER3_EMAIL` 和 `LAYER3_PASSWORD` 让机器人在普通登录页自动刷新会话；如果出现验证码或二次验证，仍需人工登录。不要把 `.env` 提交到仓库。

## Docker 部署

```bash
docker compose build
docker compose up -d
docker compose logs -f bot
```

更新配置后：

```bash
docker compose restart bot
```

## 非 Docker 运行

需要 Node.js 20 或更高版本：

```bash
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

## 安全建议

- 只允许自己的 Telegram Chat ID。
- 为部署服务器配置防火墙和自动安全更新。
- 不要把 Bot Token、Layer3 密码或 `data/browser-profile` 放入代码仓库。
- 首次验证时把 `AUTO_STOP_MINUTES` 暂设为 `5`，确认关机和状态检查正常后再改为 `60`。
- 每次自动关机失败，机器人会发送报警；收到报警后应立即进入 Layer3 控制台处理。
- 当前实现不会自动强制断电，避免文件系统损坏。

## 费用估算

剩余可运行小时数按下式估算：

`Infra Credits / INSTANCE_HOURLY_NGN`

这只是参考值，不包含未来价格变化、独立磁盘/IP费用、流量、备份和其他附加项。真实费用始终以 Layer3 账单为准。
