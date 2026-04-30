# SpecRail

SpecRail is a spec-driven orchestration service for coding-agent work.

In one sentence: SpecRail is a tool that helps a team describe a coding task clearly, ask a coding agent to do the work, and keep the plan, execution history, and current status in one place.

## Who this is for

### For engineers
SpecRail is a file-backed control plane for coding-agent execution.
It manages tracks, generated artifacts (`spec.md`, `plan.md`, `tasks.md`), run lifecycle, event persistence, and Codex-backed execution through JSON and SSE APIs.
If you want "spec -> run -> inspect -> resume/cancel -> reconcile state" as an actual service boundary, that is what SpecRail is trying to provide.

### For product managers and planners
SpecRail is a system for turning "please build this" into a structured work item that an AI coding agent can actually follow.
Instead of giving the AI a vague request every time, you keep:
- what should be built
- the plan for how to build it
- the task breakdown
- the current progress and execution history
in one workflow.
That makes it easier to review, approve, retry, and understand what happened.

### For vibe-coding beginners
Think of SpecRail as a "project notebook + task runner" for AI developers.
You write down the job, the plan, and the checklist.
Then the AI tries the job.
SpecRail remembers what the AI did, whether it succeeded or failed, and lets you continue later instead of starting over from scratch.

## What the current MVP can already do
- create track records and materialize `spec.md`, `plan.md`, and `tasks.md`
- persist project, track, run, and event state on local files
- start a Codex-backed or Claude Code-backed run with durable session metadata
- resume and cancel a run
- expose run events through JSON and SSE APIs
- list tracks and runs with filtering, pagination, and sorting

## Current MVP status

### Implemented now
- artifact-first control plane with file-backed state
- ACP stdio edge adapter that maps ACP sessions onto SpecRail runs without replacing the HTTP API
- default project bootstrap on first track creation
- track creation and track state updates
- generated per-track artifacts
- run start, resume, cancel lifecycle
- JSONL-backed run event persistence
- SSE event streaming for run events
- request validation and structured API errors
- thin-channel foundations for external chat bindings and attachment references
- thin Telegram adapter app that binds chats to tracks and relays run events
- automated API/config/adapter/frontend tests

### Not implemented yet
- database-backed persistence
- real approval broker or approval event workflow
- worktree or branch orchestration beyond metadata/workspace path allocation
- authentication and multi-user access control
- web UI or GitHub app/webhooks
- artifact editing endpoints
- automatic track reconciliation from terminal run outcomes beyond the current first-pass policy

## ACP edge adapter status

`apps/acp-server` now projects SpecRail runs into richer ACP session updates:
- task status changes refresh ACP `session_info_update` metadata
- runtime `approval_requested` events emit ACP `session/request_permission`
- client permission decisions can round-trip back through `session/prompt` via `_meta.specrail.permissionResolution`
- full original execution events still ride along in `_meta.specrail.executionEvent`

Current limitation: runtime approval resolution is still adapter-mediated, not a backend-native approval broker.

## HTTP API

Current endpoints in `apps/api/src/index.ts`:

### Tracks
- `POST /tracks`
  - create a track
  - body: `{ title, description, priority? }`
- `GET /tracks`
  - list tracks with pagination and explicit sorting
  - default sort: `sortBy=updatedAt&sortOrder=desc`
  - query: `status?`, `priority?`, `page?=1`, `pageSize?=20`, `sortBy?=updatedAt|createdAt|title|priority|status`, `sortOrder?=asc|desc`
  - response includes `meta: { page, pageSize, sortBy, sortOrder, total, totalPages, hasNextPage, hasPrevPage }`
- `GET /tracks/:trackId`
  - return track metadata plus `spec`, `plan`, and `tasks` artifact contents
  - response also includes inferred `planningContext` with the latest approved revision references and pending-change flag
- `PATCH /tracks/:trackId`
  - update workflow state
  - body: any of `{ status, specStatus, planStatus }`

### Runs
- `POST /runs`
  - start a run for a track
  - body: `{ trackId, prompt, backend?, profile?, planningSessionId? }`
  - `backend` currently supports `codex` and `claude_code`
  - runs infer and persist the latest approved planning context, and reject starts while newer planning revisions are still pending approval
- `GET /runs`
  - list runs with pagination and explicit sorting
  - default sort: `sortBy=createdAt&sortOrder=desc`
  - query: `trackId?`, `status?`, `page?=1`, `pageSize?=20`, `sortBy?=createdAt|startedAt|finishedAt|status`, `sortOrder?=asc|desc`
  - response includes `meta: { page, pageSize, sortBy, sortOrder, total, totalPages, hasNextPage, hasPrevPage }`
