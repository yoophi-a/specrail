# GitHub App Setup

`apps/github` is a thin webhook frontend over the SpecRail HTTP API. It does not store canonical run state in GitHub. GitHub issues and PRs only provide an entrypoint for starting work and, in a later live-comment slice, receiving concise terminal outcomes that link back to SpecRail reports.

## Current behavior

The app accepts `issue_comment.created` webhook events whose comment body starts with:

```text
/specrail run [optional prompt]
```

When accepted, the app:

1. Validates `X-Hub-Signature-256` against the raw request body.
2. Parses the GitHub issue/PR command context.
3. Looks up an existing SpecRail channel binding.
4. Creates a track and GitHub channel binding when no binding exists.
5. Starts a SpecRail run with either the opaque optional prompt or a default prompt derived from the issue/PR.
6. Returns structured JSON containing the run outcome data, including the derived report URL when configured.
7. When `GITHUB_FOLLOW_TERMINAL_EVENTS=true` and a GitHub token is configured, schedules a background terminal-outcome relay that posts one completed/failed/cancelled comment.

## Binding semantics

GitHub binding values intentionally reuse the generic SpecRail channel binding model:

- `channelType`: `github`
- `externalChatId`: repository `full_name`, for example `yoophi-a/specrail`
- `externalThreadId`: issue or PR number as a string
- `externalUserId`: GitHub sender login when available, otherwise sender id as a string

This keeps GitHub aligned with Telegram and other thin clients: SpecRail remains the source of truth for tracks, runs, events, artifacts, and reports.

## Configuration

The runnable app entrypoint reads these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `SPECRAIL_API_BASE_URL` | `http://127.0.0.1:4000` | Base URL for the SpecRail API. Also used to derive `/runs/:runId/report.md` links. |
| `SPECRAIL_GITHUB_PROJECT_ID` | `SPECRAIL_PROJECT_ID` or `project-default` | Default project id used when creating tracks from GitHub issues/PRs. |
| `SPECRAIL_PROJECT_ID` | `project-default` | Fallback project id when `SPECRAIL_GITHUB_PROJECT_ID` is not set. |
| `SPECRAIL_GITHUB_REPOSITORY_PROJECTS` | unset | Optional comma-separated repository allowlist and project map, for example `yoophi-a/specrail=project-specrail,other/repo=project-other`. When set, unmapped repositories are ignored. |
| `GITHUB_ALLOWED_ACTORS` | unset | Optional comma-separated sender login allowlist, for example `octocat,@hubot`. When set, other senders are ignored. |
| `GITHUB_WEBHOOK_SECRET` | empty string | Secret used to validate `X-Hub-Signature-256`. Set this in real deployments. |
| `GITHUB_APP_PORT` | `4200` | HTTP port for the GitHub webhook server. |
| `GITHUB_WEBHOOK_PATH` | `/github/webhook` | HTTP path that receives GitHub webhooks. |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub REST API base URL for issue-comment posting. |
| `GITHUB_TOKEN` | unset | Static token used by the REST issue-comment client. |
| `GITHUB_INSTALLATION_TOKEN` | unset | Static fallback token when `GITHUB_TOKEN` is not set. |
| `GITHUB_APP_ID` | unset | GitHub App id used to mint installation tokens. Requires `GITHUB_INSTALLATION_ID` and `GITHUB_PRIVATE_KEY`. Takes precedence over static tokens when all three are set. |
| `GITHUB_INSTALLATION_ID` | unset | GitHub App installation id used for installation-token exchange. |
| `GITHUB_PRIVATE_KEY` | unset | GitHub App private key PEM. Escaped newlines (`\\n`) are normalized at startup. |
| `GITHUB_FOLLOW_TERMINAL_EVENTS` | `false` | When `true` and a GitHub comment client is supplied, schedule background following of the created run event stream and post one terminal outcome comment. |
| `GITHUB_RELAY_QUEUE_PATH` | unset | Optional JSON-file durable queue path for terminal outcome relay jobs. When unset, the app uses the in-process scheduler fallback. |

## Running locally

Start the SpecRail API first, then run:

```sh
GITHUB_WEBHOOK_SECRET=dev-secret \
SPECRAIL_API_BASE_URL=http://127.0.0.1:4000 \
SPECRAIL_GITHUB_PROJECT_ID=project-default \
pnpm --filter @specrail/github dev
```

Configure a GitHub webhook to send `issue_comment` events to:

```text
http(s)://<host>/github/webhook
```

For local development, expose the app through a tunnel and use the same `GITHUB_WEBHOOK_SECRET` value in GitHub and the app environment.

## HTTP responses

The webhook endpoint returns JSON responses:

- `202 { accepted: true, outcome }` when a `/specrail run` command starts orchestration.
- `202 { accepted: true, outcome, relay: { scheduled: true } }` when terminal outcome relay is enabled and successfully scheduled.
- `202 { accepted: false, reason }` for ignored events, unsupported actions, unsupported commands, missing context, unsupported repositories, or unauthorized actors.
- `401 { accepted: false, reason: "invalid_signature" }` for signature failures.
- `400 { error: "invalid_json" }` for malformed JSON payloads.
- `502 { error: "specrail_request_failed", message }` when the SpecRail API call fails.
- `502 { error: "github_relay_enqueue_failed", message, outcome }` when run creation succeeds but the terminal relay scheduler rejects the background task.

## Current limitations

- REST issue-comment posting supports static tokens and GitHub App installation-token refresh. Private keys must be supplied securely by deployment secret management.
- Durable terminal relay is JSON-file based when `GITHUB_RELAY_QUEUE_PATH` is set. Failed relay attempts are retained with `lastError`, attempt count, and retry timing; deployments should place this path on persistent storage.
- Terminal outcome comment relay is available when `GITHUB_FOLLOW_TERMINAL_EVENTS=true`; the webhook response only waits for scheduling/enqueue, not for the run to reach a terminal state.
- Repository/project allowlists and sender-login actor authorization are supported; team-based authorization is not implemented yet.
- Non-terminal progress is intentionally not posted to GitHub; use the operator UI, terminal, Telegram, or SSE surfaces for detailed progress.
- GitHub is not a canonical artifact or run-history store. Completed-run reports remain derived read-only exports at `GET /runs/:runId/report.md`.

## Recommended follow-ups

1. Add GitHub team/org-based authorization for `/specrail` commands.
2. Add richer terminal outcome links once hosted operator run URLs are finalized.
3. Consider replacing the JSON-file relay queue with a database-backed queue if multi-process GitHub app deployments become necessary.
