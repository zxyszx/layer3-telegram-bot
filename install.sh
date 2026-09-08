#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zxyszx/layer3-telegram-bot.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/layer3-telegram-bot}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    red "需要 root 权限，请使用 root 用户运行，或先安装 sudo。"
    exit 1
  fi
}

install_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi

  yellow "未检测到 Git，正在安装..."
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y git ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y git ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y git ca-certificates curl
  else
    red "无法自动安装 Git，请先手动安装 Git 后重试。"
    exit 1
  fi
}

install_docker_prompt() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi

  yellow "未检测到 Docker 或 Docker Compose 插件。"
  read -r -p "是否使用 Docker 官方脚本自动安装？输入 y 确认: " answer
  if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
    cat <<'EOF'

请先安装 Docker 后重新运行一键安装命令：
  curl -fsSL https://raw.githubusercontent.com/zxyszx/layer3-telegram-bot/main/install.sh | bash
EOF
    exit 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    red "未检测到 curl，请先安装 curl 后重试。"
    exit 1
  fi

  curl -fsSL https://get.docker.com | run_as_root bash
  run_as_root systemctl enable --now docker || true

  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    red "Docker 安装后仍不可用，请检查服务器环境。"
    exit 1
  fi
}

sync_repo() {
  local parent_dir
  parent_dir="$(dirname "${INSTALL_DIR}")"
  run_as_root mkdir -p "${parent_dir}"

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    green "检测到已安装目录，正在更新代码..."
    git -C "${INSTALL_DIR}" pull --ff-only
  elif [[ -e "${INSTALL_DIR}" ]]; then
    red "${INSTALL_DIR} 已存在但不是 Git 仓库，请先备份或删除该目录。"
    exit 1
  else
    green "正在拉取项目到 ${INSTALL_DIR} ..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

main() {
  install_git
  install_docker_prompt
  sync_repo

  chmod +x "${INSTALL_DIR}"/scripts/*.sh
  green "安装文件已准备好。"
  cd "${INSTALL_DIR}"
  exec ./scripts/setup.sh install
}

main "$@"
