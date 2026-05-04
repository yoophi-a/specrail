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
| `SPECRAIL_GITHUB_PROJECT_ID` | `SPECRAIL_PROJECT_ID` or `project-default` | Project id used when creating tracks from GitHub issues/PRs. |
| `SPECRAIL_PROJECT_ID` | `project-default` | Fallback project id when `SPECRAIL_GITHUB_PROJECT_ID` is not set. |
| `GITHUB_WEBHOOK_SECRET` | empty string | Secret used to validate `X-Hub-Signature-256`. Set this in real deployments. |
| `GITHUB_APP_PORT` | `4200` | HTTP port for the GitHub webhook server. |
| `GITHUB_WEBHOOK_PATH` | `/github/webhook` | HTTP path that receives GitHub webhooks. |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub REST API base URL for issue-comment posting. |
| `GITHUB_TOKEN` | unset | Token used by the REST issue-comment client. |
| `GITHUB_INSTALLATION_TOKEN` | unset | Fallback token when `GITHUB_TOKEN` is not set. |

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
- `202 { accepted: false, reason }` for ignored events, unsupported actions, unsupported commands, or missing context.
- `401 { accepted: false, reason: "invalid_signature" }` for signature failures.
- `400 { error: "invalid_json" }` for malformed JSON payloads.
- `502 { error: "specrail_request_failed", message }` when the SpecRail API call fails.

## Current limitations

- A REST issue-comment client exists for token-backed comment creation, but production GitHub App installation-token refresh is not implemented yet.
- The terminal outcome comment formatter/port exists, but SSE-driven live terminal outcome delivery remains a follow-up.
- Repository/project allowlists and actor/team authorization are not implemented yet.
- Non-terminal progress is intentionally not posted to GitHub; use the operator UI, terminal, Telegram, or SSE surfaces for detailed progress.
- GitHub is not a canonical artifact or run-history store. Completed-run reports remain derived read-only exports at `GET /runs/:runId/report.md`.

## Recommended follow-ups

1. Add GitHub App private-key authentication and installation-token refresh.
2. Wire terminal run events from SpecRail SSE to the GitHub terminal outcome comment relay.
3. Add repository-to-project allowlist and actor authorization for `/specrail` commands.