- `GET /runs/:runId`
  - return persisted run metadata
- `POST /runs/:runId/resume`
  - resume an existing run
  - body: `{ prompt, backend?, profile? }`
  - `backend` is optional and must match the run's persisted backend when provided
- `POST /runs/:runId/cancel`
  - cancel a running run
- `GET /runs/:runId/events`
  - return persisted normalized events as JSON
- `GET /runs/:runId/events/stream`
  - stream normalized events over SSE

### Error contract
- `400` for malformed JSON
- `404` for missing tracks/runs
- `422` for validation failures
  - includes invalid pagination/sort params
- `500` for unexpected server errors

### Channel bindings and attachments
- `POST /channel-bindings`
  - create or refresh an external channel binding
  - body: `{ projectId, channelType, externalChatId, externalThreadId?, externalUserId?, trackId?, planningSessionId? }`
- `GET /channel-bindings?channelType=telegram&externalChatId=...&externalThreadId?...`
  - resolve a thin-channel conversation back to its linked SpecRail context
- `POST /attachments`
  - register an attachment reference received by a channel frontend
  - body: `{ sourceType, externalFileId, fileName?, mimeType?, localPath?, trackId?, planningSessionId? }`
- `GET /attachments?trackId=...` or `GET /attachments?planningSessionId=...`
  - list attachment references associated with a track or planning session

## Artifact and state layout

At runtime the API writes under `SPECRAIL_DATA_DIR` (default from config), with these main areas:

```text
.specrail-data/
  artifacts/
    index.md
    workflow.md
    tracks.md
    tracks/
      <trackId>/
        track.json
        spec.md
        plan.md
        tasks.md
        events.jsonl
  state/
    projects/
      <projectId>.json
    tracks/
      <trackId>.json
    channel-bindings/
      <bindingId>.json
    attachments/
      <attachmentId>.json
    executions/
      <runId>.json
    events/
      <runId>.jsonl
  sessions/
    <sessionRef>.json
    <sessionRef>.events.jsonl
    <sessionRef>.last-message.txt
  workspaces/
    <runId>/
```

Notes:
- `artifacts/tracks/<trackId>/events.jsonl` is materialized as part of the artifact contract.
- the current API reads run events from `state/events/<runId>.jsonl`.
- session-level executor logs are also persisted separately under `sessions/`.

## Domain model snapshot

### Track
- lifecycle status: `new | planned | ready | in_progress | blocked | review | done | failed`
- approval status fields: `specStatus`, `planStatus`
- priority: `low | medium | high`

### Run
- status values include `created`, `queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`
- current API actively exercises `running`, `completed`, `failed`, and `cancelled`
- terminal run states reconcile back into track status with a first-pass policy: `completed -> review`, `failed -> failed`, `cancelled -> blocked`
- run metadata stores backend, profile, workspace path, branch name, session ref, command metadata, normalized provider session metadata (`providerSessionId`, `providerInvocationId`, `resumeSessionRef`, `parentSessionRef`, `providerMetadata`), event summary, and linked planning-context references (`planningSessionId`, approved revision ids, stale flag)
- Claude Code runs additionally surface provider metadata such as resolved model, transcript/log path, and working directory through the shared `providerMetadata` shape

### Event types
Normalized event types currently defined in core:
- `message`
- `tool_call`
- `tool_result`
- `file_change`
- `shell_command`
- `approval_requested`
- `approval_resolved`
- `task_status_changed`
- `test_result`
- `summary`

The Codex MVP currently emits lifecycle-oriented events such as:
- `task_status_changed` for run started/resumed/cancelled/completed/failed
- `shell_command` for session spawn
- `message` for stdout/stderr capture

Claude Code now additionally promotes important `stream-json` provider events into richer shared event subtypes, for example:
- `summary` / `claude_init` for session initialization metadata
- `message` / `claude_assistant_text` for assistant text turns
- `tool_call` / `claude_tool_call` and `tool_result` / `claude_tool_result`
- `approval_requested` / `claude_permission_denial` when Claude reports blocked tool execution
- `summary` / `claude_result_*` for result envelopes

## Repository layout

