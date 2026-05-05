# GitHub Entrypoint Architecture Slice

This note defines the smallest GitHub-facing SpecRail slice worth implementing first. GitHub should behave like Telegram, terminal, ACP, and the hosted operator UI: a thin frontend over the existing HTTP/SSE contracts, not a new source of truth.

## Goals

- Let an operator start or continue SpecRail work from GitHub without opening the operator UI.
- Bind GitHub issues/PRs/comments to SpecRail tracks and planning sessions deterministically.
- Reuse existing project, track, planning, approval, run, event, and report APIs.
- Post concise terminal run outcomes back to GitHub with links to the derived Markdown run report.

## Non-goals

- Do not store canonical run history in GitHub comments.
- Do not copy completed-run reports into `spec.md`, `plan.md`, `tasks.md`, or GitHub issue bodies.
- Do not introduce a parallel GitHub-specific artifact lifecycle.
- Do not implement broad GitHub project-management automation in the first slice.

## Initial trigger

The first implementation should support an authenticated GitHub webhook for issue comments. A narrow command keeps scope reviewable:

```text
/specrail run [optional prompt]
```

Supported event shape:

- `issue_comment.created`
- comment body starts with `/specrail run`
- issue or pull request belongs to a configured repository/project mapping
- sender is allowed by config or GitHub installation permissions

PR comments can reuse the same issue-comment event because GitHub PRs are issues with pull-request metadata.

## Binding strategy

GitHub identities should map into the existing channel-binding shape or a follow-up generalized external binding model.

Recommended first mapping:

- `channelType`: introduce `github` when implementation starts.
- `externalChatId`: repository full name, for example `yoophi-a/specrail`.
- `externalThreadId`: GitHub issue/PR number as a string.
- `externalUserId`: GitHub sender login or numeric id.
- `trackId`: existing or newly created SpecRail track.
- `planningSessionId`: optional planning session associated with the thread.

Idempotency rule:

1. Look up a binding by repository + issue/PR number.
2. If found, reuse the bound track.
3. If missing, create a track titled from the GitHub issue/PR title and bind it.
4. Start a new run for each accepted `/specrail run` command unless the command explicitly targets planning-only behavior in a future slice.

## API flow

A GitHub frontend app can use the same flow as other thin clients:

1. Validate webhook signature and command authorization.
2. Resolve repository/project mapping.
3. `GET /channel-bindings?...` for the GitHub thread binding.
4. If absent, `POST /tracks` and `POST /channel-bindings`.
5. Optionally `POST /planning-sessions/:id/messages` or equivalent planning message append when the command includes extra instructions.
6. `POST /runs` with the bound `trackId`, optional `planningSessionId`, and prompt derived from the comment.
7. Follow `GET /runs/:runId/events/stream` for run updates.
8. Post one start acknowledgement and one terminal outcome comment to GitHub.

## GitHub comments

Keep comments short and durable.

Start acknowledgement:

```text
SpecRail run <runId> started for track <trackId>.
```

Terminal outcome:

```text
SpecRail run <runId> completed.
Report: <apiBaseUrl>/runs/<runId>/report.md
```

Failures and cancellations use the same format with `failed` or `cancelled`. Non-terminal progress events should not create GitHub comments in the first slice; they remain available through SSE/operator surfaces.

## Security and configuration

Required config for implementation:

- GitHub webhook secret validation.
- Installation token or app credentials for posting comments.
- Repository allowlist mapped to SpecRail `projectId`.
- Optional allowed actor/team list for `/specrail` commands.
- Public or operator-accessible API base URL for report links.

Rejected requests should be observable in logs/events, but should not leak secrets or internal paths into GitHub comments.

## Current implementation status

Implemented slices now cover:

1. `github` channel binding source types and persistence/API validation.
2. `apps/github` webhook signature validation and issue-comment command parsing.
3. GitHub `/specrail run` orchestration through existing SpecRail bindings, tracks, and runs.
4. Terminal outcome comment formatting/posting boundary with report links and optional hosted operator run links.
5. Webhook HTTP server wiring and runnable SpecRail HTTP client startup.
6. GitHub REST issue-comment posting with static-token and GitHub App installation-token providers.
7. Repository-to-project allowlists plus sender-login, organization, and team-based authorization for `/specrail` commands.
8. SpecRail SSE terminal-outcome relay with either in-process scheduling or a JSON-file durable relay queue.
9. Safe diagnostics and coarse command outcome metrics for ignored, unauthorized, unsupported, failed, and accepted commands.
10. Tests for unauthorized commands, repository mapping, actor/team authorization, terminal relay scheduling/enqueue failures, durable relay queue behavior, and live comment delivery boundaries.

See [GitHub App setup](../github-app-setup.md), [GitHub webhook production operations](../github-production-ops.md), and [GitHub command troubleshooting](../github-command-troubleshooting.md) for operator-facing configuration, operations, diagnostics, and current limitations.

## Open implementation follow-ups

1. Consider replacing the JSON-file relay queue with a database-backed queue if multi-process GitHub app deployments become necessary.
2. Add deployment-specific manifests for Kubernetes or other production orchestration targets when a target environment is selected.
3. Extend the command grammar beyond `/specrail run` only after a concrete operator workflow needs planning-only, approval, or artifact-proposal commands.
4. Keep GitHub as a thin frontend: future additions should continue linking back to SpecRail reports/operator surfaces rather than copying canonical run or artifact history into GitHub.
