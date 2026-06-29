# Production Deployment Topology

This guide is the first stop before choosing a concrete SpecRail deployment target. It explains the service boundaries, network exposure, persistent storage, secret handling, and validation checks that apply whether the final runtime is systemd, Docker Compose, Kubernetes, or another supervisor.

SpecRail is still an operator-facing control plane, not a public multi-tenant service. Put authentication, TLS, and network policy in front of it before exposing any operator routes.

## Service Boundaries

```text
operators / thin clients
  -> authenticated HTTPS reverse proxy
     -> specrail-api
          - /healthz
          - /operator
          - /projects, /tracks, /runs
          - /approval-requests
          - /runs/:runId/events/stream

GitHub webhooks
  -> public HTTPS reverse proxy route
     -> specrail-github
          - /healthz
          - verifies GitHub signature
          - starts runs through specrail-api
          - queues terminal outcome comments

Telegram webhooks
  -> public HTTPS reverse proxy route
     -> specrail-telegram
          - /healthz
          - translates Telegram messages into track/run calls
          - relays run events back to Telegram

local operators / automation
  -> specrail-terminal
     -> specrail-api
```

The API owns canonical state. GitHub, Telegram, ACP, and terminal clients are thin surfaces over the HTTP/SSE contract.

## Recommended Process Layout

| Process | Publicly reachable | Required upstream | Persistent state |
| --- | --- | --- | --- |
| `specrail-api` | No, except through authenticated operator/API routes | local filesystem, configured executor CLIs | `SPECRAIL_DATA_DIR`, `SPECRAIL_REPO_ARTIFACT_DIR`, execution workspaces |
| `specrail-github` | Yes, only at `GITHUB_WEBHOOK_PATH` | `specrail-api`, GitHub REST API | durable relay queue when terminal comments are enabled |
| `specrail-telegram` | Yes, only at `TELEGRAM_WEBHOOK_PATH` | `specrail-api`, Telegram Bot API | none beyond API-owned channel bindings and attachments |
| `specrail-terminal` | No | `specrail-api` | optional terminal preferences/templates/diff export files |

Run each long-lived server under a supervisor that restarts on failure and sends stdout/stderr to centralized logs. The terminal client can stay an operator tool instead of a daemon unless the deployment creates a separate automation wrapper around it.

## Network Exposure

Expose only these routes outside the private service network:

- `/operator` and the API routes it calls, behind TLS and operator authentication.
- `/runs/:runId/events/stream`, behind the same operator authentication with proxy buffering disabled.
- `GITHUB_WEBHOOK_PATH`, without operator auth, but with GitHub signature verification in the app.
- `TELEGRAM_WEBHOOK_PATH`, without operator auth, but reachable only through the Telegram webhook URL you configure.

Do not expose provider execution workspaces, `.specrail-data`, relay queue storage, raw session logs, or service env files through the web server.

## Persistent Storage

The API process needs durable local or mounted storage for:

- `SPECRAIL_DATA_DIR`
- `SPECRAIL_REPO_ARTIFACT_DIR`
- execution workspace roots when `SPECRAIL_EXECUTION_WORKSPACE_MODE=directory` or `git_worktree`

The GitHub process needs durable relay storage if terminal outcome comments must survive restarts:

- `GITHUB_RELAY_QUEUE_DIR` for one host or a shared POSIX-compatible volume
- `GITHUB_RELAY_QUEUE_BACKEND=postgres` plus `GITHUB_RELAY_QUEUE_POSTGRES_URL` for independent hosts
- `GITHUB_RELAY_QUEUE_PATH` only for local development or a single process

Back up API-owned state and relay queue storage together if terminal outcome comments matter operationally.

## Secret Handling

Keep these values in the platform secret manager or protected env files:

- provider credentials used by the execution backend
- `GITHUB_WEBHOOK_SECRET`
- GitHub tokens, installation tokens, App IDs, installation IDs, and private keys
- `TELEGRAM_BOT_TOKEN`
- database URLs and relay queue credentials
- reverse-proxy authentication secrets

Do not place secrets in compose labels, public logs, GitHub issues, or generated run reports.

## Deployment Shape Selection

Use the existing deployment docs based on the target surface:

- Start with [Hosted Operator UI deployment](./operator-ui-deployment.md) for TLS, auth, route protection, and SSE proxying.
- Use [Container image publishing contract](./container-image-publishing.md) for service image names, tag policy, runtime expectations, and future publish workflow requirements.
- Use [GitHub App setup](./github-app-setup.md) for webhook command configuration and repository/project mapping.
- Use [GitHub webhook production operations](./github-production-ops.md) for durable relay queues, restart behavior, and safe diagnostics.
- Use [GitHub webhook Docker Compose example](./github-docker-compose-example.md) as a container-oriented template for API and GitHub services.
- Use [Kubernetes deployment skeleton](./kubernetes-deployment.md) as a cluster-oriented template for API, GitHub, and Telegram services.
- Use [Troubleshooting](./troubleshooting.md) for startup, connection, and adapter checks.

If the target platform is not chosen yet, prefer a single-host deployment with `specrail-api`, `specrail-github`, and `specrail-telegram` behind one reverse proxy. Move to PostgreSQL relay storage before scaling GitHub webhook workers across independent hosts.

## Health And Validation Checks

Before exposing webhooks or operator links:

1. Run `pnpm validate` during build or release verification.
2. Start `specrail-api`, `specrail-github`, and `specrail-telegram`, then confirm each service returns `200` from `GET /healthz`.
3. Confirm `SPECRAIL_DATA_DIR` and `SPECRAIL_REPO_ARTIFACT_DIR` are writable.
4. Confirm the authenticated `/operator` route loads and `GET /runs/:runId/events/stream` is not buffered by the proxy.
5. Confirm the GitHub webhook route rejects invalid signatures and accepts a test delivery with the configured path.
6. Confirm GitHub terminal relay queue storage is writable and survives a process restart.
7. Confirm the Telegram webhook route is reachable from Telegram when the adapter is enabled.
8. Confirm logs redact secrets and do not include raw webhook bodies, provider tokens, or execution transcripts.

## Remaining Manifest Work

This document defines the topology and invariants. Target-specific manifests are still separate work:

- hardened systemd unit files for API, GitHub, and Telegram processes
- image build/publish workflow implementation and runtime user permissions
- production metrics endpoints beyond the current injectable sinks
