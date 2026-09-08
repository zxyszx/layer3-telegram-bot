#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
SERVICE_NAME="bot"

cd "${PROJECT_DIR}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

pause() {
  printf '\n'
  read -r -p "按回车返回菜单..." _
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    red "未检测到 Docker 或 Docker Compose 插件。"
    cat <<'EOF'

Ubuntu / Debian 可先执行：
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker

然后重新运行：
  ./scripts/setup.sh
EOF
    return 1
  fi
}

env_value() {
  local key="$1"
  [[ -f "${ENV_FILE}" ]] || return 0
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2-
}

write_env() {
  local token="$1"
  local temporary
  temporary="$(mktemp "${PROJECT_DIR}/.env.XXXXXX")"
  trap 'rm -f "${temporary}"' RETURN

  cat >"${temporary}" <<EOF
TELEGRAM_BOT_TOKEN=${token}

# 首次私聊机器人发送 /start 后，管理员 Chat ID 和 Layer3 机器信息会保存到 data/bot-config.json。
TELEGRAM_ALLOWED_CHAT_IDS=

LAYER3_PROJECT_SLUG=
LAYER3_INSTANCE_NAME=
LAYER3_INSTANCES_URL=https://console.layer3.cloud/app/virtual-machines
LAYER3_EMAIL=
LAYER3_PASSWORD=
LAYER3_PASSWORD_BASE64=

INSTANCE_HOURLY_NGN=22.37702
AUTO_STOP_MINUTES=60
ESTIMATED_HOURS_PER_DAY=1

HEADLESS=true
DATA_DIR=/app/data
LOG_LEVEL=info
EOF

  chmod 600 "${temporary}"
  mv "${temporary}" "${ENV_FILE}"
  mkdir -p "${PROJECT_DIR}/data"
  chmod 700 "${PROJECT_DIR}/data"
}

configure_token() {
  local current token
  current="$(env_value TELEGRAM_BOT_TOKEN)"
  read -r -p "Telegram Bot Token${current:+ [保留原值]}: " token
  token="${token:-${current}}"
  if [[ -z "${token}" ]]; then
    red "Bot Token 不能为空。"
    return 1
  fi
  write_env "${token}"
  green "Bot Token 已保存。服务器端不需要输入 Layer3 账号密码，请在 Telegram 里绑定。"
}

test_token() {
  local token
  token="$(env_value TELEGRAM_BOT_TOKEN)"
  if [[ -z "${token}" ]]; then
    red "还没有配置 Telegram Bot Token。"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    yellow "未检测到 curl，跳过在线校验。"
    return 0
  fi
  if curl -fsS "https://api.telegram.org/bot${token}/getMe" >/dev/null; then
    green "Telegram Bot Token 校验成功。"
  else
    red "Telegram Bot Token 校验失败，请检查 Token。"
    return 1
  fi
}

start_bot() {
  check_docker
  if [[ ! -f "${ENV_FILE}" ]]; then
    red "还没有配置 Bot Token，请先选择 1。"
    return 1
  fi
  docker compose up -d --build
  sleep 2
  docker compose ps
  cat <<'EOF'

下一步：
1. 打开 Telegram，私聊你的机器人。
2. 发送 /start，当前 Chat ID 会自动成为管理员。
3. 发送 /bind，按提示输入 Layer3 邮箱、密码、项目和机器名。
4. 机器人检查状态成功后，就可以用按钮启动或关闭机器。
EOF
}

stop_bot() {
  check_docker
  docker compose down
  green "机器人容器已停止。注意：这不会关闭 Layer3 机器。"
}

restart_bot() {
  check_docker
  docker compose restart "${SERVICE_NAME}"
  green "机器人已重启。"
}

show_logs() {
  check_docker
  docker compose logs -f --tail=200 "${SERVICE_NAME}"
}

update_project() {
  check_docker
  if [[ -d .git ]]; then
    git pull --ff-only
  else
    yellow "当前目录不是 git 仓库，跳过拉取代码。"
  fi
  docker compose up -d --build
  green "更新完成，机器人已重新启动。"
}

show_status() {
  check_docker
  docker compose ps
  printf '\n最近日志：\n'
  docker compose logs --tail=50 "${SERVICE_NAME}" || true
}

reset_binding() {
  read -r -p "确认删除 Telegram 管理员、Layer3 绑定信息和自动关机计划？输入 y 确认: " answer
  if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
    yellow "已取消。"
    return 0
  fi
  rm -f "${PROJECT_DIR}/data/bot-config.json" "${PROJECT_DIR}/data/runtime.json"
  green "绑定信息已删除。重启机器人后，首次 /start 的 Telegram 用户会成为管理员。"
}

uninstall_bot() {
  check_docker
  read -r -p "确认停止并删除容器？不会删除 .env 和 data。输入 y 确认: " answer
  if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
    yellow "已取消。"
    return 0
  fi
  docker compose down
  green "容器已删除，配置和绑定数据仍保留。"
}

install_flow() {
  check_docker
  configure_token
  test_token || true
  start_bot
}

menu() {
  while true; do
    clear || true
    cat <<'EOF'
Layer3 Telegram Bot 一键管理菜单
快捷命令：ngn

1. 安装 / 修改 Telegram Bot Token
2. 启动机器人
3. 停止机器人
4. 重启机器人
5. 查看实时日志
6. 更新代码并重启
7. 查看容器状态和最近日志
8. 测试 Telegram Bot Token
9. 重置 Telegram 和 Layer3 绑定
10. 卸载容器（保留配置和数据）
0. 退出
EOF
    printf '\n'
    read -r -p "请选择操作: " choice
    case "${choice}" in
      1) install_flow || true; pause ;;
      2) start_bot || true; pause ;;
      3) stop_bot || true; pause ;;
      4) restart_bot || true; pause ;;
      5) show_logs ;;
      6) update_project || true; pause ;;
      7) show_status || true; pause ;;
      8) test_token || true; pause ;;
      9) reset_binding || true; pause ;;
      10) uninstall_bot || true; pause ;;
      0) exit 0 ;;
      *) red "无效选择"; pause ;;
    esac
  done
}

case "${1:-}" in
  --install|install) install_flow ;;
  --start|start) start_bot ;;
  --stop|stop) stop_bot ;;
  --restart|restart) restart_bot ;;
  --logs|logs) show_logs ;;
  --update|update) update_project ;;
  --status|status) show_status ;;
  --reset-binding|reset-binding) reset_binding ;;
  *) menu ;;
esac