```text
specrail/
  apps/
    api/                  # Node HTTP API with JSON + SSE routes
    acp-server/           # ACP stdio edge adapter over SpecRail runs
    terminal/             # Operator-facing terminal shell over the SpecRail API
    telegram/             # Thin Telegram webhook frontend over the SpecRail API
  packages/
    core/                 # Domain types, file repositories, service orchestration
    adapters/             # Executor contracts and Codex MVP adapter
    config/               # Path helpers, config loading, artifact materialization
  docs/
    architecture/         # MVP architecture, roadmap, structure notes
  .specrail-template/     # Seed markdown templates for artifact materialization
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow, validation commands, PR/issue template expectations, and contract-impact guidance.

## Getting started

```bash
pnpm install
pnpm test
pnpm dev:api
pnpm dev:acp
pnpm dev:terminal
pnpm dev:telegram
```

## Terminal client skeleton

SpecRail now includes a runnable terminal client skeleton in `apps/terminal`.

Operator environment:
- `SPECRAIL_API_BASE_URL` default `http://127.0.0.1:4000`
- `SPECRAIL_TERMINAL_REFRESH_MS` default `5000`
- `SPECRAIL_TERMINAL_INITIAL_SCREEN` one of `home`, `tracks`, `runs`, `settings`

Run it locally:

```bash
pnpm dev:api
pnpm dev:terminal
```

Current shell behavior:
- loads recent tracks and runs from the API
- renders navigable track and run list views with selected detail panes
- filters runs between all, active, and terminal states
- auto-selects the current track/run and refreshes detail snapshots from the API
- tails live selected-run events over SSE with cached recent activity and reconnect attempts when the stream drops
- allows pausing and resuming the live tail without losing the selected run context
- shows richer run status context including event counts, last event, planning-context staleness, and failure focus where available
- supports `1-4` to switch screens, `j/k` or arrow keys to move selection, `f` to cycle run filters, `Space` to pause/resume the tail, `r` to refresh, `q` to quit
- supports `s` on tracks to compose a new run, `e` on runs to resume a completed/failed/cancelled run, and `c` on runs to cancel an active run
- exposes backend/profile choices in the terminal action composer, with validation feedback surfaced directly in the shell status and composer note
- surfaces loading, streaming, and refresh failures in the status line and detail panes

## Claude Code backend

SpecRail supports `claude_code` as a first-class execution backend.

Operator notes:
- SpecRail runs Claude Code in non-interactive `--print --output-format stream-json` mode.
- `profile` is passed through as `--model`.
- resume relies on persisted provider session metadata discovered from stdout.
- cancel is local best-effort process termination plus SpecRail state reconciliation.
- cancelled sessions now persist verification hints such as whether `SIGTERM` was delivered and why manual follow-up may still be required.
- adapter exports a lightweight `checkClaudeCodeReadiness()` helper so operators can validate `claude --version` before routing work to this backend.

Read `docs/claude-code-operations.md` for setup, limitations, recovery, and smoke-test steps.

For an opt-in real-CLI smoke run, set `SPECRAIL_RUN_CLAUDE_SMOKE=1` and run `pnpm test:claude-smoke`.
By default this smoke path stays out of `pnpm test` so local and CI runs do not become provider-dependent unless explicitly enabled.

For GitHub Actions, use the opt-in stub at `.github/workflows/claude-smoke.yml` together with `scripts/run-claude-smoke-ci.sh`.
That workflow is intentionally gated behind repository variable `SPECRAIL_ENABLE_CLAUDE_SMOKE=1` so the default CI path stays stable when Claude credentials are unavailable on runners.

For the Telegram frontend, set `SPECRAIL_API_BASE_URL`, `TELEGRAM_BOT_TOKEN`, and optionally `TELEGRAM_APP_PORT` / `TELEGRAM_WEBHOOK_PATH` before `pnpm dev:telegram`.

For the API server, you can set `SPECRAIL_EXECUTION_BACKEND` and `SPECRAIL_EXECUTION_PROFILE` to choose the default executor/backend and profile used when callers omit them.

Then call the API locally, for example:

```bash
curl -X POST http://127.0.0.1:3000/tracks \
  -H 'content-type: application/json' \
  -d '{"title":"Executor MVP","description":"Persist command metadata and launch runs.","priority":"high"}'
```

## Documentation

See [docs/README.md](./docs/README.md) for a categorized documentation index.

## Verification source of truth

The docs above are aligned to the current MVP implementation and tests in:
- `apps/api/src/index.ts`
- `apps/api/src/__tests__/api.test.ts`
- `packages/core/src/services/specrail-service.ts`
- `packages/config/src/artifacts.ts`
- `packages/adapters/src/providers/codex-adapter.stub.ts`
- `packages/adapters/src/__tests__/claude-code.smoke.test.ts`

## Related research

The original research and planning docs live under:
- `../research/agent-orchestrator-docs`
