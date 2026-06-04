#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_SOURCE="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash deploy/ubuntu/install-server.sh"
  exit 1
fi

APP_USER="${APP_USER:-synchrohrm}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_DIR="${APP_DIR:-/opt/synchrohrm}"
APP_DATA_DIR="${APP_DATA_DIR:-/var/lib/synchrohrm}"
APP_ENV_DIR="${APP_ENV_DIR:-/etc/synchrohrm}"
SERVICE_NAME="${SERVICE_NAME:-synchrohrm}"
APP_ENV_FILE="${APP_ENV_FILE:-${APP_ENV_DIR}/${SERVICE_NAME}.env}"
APP_REPO_SOURCE="${APP_REPO_SOURCE:-${DEFAULT_REPO_SOURCE}}"
APP_GIT_REMOTE="${APP_GIT_REMOTE:-}"
APP_GIT_BRANCH="${APP_GIT_BRANCH:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"

export DEBIAN_FRONTEND=noninteractive

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

assert_safe_app_dir() {
  case "${APP_DIR}" in
    ""|"/"|"/opt"|"/var"|"/etc")
      fail "APP_DIR looks unsafe: ${APP_DIR}"
      ;;
  esac
}

ensure_nodejs() {
  echo "[1/8] Installing OS packages"
  apt-get update
  apt-get install -y ca-certificates curl git gnupg build-essential

  echo "[2/8] Installing Node.js ${NODE_MAJOR}.x"
  install -d -m 0755 /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  fi

  cat >/etc/apt/sources.list.d/nodesource.list <<EOF
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF

  apt-get update
  apt-get install -y nodejs
}

detect_git_source() {
  if [[ -d "${APP_REPO_SOURCE}/.git" ]]; then
    [[ -n "${APP_GIT_REMOTE}" ]] || APP_GIT_REMOTE="$(git -C "${APP_REPO_SOURCE}" remote get-url origin 2>/dev/null || true)"
    [[ -n "${APP_GIT_BRANCH}" ]] || APP_GIT_BRANCH="$(git -C "${APP_REPO_SOURCE}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  fi

  [[ -n "${APP_GIT_REMOTE}" ]] || fail "Set APP_GIT_REMOTE to the repository URL so /opt/synchrohrm can use git pull."

  if [[ -z "${APP_GIT_BRANCH}" || "${APP_GIT_BRANCH}" == "HEAD" ]]; then
    APP_GIT_BRANCH="main"
  fi
}

ensure_service_account() {
  echo "[3/8] Creating service account"
  if ! getent group "${APP_GROUP}" >/dev/null; then
    groupadd --system "${APP_GROUP}"
  fi

  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "${APP_GROUP}" \
      --home-dir "${APP_DIR}" \
      --create-home \
      --shell /usr/sbin/nologin \
      "${APP_USER}"
  fi
}

prepare_checkout() {
  echo "[4/8] Preparing checkout and runtime directories"
  assert_safe_app_dir
  install -d -m 0755 "$(dirname "${APP_DIR}")"
  install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0750 "${APP_DATA_DIR}"
  install -d -o root -g "${APP_GROUP}" -m 0750 "${APP_ENV_DIR}"

  if [[ -d "${APP_DIR}/.git" ]]; then
    echo "Existing git checkout found at ${APP_DIR}; leaving it in place."
    chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
    return
  fi

  if [[ -d "${APP_DIR}" && -n "$(find "${APP_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    fail "${APP_DIR} already exists and is not empty."
  fi

  rm -rf "${APP_DIR}"

  if [[ -d "${APP_REPO_SOURCE}/.git" ]]; then
    echo "Cloning from local git checkout ${APP_REPO_SOURCE}"
    run_as_app "git clone --branch '${APP_GIT_BRANCH}' '${APP_REPO_SOURCE}' '${APP_DIR}'"
    run_as_app "git -C '${APP_DIR}' remote set-url origin '${APP_GIT_REMOTE}'"
  else
    echo "Cloning from remote ${APP_GIT_REMOTE}"
    run_as_app "git clone --branch '${APP_GIT_BRANCH}' '${APP_GIT_REMOTE}' '${APP_DIR}'"
  fi

  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
}

build_app() {
  echo "[5/8] Installing Node dependencies"
  require_file "${APP_DIR}/package.json"
  require_file "${APP_DIR}/package-lock.json"
  run_as_app "cd '${APP_DIR}' && npm ci"

  echo "[6/8] Building application"
  run_as_app "cd '${APP_DIR}' && npm run build"
}

install_service_files() {
  local node_bin
  node_bin="$(command -v node)"
  [[ -x "${node_bin}" ]] || fail "Could not find the Node.js binary after installation."

  echo "[7/8] Installing systemd unit"
  sed \
    -e "s|__APP_USER__|$(escape_sed "${APP_USER}")|g" \
    -e "s|__APP_GROUP__|$(escape_sed "${APP_GROUP}")|g" \
    -e "s|__APP_DIR__|$(escape_sed "${APP_DIR}")|g" \
    -e "s|__APP_DATA_DIR__|$(escape_sed "${APP_DATA_DIR}")|g" \
    -e "s|__APP_ENV_FILE__|$(escape_sed "${APP_ENV_FILE}")|g" \
    -e "s|__NODE_BIN__|$(escape_sed "${node_bin}")|g" \
    "${APP_DIR}/deploy/ubuntu/synchrohrm.service" \
    >"/etc/systemd/system/${SERVICE_NAME}.service"

  if [[ ! -f "${APP_ENV_FILE}" ]]; then
    sed \
      -e "s|__APP_DATA_DIR__|$(escape_sed "${APP_DATA_DIR}")|g" \
      "${APP_DIR}/deploy/ubuntu/env.production.example" \
      >"${APP_ENV_FILE}"
    chown root:"${APP_GROUP}" "${APP_ENV_FILE}"
    chmod 0640 "${APP_ENV_FILE}"
  fi

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null
}

print_next_steps() {
  echo "[8/8] Install complete"
  cat <<EOF

Next steps:
1. Edit ${APP_ENV_FILE} with your Microsoft Graph values.
2. Start the service: sudo systemctl start ${SERVICE_NAME}
3. Watch logs: sudo journalctl -u ${SERVICE_NAME} -f

Future updates from the checkout:
1. cd ${APP_DIR}
2. sudo -u ${APP_USER} git pull --ff-only
3. sudo bash ${APP_DIR}/deploy/ubuntu/update-app.sh

EOF
}

detect_git_source
ensure_nodejs
ensure_service_account
prepare_checkout
build_app
install_service_files
print_next_steps
