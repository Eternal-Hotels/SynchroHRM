# Ubuntu deployment

This bundle installs SynchroHRM as:

- a `synchrohrm` service account
- a real Git checkout at `/opt/synchrohrm`
- persistent app data under `/var/lib/synchrohrm`
- a `systemd` service named `synchrohrm`

That layout is what makes this update flow work cleanly:

```bash
cd /opt/synchrohrm
sudo -u synchrohrm git pull --ff-only
sudo bash /opt/synchrohrm/deploy/ubuntu/update-app.sh
```

## Why the layout looks like this

- `/opt/synchrohrm` stays a Git checkout, so you can pull code in place.
- `/etc/synchrohrm/synchrohrm.env` holds secrets outside the repo.
- `/var/lib/synchrohrm` holds the SQLite database plus archived, parsed, quarantine, and export files outside the repo.
- The service runs with `NODE_ENV=production`, which matches the app's production login behavior.

## Requirements

- Ubuntu 22.04 or 24.04
- `sudo` access
- network access to the Git remote you want `/opt/synchrohrm` to track
- Node.js 22.x

Node 22.x is required because the app imports `node:sqlite`.

## First install

From a checked-out repo:

```bash
cd /path/to/SynchroHRM
sudo bash deploy/ubuntu/install-server.sh
```

If the local checkout does not have a usable `origin`, set it explicitly:

```bash
cd /path/to/SynchroHRM
sudo APP_GIT_REMOTE=git@github.com:your-org/SynchroHRM.git \
  APP_GIT_BRANCH=main \
  bash deploy/ubuntu/install-server.sh
```

Useful overrides:

- `APP_DIR=/opt/somewhere-else`
- `APP_DATA_DIR=/var/lib/somewhere-else`
- `APP_ENV_FILE=/etc/somewhere-else/app.env`
- `APP_USER=customuser`
- `SERVICE_NAME=custom-service-name`

## After install

1. Edit `/etc/synchrohrm/synchrohrm.env`.
2. Start the service:

```bash
sudo systemctl start synchrohrm
```

3. Check the service:

```bash
sudo systemctl status synchrohrm
sudo journalctl -u synchrohrm -f
curl http://127.0.0.1:3000/health
```

## Updating

Normal update flow:

```bash
cd /opt/synchrohrm
sudo -u synchrohrm git pull --ff-only
sudo bash ./deploy/ubuntu/update-app.sh
```

One-command variant:

```bash
sudo bash /opt/synchrohrm/deploy/ubuntu/update-app.sh --pull
```

The update script:

- installs dependencies with `npm ci`
- rebuilds `dist/`
- refreshes the `systemd` unit from the repo template
- restarts the service

## App-specific notes

- The app listens on port `3000` by default.
- The database path becomes `/var/lib/synchrohrm/synchro-ingestion.sqlite` unless you override `SYNCHRO_DATA_DIR`.
- On a brand-new database, the app seeds the default admin account as `admin` with password `ehSynchroAdmin2021!`. Change that immediately after first login.
