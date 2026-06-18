#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash /opt/synchrohrm/deploy/fedora/update-app.sh"
  exit 1
fi

APP_USER="${APP_USER:-synchrohrm}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchrohrm}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/synchrohrm}"
APP_ENV_DIR="${APP_ENV_DIR:-/etc/synchrohrm}"
SERVICE_NAME="${SERVICE_NAME:-synchrohrm}"
APP_ENV_FILE="${APP_ENV_FILE:-${APP_ENV_DIR}/${SERVICE_NAME}.env}"
SERVER_NAME="${SERVER_NAME:-synchro.eternalhotels.com}"
TLS_CERT_DIR="${TLS_CERT_DIR:-/etc/pki/tls/certs}"
TLS_KEY_DIR="${TLS_KEY_DIR:-/etc/pki/tls/private}"
TLS_CERT_FILE="${TLS_CERT_FILE:-${TLS_CERT_DIR}/${SERVICE_NAME}.crt}"
TLS_KEY_FILE="${TLS_KEY_FILE:-${TLS_KEY_DIR}/${SERVICE_NAME}.key}"
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

require_dir() {
  local path="$1"
  [[ -d "${path}" ]] || fail "Required directory is missing: ${path}"
}

require_file() {
  local path="$1"
  [[ -f "${path}" ]] || fail "Required file is missing: ${path}"
}

run_as_app() {
  sudo -u "${APP_USER}" -- bash -lc "$1"
}

assert_safe_app_dir() {
  case "${APP_DIR}" in
    ""|"/"|"/opt"|"/var"|"/etc")
      fail "APP_DIR looks unsafe: ${APP_DIR}"
      ;;
  esac
}

assert_checkout_layout() {
  assert_safe_app_dir
  require_dir "${APP_DIR}"
  require_file "${APP_DIR}/package.json"
  require_file "${APP_DIR}/package-lock.json"
  require_file "${APP_DIR}/deploy/fedora/synchrohrm.service"
  require_file "${APP_DIR}/deploy/fedora/nginx.conf"
  require_file "${APP_ENV_FILE}"
}

ensure_clean_checkout_for_pull() {
  [[ -e "${APP_DIR}/.git" ]] || fail "${APP_DIR} does not contain .git, so --pull is unavailable."

  local git_status
  git_status="$(run_as_app "cd '${APP_DIR}' && git status --porcelain")"
  if [[ -n "${git_status}" ]]; then
    fail "Git checkout is dirty; recopy or clean the tree before using --pull."
  fi
}

pull_latest_code() {
  echo "[1/6] Pulling the latest code"
  run_as_app "cd '${APP_DIR}' && git pull --ff-only"
}

ensure_tls_certificate() {
  if [[ -f "${TLS_CERT_FILE}" && -f "${TLS_KEY_FILE}" ]]; then
    return
  fi

  install -d -o root -g root -m 0755 "${TLS_CERT_DIR}"
  install -d -o root -g root -m 0700 "${TLS_KEY_DIR}"

  openssl req \
    -x509 \
    -nodes \
    -newkey rsa:2048 \
    -sha256 \
    -days 825 \
    -subj "/CN=${SERVER_NAME}" \
    -addext "subjectAltName=DNS:${SERVER_NAME}" \
    -keyout "${TLS_KEY_FILE}" \
    -out "${TLS_CERT_FILE}"

  chmod 0600 "${TLS_KEY_FILE}"
  chmod 0644 "${TLS_CERT_FILE}"
}

reset_checkout_artifacts() {
  echo "[2/6] Resetting copied build artifacts and ownership"
  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
  rm -rf -- "${APP_DIR}/node_modules" "${APP_DIR}/dist"
}

build_app() {
  echo "[3/6] Installing Node dependencies"
  run_as_app "cd '${APP_DIR}' && npm ci"

  echo "[4/6] Building the application"
  run_as_app "cd '${APP_DIR}' && npm run build"
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
    "${APP_DIR}/deploy/fedora/synchrohrm.service" \
    >"/etc/systemd/system/${SERVICE_NAME}.service"
}

render_nginx_config() {
  sed \
    -e "s|__SERVER_NAME__|$(escape_sed "${SERVER_NAME}")|g" \
    -e "s|__TLS_CERT_FILE__|$(escape_sed "${TLS_CERT_FILE}")|g" \
    -e "s|__TLS_KEY_FILE__|$(escape_sed "${TLS_KEY_FILE}")|g" \
    "${APP_DIR}/deploy/fedora/nginx.conf" \
    >"/etc/nginx/conf.d/${SERVICE_NAME}.conf"
}

refresh_service_files() {
  echo "[5/6] Refreshing systemd and nginx configuration"
  ensure_tls_certificate
  render_service_unit
  render_nginx_config
  nginx -t
  systemctl daemon-reload
}

restart_services() {
  echo "[6/6] Reloading nginx and restarting ${SERVICE_NAME}"
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl start nginx
  fi
  systemctl restart "${SERVICE_NAME}"
  systemctl --no-pager --full status "${SERVICE_NAME}"
}

assert_checkout_layout

if [[ "${DO_PULL}" == "1" ]]; then
  ensure_clean_checkout_for_pull
  pull_latest_code
else
  echo "[1/6] Using the recopied checkout in ${APP_DIR}"
fi

reset_checkout_artifacts
build_app
refresh_service_files
restart_services
