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

When terminal outcome comments are enabled, configure one durable relay queue backend:

```sh
GITHUB_FOLLOW_TERMINAL_EVENTS=true
GITHUB_RELAY_QUEUE_DIR=/var/lib/specrail/github-relay-queue
```

`GITHUB_RELAY_QUEUE_DIR` is the preferred production filesystem backend. It stores one JSON job file per relay item under `pending/`, `running/`, `completed/`, and `failed/` subdirectories. Claiming a pending job uses an atomic file rename, so multiple webhook worker processes on the same host or shared POSIX-compatible volume do not claim the same job concurrently.

For local development or single-process deployments, the legacy JSON-file queue remains available:

```sh
GITHUB_FOLLOW_TERMINAL_EVENTS=true
GITHUB_RELAY_QUEUE_PATH=/var/lib/specrail/github-relay-queue.json
```

For horizontally scaled webhook workers on independent hosts, use the PostgreSQL backend:

```sh
GITHUB_FOLLOW_TERMINAL_EVENTS=true
GITHUB_RELAY_QUEUE_BACKEND=postgres
GITHUB_RELAY_QUEUE_POSTGRES_URL=postgres://specrail:secret@postgres.example/specrail
GITHUB_RELAY_QUEUE_POSTGRES_TABLE=github_relay_jobs
```

When `GITHUB_RELAY_QUEUE_BACKEND=postgres`, the app requires `GITHUB_RELAY_QUEUE_POSTGRES_URL` or `DATABASE_URL`. `GITHUB_RELAY_QUEUE_POSTGRES_TABLE` defaults to `github_relay_jobs`; only lowercase identifiers with letters, digits, and underscores are accepted.

With `GITHUB_RELAY_QUEUE_DIR`, `GITHUB_RELAY_QUEUE_POSTGRES_URL`/`DATABASE_URL`, or `GITHUB_RELAY_QUEUE_PATH` and GitHub comment credentials configured, the webhook app creates a durable queue and polls it every 5 seconds. On each poll, `processGitHubRelayQueue` checks queued/retryable jobs, reads SpecRail run events, and posts exactly one terminal outcome comment when the run reaches `completed`, `failed`, or `cancelled`.

Use persistent storage for the queue path/directory so relay jobs survive process restarts. The location should be writable by the GitHub app user and should not live in ephemeral container scratch space unless a persistent volume is mounted there.

## Queue backend selection

Choose the terminal relay queue backend based on how webhook workers share state:

| Deployment shape | Recommended backend | Why |
| --- | --- | --- |
| Local development or one webhook process | `GITHUB_RELAY_QUEUE_PATH` | Simple JSON-file persistence is enough when only one process can claim work. |
| One host with multiple webhook processes | `GITHUB_RELAY_QUEUE_DIR` | Per-job files plus atomic renames avoid duplicate claims on a POSIX-compatible local filesystem. |
| Multiple hosts with one shared POSIX-compatible volume | `GITHUB_RELAY_QUEUE_DIR` | The directory queue remains valid when the shared volume preserves atomic rename semantics. |
| Multiple independent hosts with no shared filesystem | `GITHUB_RELAY_QUEUE_BACKEND=postgres` | Workers use a common transactional table with `FOR UPDATE SKIP LOCKED` claims, retries, completion, and failed-job retention. |

PostgreSQL is the first external backend target. SpecRail already treats file-backed state as durable operational history, and a database queue gives the closest migration path: jobs remain inspectable, completion/failure records can be retained without a second audit store, and atomic claim semantics are expressed with row locks. Redis and provider queues may still be useful later for high-throughput deployments, but they introduce retention and visibility differences that are unnecessary for the first horizontally scaled GitHub relay implementation.

Create the PostgreSQL table before starting the app; SpecRail does not run this migration automatically:

```sql
CREATE TABLE github_relay_jobs (
  id text PRIMARY KEY,
  repository_full_name text NOT NULL,
  issue_number integer NOT NULL,
  run_id text NOT NULL,
  report_url text,
  operator_url text,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  last_error text
);

CREATE INDEX github_relay_jobs_claim_idx
  ON github_relay_jobs (status, next_attempt_at, created_at)
  WHERE status = 'pending';
```

The database contract is:

- Store each relay job with the same fields as `GitHubTerminalRelayJob`: id, repository, issue number, run id, optional report/operator URLs, status, attempts, timestamps, next retry time, and sanitized last error.
- Claim exactly one due job by moving it from `pending` to `running` inside a transaction, recording a lease deadline or updated timestamp so abandoned work can be retried safely.
- Complete a job by marking it `completed` instead of deleting it, preserving the terminal relay audit trail.
- Fail a job by recording a sanitized error, incrementing attempts, and either returning it to `pending` with exponential backoff or marking it `failed` after the retry limit.
- Keep `list` read-only so operators can inspect queue state without changing claim eligibility.
- Avoid exposing webhook secrets, GitHub tokens, private keys, raw payloads, or execution transcripts in queue rows, logs, or failed-job diagnostics.

This database target is tracked as the implementation direction for [issue #434](https://github.com/yoophi-a/specrail/issues/434). The existing filesystem queues remain supported for deployments with appropriate shared storage.

## Credential prerequisites

Terminal outcome comments require a GitHub issue-comment client. Configure one of the supported token paths:

- `GITHUB_TOKEN`
- `GITHUB_INSTALLATION_TOKEN`
- GitHub App flow with `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY`

If no GitHub comment credentials are configured, the webhook can still start SpecRail runs, but durable terminal relay polling will not process comment jobs.

## Queue backend contract

Every production relay queue backend must preserve these semantics:

- `enqueue` durably records the repository, issue number, run id, report URL, operator URL, attempt count, timestamps, and next retry time before the webhook returns success.
- `claimNext` returns at most one due pending job per worker call and must prevent concurrent workers from claiming the same job.
- `complete` marks a successfully relayed job as completed for auditability.
- `fail` records a sanitized error, increments attempts, and returns the job to pending with exponential backoff until the third failed attempt, after which it is marked failed.
- `list` is an operational/audit surface; it must not mutate jobs.

The shared adapter contract tests in `apps/github/src/__tests__/github-app.test.ts` cover these expectations for durable queue implementations. Add new production backends to that contract suite before relying on them operationally.

The directory queue satisfies this contract for one host or a shared filesystem with atomic rename semantics. For horizontally scaled deployments across independent hosts, prefer the PostgreSQL implementation or another external queue implementation that exposes the same `GitHubRelayJobQueue` interface from `apps/github/src/index.ts`.

## Restart behavior

On restart, the app reloads the durable relay queue from `GITHUB_RELAY_QUEUE_DIR`, `GITHUB_RELAY_QUEUE_POSTGRES_URL`/`DATABASE_URL`, or `GITHUB_RELAY_QUEUE_PATH`. Jobs that are still queued or retryable remain eligible for processing. Failed attempts retain `lastError`, attempt count, and retry timing in the queue backend.

Operational checks after a restart:

1. Confirm the app is listening on `GITHUB_APP_PORT` and `GITHUB_WEBHOOK_PATH`.
2. Confirm the process user can read/write `GITHUB_RELAY_QUEUE_DIR` or `GITHUB_RELAY_QUEUE_PATH`.
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
