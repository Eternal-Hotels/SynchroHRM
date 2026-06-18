#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash /opt/synchrohrm/deploy/ubuntu/update-app.sh"
  exit 1
fi

APP_USER="${APP_USER:-synchrohrm}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchrohrm}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/synchrohrm}"
APP_ENV_DIR="${APP_ENV_DIR:-/etc/synchrohrm}"
SERVICE_NAME="${SERVICE_NAME:-synchrohrm}"
APP_ENV_FILE="${APP_ENV_FILE:-${APP_ENV_DIR}/${SERVICE_NAME}.env}"
DO_PULL="0"

if [[ "${1:-}" == "--pull" ]]; then
  DO_PULL="1"
  shift
fi

if [[ "$#" -gt 0 ]]; then
  echo "Unknown arguments: $*" >&2
  exit 1
fi

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

run_as_app() {
  sudo -u "${APP_USER}" -- bash -lc "$1"
}

require_file() {
  local path="$1"
  [[ -f "${path}" ]] || fail "Required file is missing: ${path}"
}

render_service_unit() {
  local node_bin
  node_bin="$(command -v node)"
  [[ -x "${node_bin}" ]] || fail "Could not find the Node.js binary."

  sed \
    -e "s|__APP_USER__|$(escape_sed "${APP_USER}")|g" \
    -e "s|__APP_GROUP__|$(escape_sed "${APP_GROUP}")|g" \
    -e "s|__APP_DIR__|$(escape_sed "${APP_DIR}")|g" \
    -e "s|__APP_DATA_DIR__|$(escape_sed "${APP_DATA_DIR}")|g" \
    -e "s|__APP_ENV_FILE__|$(escape_sed "${APP_ENV_FILE}")|g" \
    -e "s|__NODE_BIN__|$(escape_sed "${node_bin}")|g" \
    "${APP_DIR}/deploy/ubuntu/synchrohrm.service" \
    >"/etc/systemd/system/${SERVICE_NAME}.service"
}

[[ -d "${APP_DIR}/.git" ]] || fail "${APP_DIR} is not a git checkout."
require_file "${APP_DIR}/package.json"
require_file "${APP_DIR}/package-lock.json"
require_file "${APP_DIR}/deploy/ubuntu/synchrohrm.service"
require_file "${APP_ENV_FILE}"

if [[ "${DO_PULL}" == "1" ]]; then
  echo "[1/5] Pulling the latest code"
  run_as_app "cd '${APP_DIR}' && git pull --ff-only"
else
  echo "[1/5] Using the existing checkout in ${APP_DIR}"
fi

echo "[2/5] Installing Node dependencies"
run_as_app "cd '${APP_DIR}' && npm ci"

echo "[3/5] Building application"
run_as_app "cd '${APP_DIR}' && npm run build"

echo "[4/5] Refreshing the service definition"
render_service_unit
systemctl daemon-reload

echo "[5/5] Restarting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
systemctl --no-pager --full status "${SERVICE_NAME}"
