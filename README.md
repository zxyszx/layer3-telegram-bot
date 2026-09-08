# Layer3 Telegram Bot

一个通过 Telegram 控制 Layer3 Cloud 虚拟机的 Docker 机器人。

服务器安装时只需要输入 **Telegram Bot Token**。首次启动后，在 Telegram 私聊机器人发送 `/start` 自动绑定管理员，再发送 `/bind` 输入 Layer3 账号、密码并选择机器。绑定成功后配置会保存在服务器本地，后续查看状态、启动和关机不需要反复输入账号密码；Layer3 会话过期时机器人会用已保存的账号密码自动重新登录。

> 机器人必须部署在另一台长期在线的 VPS、NAS 或家庭服务器上，不能部署在它要控制的 Layer3 虚拟机中。否则目标机器关机后，机器人也会离线，无法再远程启动目标机器。

## 功能

- `/start`：首次绑定管理员，显示操作菜单
- `/bind`：在 Telegram 里绑定或重新绑定 Layer3 账号和机器
- `/status`：查看余额、机器状态、预计可运行小时/天数
- `/startvm`：二次确认后持续启动机器，并取消旧的自动关机任务
- `/start1h`：二次确认后启动机器，并在设定分钟数后自动关机
- `/stopvm`：二次确认后执行控制台 `Power Off`
- 自动保存 Telegram 更新进度，避免进程重启后重复执行付费操作
- 自动关机任务持久化，容器重启后继续生效
- 保存 Layer3 登录信息和浏览器会话，会话过期后自动重新登录

## 一键 Docker 安装

服务器需要先安装 Docker Engine 和 Docker Compose 插件。

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

进入菜单后选择：

```text
1. 安装 / 修改 Telegram Bot Token
```

脚本只会要求输入 Telegram Bot Token，然后自动构建并启动 Docker 容器。

启动后打开 Telegram：

1. 私聊你的机器人，发送 `/start`
2. 当前 Telegram Chat ID 会自动成为管理员
3. 发送 `/bind`
4. 按提示输入 Layer3 登录邮箱和密码
5. 机器人自动登录 Layer3，读取账户余额和机器列表
6. 如果有多台机器，发送编号选择要控制的机器
7. 机器人自动保存项目标识和机器名，并检查机器状态
8. 成功返回状态后即可操作

## 菜单命令

```bash
./scripts/setup.sh
```

如果使用一键命令安装，也可以直接输入：

```bash
ngn
```

菜单包含：

- 安装 / 修改 Telegram Bot Token
- 启动机器人
- 停止机器人
- 重启机器人
- 查看实时日志
- 更新代码并重启
- 查看容器状态和最近日志
- 测试 Telegram Bot Token
- 重置 Telegram 和 Layer3 绑定
- 登录失败诊断
- 测试 Layer3 自动登录和机器读取
- 卸载容器

也可以直接运行：

```bash
./scripts/setup.sh start
./scripts/setup.sh stop
./scripts/setup.sh restart
./scripts/setup.sh logs
./scripts/setup.sh update
./scripts/setup.sh status
./scripts/setup.sh diagnostics
./scripts/setup.sh layer3-test
./scripts/setup.sh reset-binding
```

## Telegram Bot Token 获取

1. 在 Telegram 打开 `@BotFather`
2. 发送 `/newbot`
3. 按提示创建机器人
4. 复制 BotFather 返回的 Token
5. 在服务器菜单里填入这个 Token

不需要在服务器手动填写 Telegram Chat ID。首次私聊机器人发送 `/start` 的用户会自动成为管理员；为了避免误绑定，首次管理员绑定不接受群组消息。

## Layer3 绑定说明

在 Telegram 里发送 `/bind` 后，机器人会先询问：

- Layer3 登录邮箱
- Layer3 登录密码

随后机器人会自动登录 Layer3，读取账户余额、机器数量、机器名称、项目标识、IP、配置、状态和累计消费。如果账户里有多台机器，发送编号选择即可。

机器人不会要求手动输入项目标识和机器名。自动读取成功后会直接保存绑定信息；只有账户里有多台机器时，才需要发送机器编号选择。

如果 Layer3 页面改版、验证码、二次验证或账号密码错误导致自动读取失败，绑定流程会停止，并提示在服务器运行：

```bash
ngn diagnostics
```

诊断命令会显示当前版本、容器状态、最近日志、登录接口返回状态和登录页面摘要，方便确认到底是密码错误、验证码还是页面变化。

也可以在服务器直接测试 Layer3 自动登录和机器读取：

```bash
ngn layer3-test
```

绑定信息会保存在服务器本地 `data/bot-config.json`。该文件包含敏感信息，已经被 `.gitignore` 和 `.dockerignore` 排除，不能上传到 GitHub。

已经保存过账号密码后，再次发送 `/bind` 时可以发送 `默认` 复用已保存邮箱和密码。

如果绑定错了，可以在服务器运行：

```bash
./scripts/setup.sh reset-binding
./scripts/setup.sh restart
```

然后重新在 Telegram 里发送 `/start` 和 `/bind`。

## 常用 Docker 命令

```bash
./scripts/start.sh   # 构建并启动
./scripts/logs.sh    # 查看日志
./scripts/stop.sh    # 停止机器人容器，不操作 Layer3 VM
./scripts/update.sh  # 拉取更新并重新构建
```

## 安全说明

- 首次 `/start` 的 Telegram 用户会成为管理员，请先确认 Bot Token 没有泄露
- 启动和关机都需要 Telegram 二次确认
- Telegram 中输入 Layer3 密码后，建议手动删除那条密码消息
- Layer3 当前页面提供的是 `Power Off`，可能是强制断电，关机前请先保存数据
- 真实费用以 Layer3 账单为准，README 中的价格只用于估算

## 本地开发

需要 Node.js 20 或更高版本：

```bash
npm ci
npx playwright install chromium
npm test
npm start
```
