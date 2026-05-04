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

## Open implementation follow-ups

1. Add `github` to channel binding source types and persistence/API validation.
2. Add an `apps/github` thin frontend with webhook signature validation and issue-comment command parsing.
3. Add GitHub comment posting and terminal run outcome relay with report links.
4. Add integration-style tests for binding reuse, new-track creation, unauthorized commands, and terminal outcome comments.
