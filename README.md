# SpecRail

SpecRail is a spec-driven orchestration service for coding-agent work.

The current MVP is already executable. It can:
- create track records and materialize `spec.md`, `plan.md`, and `tasks.md`
- persist project, track, run, and event state on local files
- start a Codex-backed run with durable session metadata
- resume and cancel a run
- expose run events through JSON and SSE APIs

## Current MVP status

### Implemented now
- artifact-first control plane with file-backed state
- default project bootstrap on first track creation
- track creation and track state updates
- generated per-track artifacts
- run start, resume, cancel lifecycle
- JSONL-backed run event persistence
- SSE event streaming for run events
- request validation and structured API errors
- automated API/config/adapter tests

### Not implemented yet
- authentication and multi-user access control
- database-backed persistence
- real approval broker or approval event workflow
- worktree or branch orchestration beyond metadata/workspace path allocation
- non-Codex executor adapters
- web UI, GitHub app/webhooks, or chat integrations
- artifact editing endpoints
- automatic track reconciliation from terminal run outcomes beyond the current first-pass policy

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
- `PATCH /tracks/:trackId`
  - update workflow state
  - body: any of `{ status, specStatus, planStatus }`

### Runs
- `POST /runs`
  - start a run for a track
  - body: `{ trackId, prompt, profile? }`
- `GET /runs`
  - list runs with pagination and explicit sorting
  - default sort: `sortBy=createdAt&sortOrder=desc`
  - query: `trackId?`, `status?`, `page?=1`, `pageSize?=20`, `sortBy?=createdAt|startedAt|finishedAt|status`, `sortOrder?=asc|desc`
  - response includes `meta: { page, pageSize, sortBy, sortOrder, total, totalPages, hasNextPage, hasPrevPage }`
- `GET /runs/:runId`
  - return persisted run metadata
- `POST /runs/:runId/resume`
  - resume an existing run
  - body: `{ prompt }`
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
- run metadata stores backend, profile, workspace path, branch name, session ref, command metadata, and event summary

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

## Repository layout

```text
specrail/
  apps/
    api/                  # Node HTTP API with JSON + SSE routes
  packages/
    core/                 # Domain types, file repositories, service orchestration
    adapters/             # Executor contracts and Codex MVP adapter
    config/               # Path helpers, config loading, artifact materialization
  docs/
    architecture/         # MVP architecture, roadmap, structure notes
  .specrail-template/     # Seed markdown templates for artifact materialization
```

## Getting started

```bash
pnpm install
pnpm test
pnpm dev:api
```

Then call the API locally, for example:

```bash
curl -X POST http://127.0.0.1:3000/tracks \
  -H 'content-type: application/json' \
  -d '{"title":"Executor MVP","description":"Persist command metadata and launch runs.","priority":"high"}'
```

## Verification source of truth

The docs above are aligned to the current MVP implementation and tests in:
- `apps/api/src/index.ts`
- `apps/api/src/__tests__/api.test.ts`
- `packages/core/src/services/specrail-service.ts`
- `packages/config/src/artifacts.ts`
- `packages/adapters/src/providers/codex-adapter.stub.ts`

## Related research

The original research and planning docs live under:
- `../research/agent-orchestrator-docs`
