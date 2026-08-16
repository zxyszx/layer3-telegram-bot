#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"

if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 Docker。请先安装 Docker Engine 和 Docker Compose 插件。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "未检测到 docker compose。请安装 Docker Compose 插件。" >&2
  exit 1
fi
if [[ -f "${ENV_FILE}" && "${1:-}" != "--force" ]]; then
  echo "${ENV_FILE} 已存在。为避免覆盖账号信息，请使用 ./scripts/start.sh 启动。"
  echo "确需重新配置时运行：./scripts/setup.sh --force"
  exit 1
fi

read -r -p "Telegram Bot Token: " telegram_token
read -r -p "允许操作的 Telegram Chat ID（多个用逗号分隔）: " chat_ids
read -r -p "Layer3 登录邮箱: " layer3_email
read -r -s -p "Layer3 登录密码（输入时不显示）: " layer3_password
echo
read -r -p "Layer3 项目标识 [default-828]: " project_slug
project_slug="${project_slug:-default-828}"
read -r -p "Layer3 实例名称 [vm-f9k5yf10c]: " instance_name
instance_name="${instance_name:-vm-f9k5yf10c}"
read -r -p "完整小时价格 NGN [22.37702]: " hourly_price
hourly_price="${hourly_price:-22.37702}"
read -r -p "自动关机分钟数 [60]: " auto_stop
auto_stop="${auto_stop:-60}"
auto_shutdown_seconds="$((auto_stop * 60))"

if [[ -z "${telegram_token}" || -z "${chat_ids}" || -z "${layer3_email}" || -z "${layer3_password}" ]]; then
  echo "Token、Chat ID、邮箱和密码不能为空。" >&2
  exit 1
fi

password_base64="$(printf '%s' "${layer3_password}" | base64 | tr -d '\n')"
temporary="$(mktemp "${PROJECT_DIR}/.env.XXXXXX")"
trap 'rm -f "${temporary}"' EXIT

cat >"${temporary}" <<EOF
TELEGRAM_BOT_TOKEN=${telegram_token}
TELEGRAM_ALLOWED_CHAT_IDS=${chat_ids}

LAYER3_PROJECT_SLUG=${project_slug}
LAYER3_INSTANCE_NAME=${instance_name}
LAYER3_INSTANCES_URL=https://console.layer3.cloud/app/virtual-machines
LAYER3_EMAIL=${layer3_email}
LAYER3_PASSWORD=
LAYER3_PASSWORD_BASE64=${password_base64}

INSTANCE_HOURLY_NGN=${hourly_price}
AUTO_SHUTDOWN_SECONDS=${auto_shutdown_seconds}
POST_SHUTDOWN_BILLING_CHECK_SECONDS=300
ESTIMATED_HOURS_PER_DAY=1

HEADLESS=true
DATA_DIR=/app/data
LOG_LEVEL=info
EOF

chmod 600 "${temporary}"
mv "${temporary}" "${ENV_FILE}"
trap - EXIT

mkdir -p "${PROJECT_DIR}/data"
chmod 700 "${PROJECT_DIR}/data"

cd "${PROJECT_DIR}"
docker compose build
docker compose run --rm --user root --entrypoint sh bot -c \
  'chown -R pwuser:pwuser /app/data && chmod 700 /app/data'
docker compose up -d

echo
echo "机器人已启动。"
echo "查看日志：./scripts/logs.sh"
echo "停止机器人：./scripts/stop.sh"
echo "账号配置文件：${ENV_FILE}（权限 600，禁止提交到 GitHub）"
