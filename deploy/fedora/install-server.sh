#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash /opt/synchrohrm/deploy/fedora/install-server.sh"
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
NODE_MAJOR_MIN="${NODE_MAJOR_MIN:-22}"
FIREWALL_ZONES="${FIREWALL_ZONES:-}"

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

get_firewall_zones() {
  if [[ -n "${FIREWALL_ZONES}" ]]; then
    printf '%s\n' "${FIREWALL_ZONES}" | tr ', ' '\n' | sed '/^$/d'
    return
  fi

  firewall-cmd --get-active-zones \
    | awk 'NR % 2 == 1 { print $1 }'
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
  require_file "${APP_DIR}/deploy/fedora/env.production.example"
}

ensure_packages() {
  echo "[1/9] Installing Fedora packages"
  dnf install -y git nginx nodejs npm openssl firewalld policycoreutils policycoreutils-python-utils

  local node_version
  local node_major
  node_version="$(node --version 2>/dev/null | sed 's/^v//')"
  [[ -n "${node_version}" ]] || fail "Node.js was not installed correctly."
  node_major="${node_version%%.*}"
  [[ "${node_major}" =~ ^[0-9]+$ ]] || fail "Could not parse Node.js version: ${node_version}"
  if (( node_major < NODE_MAJOR_MIN )); then
    fail "Node.js ${NODE_MAJOR_MIN}+ is required; found ${node_version}."
  fi
}

ensure_service_account() {
  echo "[2/9] Creating the service account"
  if ! getent group "${APP_GROUP}" >/dev/null; then
    groupadd --system "${APP_GROUP}"
  fi

  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "${APP_GROUP}" \
      --home-dir "${APP_DIR}" \
      --no-create-home \
      --shell /sbin/nologin \
      "${APP_USER}"
  fi
}

prepare_directories() {
  echo "[3/9] Preparing application directories"
  install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0750 "${APP_DATA_DIR}"
  install -d -o root -g "${APP_GROUP}" -m 0750 "${APP_ENV_DIR}"
  install -d -o root -g root -m 0755 "${TLS_CERT_DIR}"
  install -d -o root -g root -m 0700 "${TLS_KEY_DIR}"
  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
}

ensure_tls_certificate() {
  echo "[4/9] Ensuring the self-signed TLS certificate exists"
  if [[ -f "${TLS_CERT_FILE}" && -f "${TLS_KEY_FILE}" ]]; then
    return
  fi

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
  echo "[5/9] Removing copied build artifacts"
  rm -rf -- "${APP_DIR}/node_modules" "${APP_DIR}/dist"
}

build_app() {
  echo "[6/9] Installing Node dependencies"
  run_as_app "cd '${APP_DIR}' && npm ci"

  echo "[7/9] Building the application"
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

install_service_files() {
  echo "[8/9] Installing systemd and nginx configuration"
  render_service_unit
  render_nginx_config

  if [[ ! -f "${APP_ENV_FILE}" ]]; then
    sed \
      -e "s|__APP_DATA_DIR__|$(escape_sed "${APP_DATA_DIR}")|g" \
      "${APP_DIR}/deploy/fedora/env.production.example" \
      >"${APP_ENV_FILE}"
    chown root:"${APP_GROUP}" "${APP_ENV_FILE}"
    chmod 0640 "${APP_ENV_FILE}"
  fi

  nginx -t
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null
  systemctl enable --now nginx >/dev/null
}

configure_host_access() {
  echo "[9/9] Configuring SELinux and firewall rules"
  if command -v getenforce >/dev/null && [[ "$(getenforce)" != "Disabled" ]]; then
    setsebool -P httpd_can_network_connect 1
  fi

  systemctl enable --now firewalld >/dev/null

  mapfile -t firewall_zones < <(get_firewall_zones)
  if [[ "${#firewall_zones[@]}" -eq 0 ]]; then
    fail "firewalld has no active zones. Set FIREWALL_ZONES explicitly or attach the interface to a zone first."
  fi

  for zone in "${firewall_zones[@]}"; do
    firewall-cmd --zone="${zone}" --permanent --add-service=http >/dev/null
    firewall-cmd --zone="${zone}" --permanent --add-service=https >/dev/null
  done

  firewall-cmd --reload >/dev/null
}

print_next_steps() {
  cat <<EOF

Install complete.

Next steps:
1. Review ${APP_ENV_FILE} and replace the placeholder values.
2. Start the app service: sudo systemctl start ${SERVICE_NAME}
3. Check the service and proxy:
   sudo systemctl status ${SERVICE_NAME} nginx
   sudo journalctl -u ${SERVICE_NAME} -f
   curl http://127.0.0.1:3000/health
   curl -k https://${SERVER_NAME}/health

Future updates:
- WinSCP recopy: sudo bash ${APP_DIR}/deploy/fedora/update-app.sh
- Git pull path: cd ${APP_DIR} && sudo -u ${APP_USER} git pull --ff-only && sudo bash deploy/fedora/update-app.sh

EOF
}

assert_checkout_layout
ensure_packages
ensure_service_account
prepare_directories
ensure_tls_certificate
reset_checkout_artifacts
build_app
install_service_files
configure_host_access
print_next_steps
