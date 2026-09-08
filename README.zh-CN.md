# Layer3 Telegram 机器控制机器人

这是一个开源的 Layer3 Cloud 虚拟机 Telegram 控制机器人。服务器只需要 Docker 和 Telegram Bot Token，Layer3 账号、密码、项目和机器名都在 Telegram 私聊里绑定。

## 使用流程

1. 在服务器运行一键脚本，只输入 Telegram Bot Token
2. Docker 容器启动机器人
3. 在 Telegram 私聊机器人发送 `/start`
4. 第一个在私聊中发送 `/start` 的 Chat ID 自动成为管理员
5. 发送 `/bind`，按提示输入 Layer3 邮箱和密码
6. 机器人自动登录 Layer3，读取账户余额和机器列表
7. 如果有多台机器，发送编号选择要控制的机器
8. 确认小时价格和自动关机分钟数
9. 检查成功后，在 Telegram 里使用按钮启动或关闭机器

## 一键安装

推荐一行命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/zxyszx/layer3-telegram-bot/main/install.sh | bash
```

脚本会自动拉取项目到 `/opt/layer3-telegram-bot`，然后打开安装菜单。菜单中只需要输入 Telegram Bot Token。
安装完成后，以后在服务器任意目录输入 `ngn` 即可重新打开管理菜单。

也可以手动安装：

```bash
git clone https://github.com/zxyszx/layer3-telegram-bot.git
cd layer3-telegram-bot
chmod +x scripts/*.sh
./scripts/setup.sh
```

菜单中选择：

```text
1. 安装 / 修改 Telegram Bot Token
```

脚本不会要求输入 Layer3 账号密码。账号密码只在 Telegram 私聊中通过 `/bind` 绑定。

## 菜单功能

```bash
./scripts/setup.sh
```

如果使用一键命令安装，也可以直接输入：

```bash
ngn
```

- `1` 安装 / 修改 Telegram Bot Token
- `2` 启动机器人
- `3` 停止机器人
- `4` 重启机器人
- `5` 查看实时日志
- `6` 更新代码并重启
- `7` 查看容器状态和最近日志
- `8` 测试 Telegram Bot Token
- `9` 重置 Telegram 和 Layer3 绑定
- `10` 卸载容器

也支持非交互命令：

```bash
./scripts/setup.sh install
./scripts/setup.sh start
./scripts/setup.sh stop
./scripts/setup.sh restart
./scripts/setup.sh logs
./scripts/setup.sh update
./scripts/setup.sh status
./scripts/setup.sh reset-binding
```

## Telegram 命令

- `/start`：显示菜单；首次使用时自动绑定管理员
- `/bind`：绑定或重新绑定 Layer3 账号和机器
- `/status`：查看余额、机器状态和预计可运行时间
- `/startvm`：确认后持续启动机器
- `/start1h`：确认后启动机器，并在默认 60 分钟后自动关机
- `/stopvm`：确认后执行控制台 `Power Off`

## 绑定机器

在 Telegram 里发送 `/bind` 后，机器人会先询问：

- Layer3 登录邮箱
- Layer3 登录密码

随后机器人会自动登录 Layer3，读取账户余额、机器数量、机器名称、项目标识、IP、配置、状态和累计消费。如果账户里有多台机器，发送编号选择即可。

最后再确认：

- 完整小时价格 NGN，例如 `22.37702`；发送 `默认` 使用 `22.37702`
- 自动关机分钟数；发送 `默认` 使用 `60`

如果 Layer3 页面改版导致自动识别失败，机器人会回退到手动输入项目标识和机器名。项目标识是机器详情页 URL 里的 `/app/projects/<项目标识>/...`，不一定是页面显示的项目名称。

提交完毕后，机器人会自动登录 Layer3 控制台并读取机器状态。如果返回余额和状态，说明绑定成功，可以开始操作。

如果 Layer3 需要验证码或二次验证，自动检查可能失败。可以在有桌面/VNC 的环境中手动运行：

```bash
npm ci
npx playwright install chromium
npm run login
```

登录会话保存在 `data/browser-profile`。再次启动 Docker 后会复用该会话。

## 数据保存位置

- `.env`：只保存 Telegram Bot Token 和基础运行参数
- `data/bot-config.json`：保存管理员 Chat ID、Layer3 账号和机器信息
- `data/browser-profile`：保存 Playwright 浏览器登录会话
- `data/runtime.json`：保存自动关机任务
- `data/telegram.json`：保存 Telegram 更新进度

这些文件和目录都不应提交到 GitHub。

## 重要安全提醒

- Bot Token 泄露后，别人可能抢先发送 `/start` 绑定管理员
- 公开部署前请先确认机器人 Token 只发给自己
- Telegram 里发送 Layer3 密码后，建议手动删除密码消息
- 启动和关机都有二次确认，避免误操作
- 当前关机动作使用 Layer3 控制台 `Power Off`，可能是强制断电，请先保存数据

## 验证

```bash
npm ci
npm test
```

首次上线建议把自动关机分钟数设置为 `5` 测试一次，确认启动和关机都正常后再改回 `60`。
