#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"
test -f .env || { echo "请先运行 ./scripts/setup.sh" >&2; exit 1; }
docker compose up -d --build
