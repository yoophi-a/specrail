# Systemd Deployment Templates

This guide provides target-specific systemd templates for running SpecRail on a single host. It complements [Production deployment topology](./production-deployment-topology.md): read the topology guide first, then adapt these units to the host's paths, user, package manager, reverse proxy, and secret manager.

The current repository does not publish production container images or package-level `start` scripts. These templates run the TypeScript entrypoints with `node --import tsx` from a checked-out release directory. If a future release adds compiled runtime entrypoints, replace the `ExecStart` lines with the packaged commands.

## Host Layout

Recommended host-owned paths:

```text
/opt/specrail                         # checked-out release or deployment artifact
/etc/specrail/specrail-api.env        # API env file
/etc/specrail/specrail-github.env     # GitHub webhook env file
/etc/specrail/specrail-telegram.env   # Telegram webhook env file
/var/lib/specrail                     # API-owned durable state
/var/lib/specrail/repo-visible        # repo-visible artifact mirror
/var/lib/specrail/workspaces          # execution workspaces
/var/lib/specrail-github/relay-queue  # durable GitHub relay queue
```

Create a dedicated service user:

```sh
sudo useradd --system --home /var/lib/specrail --shell /usr/sbin/nologin specrail
sudo install -d -o specrail -g specrail -m 0750 /var/lib/specrail /var/lib/specrail/repo-visible /var/lib/specrail/workspaces
sudo install -d -o specrail -g specrail -m 0750 /var/lib/specrail-github /var/lib/specrail-github/relay-queue
sudo install -d -o root -g specrail -m 0750 /etc/specrail
```

Keep env files readable by root and the `specrail` group only:

```sh
sudo chown root:specrail /etc/specrail/specrail-*.env
sudo chmod 0640 /etc/specrail/specrail-*.env
```

## API Unit

`/etc/specrail/specrail-api.env`:

```sh
SPECRAIL_PORT=4000
SPECRAIL_DATA_DIR=/var/lib/specrail
SPECRAIL_REPO_ARTIFACT_DIR=/var/lib/specrail/repo-visible
SPECRAIL_EXECUTION_WORKSPACE_MODE=directory
SPECRAIL_EXECUTION_WORKSPACE_ROOT=/var/lib/specrail/workspaces
SPECRAIL_EXECUTION_BACKEND=codex
SPECRAIL_EXECUTION_PROFILE=default
```

`/etc/systemd/system/specrail-api.service`:

```ini
[Unit]
Description=SpecRail API and hosted operator UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/specrail
EnvironmentFile=/etc/specrail/specrail-api.env
ExecStart=/usr/bin/node --import tsx apps/api/src/index.ts
Restart=on-failure
RestartSec=5s
User=specrail
Group=specrail
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/specrail
ReadOnlyPaths=/opt/specrail
RuntimeDirectory=specrail-api

[Install]
WantedBy=multi-user.target
```

Put `/operator` and the API routes behind the authenticated reverse proxy described in [Hosted Operator UI deployment](./operator-ui-deployment.md).

## GitHub Webhook Unit

`/etc/specrail/specrail-github.env`:

```sh
GITHUB_APP_PORT=4200
GITHUB_WEBHOOK_PATH=/github/webhook
SPECRAIL_API_BASE_URL=http://127.0.0.1:4000
SPECRAIL_OPERATOR_BASE_URL=https://specrail.example.com
SPECRAIL_GITHUB_REPOSITORY_PROJECTS=owner/repo=project-default
GITHUB_ALLOWED_ACTORS=maintainer-login
GITHUB_FOLLOW_TERMINAL_EVENTS=true
GITHUB_RELAY_QUEUE_DIR=/var/lib/specrail-github/relay-queue

# Provide one supported GitHub credential path.
GITHUB_WEBHOOK_SECRET=replace-with-secret-manager-value
GITHUB_TOKEN=replace-with-secret-manager-value
```

`/etc/systemd/system/specrail-github.service`:

```ini
[Unit]
Description=SpecRail GitHub webhook adapter
After=network-online.target specrail-api.service
Wants=network-online.target
Requires=specrail-api.service

[Service]
Type=simple
WorkingDirectory=/opt/specrail
EnvironmentFile=/etc/specrail/specrail-github.env
ExecStart=/usr/bin/node --import tsx apps/github/src/index.ts
Restart=on-failure
RestartSec=5s
User=specrail
Group=specrail
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/specrail-github
ReadOnlyPaths=/opt/specrail
RuntimeDirectory=specrail-github

[Install]
WantedBy=multi-user.target
```

Expose only `GITHUB_WEBHOOK_PATH` through the public reverse proxy. Do not put operator authentication in front of GitHub webhook delivery; the app validates GitHub signatures.

## Telegram Unit

`/etc/specrail/specrail-telegram.env`:

```sh
TELEGRAM_APP_PORT=4300
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
SPECRAIL_API_BASE_URL=http://127.0.0.1:4000
SPECRAIL_TELEGRAM_PROJECT_ID=project-default
TELEGRAM_BOT_TOKEN=replace-with-secret-manager-value
```

`/etc/systemd/system/specrail-telegram.service`:

```ini
[Unit]
Description=SpecRail Telegram webhook adapter
After=network-online.target specrail-api.service
Wants=network-online.target
Requires=specrail-api.service

[Service]
Type=simple
WorkingDirectory=/opt/specrail
EnvironmentFile=/etc/specrail/specrail-telegram.env
ExecStart=/usr/bin/node --import tsx apps/telegram/src/index.ts
Restart=on-failure
RestartSec=5s
User=specrail
Group=specrail
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/specrail
ReadOnlyPaths=/opt/specrail
RuntimeDirectory=specrail-telegram

[Install]
WantedBy=multi-user.target
```

Expose only `TELEGRAM_WEBHOOK_PATH` through the public reverse proxy.

## Enable And Validate

Install dependencies and run the baseline validation before enabling services:

```sh
cd /opt/specrail
pnpm install --frozen-lockfile
pnpm validate
```

Then enable the units:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now specrail-api
sudo systemctl enable --now specrail-github
sudo systemctl enable --now specrail-telegram
```

Basic checks:

```sh
systemctl status specrail-api specrail-github specrail-telegram
curl -fsS http://127.0.0.1:4000/healthz
curl -fsS http://127.0.0.1:4200/healthz
curl -fsS http://127.0.0.1:4300/healthz
```

After the reverse proxy is configured, use GitHub's test delivery to validate webhook signature handling and check:

```sh
journalctl -u specrail-github -n 100 --no-pager
find /var/lib/specrail-github/relay-queue -maxdepth 2 -type f
```

## Operational Notes

- Keep `/opt/specrail` read-only to the service user after deployment.
- Keep env files out of Git and redact them from support requests.
- Run `pnpm validate` on the release artifact before restarting production services.
- Rotate GitHub and Telegram credentials through the env files or the platform secret manager, then restart the affected unit.
- If API state or relay queues live on mounted storage, configure the mount before the services start.
- For horizontally scaled GitHub webhook workers across independent hosts, use the PostgreSQL relay backend described in [GitHub webhook production operations](./github-production-ops.md).
