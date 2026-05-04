# GitHub Webhook Production Operations

This guide covers production supervision and durable relay queue operations for the SpecRail GitHub webhook app.

## Process supervision

Run the GitHub webhook app under a process supervisor such as systemd, Docker Compose, Kubernetes, or another deployment manager. The supervisor should:

- restart the app on failure
- preserve environment-based secrets outside the repository
- send stdout/stderr to centralized logs
- expose the webhook port only through the intended reverse proxy or private network boundary
- keep `SPECRAIL_API_BASE_URL` reachable from the GitHub app process

A minimal systemd-style shape looks like this. For a container-oriented template, see [GitHub Webhook Docker Compose Example](./github-docker-compose-example.md).

```ini
[Unit]
Description=SpecRail GitHub webhook app
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/specrail
EnvironmentFile=/etc/specrail/github.env
ExecStart=/usr/bin/pnpm --filter @specrail/github start
Restart=on-failure
RestartSec=5s
User=specrail
Group=specrail

[Install]
WantedBy=multi-user.target
```

Treat this as a template only. Adjust paths, package manager invocation, user/group, network policy, and secret management for the deployment.

## Durable terminal relay queue

When terminal outcome comments are enabled, configure:

```sh
GITHUB_FOLLOW_TERMINAL_EVENTS=true
GITHUB_RELAY_QUEUE_PATH=/var/lib/specrail/github-relay-queue.json
```

With both `GITHUB_RELAY_QUEUE_PATH` and GitHub comment credentials configured, the webhook app creates a JSON-file queue and polls it every 5 seconds. On each poll, `processGitHubRelayQueue` checks queued/retryable jobs, reads SpecRail run events, and posts exactly one terminal outcome comment when the run reaches `completed`, `failed`, or `cancelled`.

Use persistent storage for the queue path so relay jobs survive process restarts. The file should be writable by the GitHub app user and should not live in ephemeral container scratch space unless a persistent volume is mounted there.

## Credential prerequisites

Terminal outcome comments require a GitHub issue-comment client. Configure one of the supported token paths:

- `GITHUB_TOKEN`
- `GITHUB_INSTALLATION_TOKEN`
- GitHub App flow with `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY`

If no GitHub comment credentials are configured, the webhook can still start SpecRail runs, but durable terminal relay polling will not process comment jobs.

## Restart behavior

On restart, the app reloads the JSON-file relay queue from `GITHUB_RELAY_QUEUE_PATH`. Jobs that are still queued or retryable remain eligible for processing. Failed attempts retain `lastError`, attempt count, and retry timing in the queue file.

Operational checks after a restart:

1. Confirm the app is listening on `GITHUB_APP_PORT` and `GITHUB_WEBHOOK_PATH`.
2. Confirm the process user can read/write `GITHUB_RELAY_QUEUE_PATH`.
3. Confirm `SPECRAIL_API_BASE_URL` is reachable.
4. Confirm GitHub credentials can post issue comments to the target repository.
5. Watch logs for `GitHub terminal outcome relay failed` and safe command diagnostics.

## Safe logging

Logs may include diagnostic codes, repository names, issue numbers, sender logins, and sanitized error messages. Do not log or paste:

- GitHub tokens, installation tokens, App private keys, JWTs, webhook secrets, or signatures
- raw webhook bodies or request headers
- private org/team membership details
- execution transcripts beyond the existing SpecRail event/report access policy

## Related docs

- [GitHub App setup](./github-app-setup.md)
- [GitHub command troubleshooting](./github-command-troubleshooting.md)
- [Hosted Operator UI deployment](./operator-ui-deployment.md)
