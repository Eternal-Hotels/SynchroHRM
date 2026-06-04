# Fedora deployment

This bundle installs SynchroHRM on Fedora as:

- a `synchrohrm` service account
- a live checkout at `/opt/synchrohrm`
- persistent app data under `/var/lib/synchrohrm`
- server-only secrets in `/etc/synchrohrm/synchrohrm.env`
- a `systemd` service named `synchrohrm`
- an `nginx` reverse proxy with a self-signed certificate for `synchro.eternalhotels.com`

It assumes you copy the repo to `/opt/synchrohrm` with WinSCP first, including `.git` when you want the optional Git update path later.

## Requirements

- Fedora with `sudo` access
- local DNS resolving `synchro.eternalhotels.com` to the Fedora host
- internal client machines that can trust the self-signed certificate

## First install

1. Copy the repo to `/opt/synchrohrm`.
2. Run:

```bash
sudo bash /opt/synchrohrm/deploy/fedora/install-server.sh
```

The install script:

- installs Fedora packages for Node, `nginx`, TLS, `firewalld`, and SELinux tooling
- creates the `synchrohrm` user and runtime directories
- generates the self-signed certificate if one does not already exist
- removes copied `node_modules` and `dist`, then rebuilds them on Fedora
- installs the `systemd` and `nginx` configs

## After install

1. Edit `/etc/synchrohrm/synchrohrm.env`.
2. Start the app:

```bash
sudo systemctl start synchrohrm
```

3. Verify the app and proxy:

```bash
sudo systemctl status synchrohrm nginx
sudo journalctl -u synchrohrm -f
curl http://127.0.0.1:3000/health
curl -k https://synchro.eternalhotels.com/health
```

The service forces `SYNCHRO_SKIP_DOTENV=1`, so `/etc/synchrohrm/synchrohrm.env` stays authoritative even if the copied repo still contains a local `.env`.

## Updating

WinSCP-first update flow:

1. Recopy the repo into `/opt/synchrohrm`.
2. Run:

```bash
sudo bash /opt/synchrohrm/deploy/fedora/update-app.sh
```

The update script resets ownership, removes copied `node_modules` and `dist`, rebuilds on Fedora, refreshes the service and proxy config, reloads `nginx`, and restarts `synchrohrm`.

## Optional Git update path

If the copied checkout includes a working `.git` directory and a valid `origin`, you can update in place with:

```bash
cd /opt/synchrohrm
sudo -u synchrohrm git pull --ff-only
sudo bash deploy/fedora/update-app.sh
```

Or use the one-command variant:

```bash
sudo bash /opt/synchrohrm/deploy/fedora/update-app.sh --pull
```

`--pull` refuses to run when `git status --porcelain` is not empty, so the Git path stays reserved for clean checkouts.
