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
- start a Codex-backed run with durable session metadata
- resume and cancel a run
- expose run events through JSON and SSE APIs
- list tracks and runs with filtering, pagination, and sorting
- import/export track artifact bundles through a service-wired OpenSpec file adapter flow

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
- file-based OpenSpec bundle import/export scaffold in `@specrail/adapters`, wired into service and admin API flows

### Not implemented yet
- authentication and multi-user access control
- database-backed persistence
- real approval broker or approval event workflow
- worktree or branch orchestration beyond metadata/workspace path allocation
- non-Codex executor adapters
- web UI, GitHub app/webhooks, or chat integrations
- artifact editing endpoints
- automatic track reconciliation from terminal run outcomes beyond the current first-pass policy
- GitHub check-run publishing beyond the current linked issue/PR comment sync

## HTTP API

Current endpoints in `apps/api/src/index.ts`:

### Tracks
- `POST /tracks`
  - create a track
  - body: `{ title, description, priority?, githubIssue?, githubPullRequest? }`
- `GET /tracks`
  - list tracks with pagination and explicit sorting
  - default sort: `sortBy=updatedAt&sortOrder=desc`
  - query: `status?`, `priority?`, `page?=1`, `pageSize?=20`, `sortBy?=updatedAt|createdAt|title|priority|status`, `sortOrder?=asc|desc`
  - response includes `meta: { page, pageSize, sortBy, sortOrder, total, totalPages, hasNextPage, hasPrevPage }`
- `GET /tracks/:trackId`
  - return track metadata plus `spec`, `plan`, and `tasks` artifact contents
  - also returns `githubRunCommentSync`, when present, with persisted target comment ids, last sync status, last sync error, and last published run info
- `GET /tracks/:trackId/integrations`
  - lightweight integration inspection route for polling/debug tooling without artifact payloads
  - returns linked GitHub issue/PR references, raw `runCommentSync`, and summary fields like `linkedTargetCount`, `syncedTargetCount`, `lastPublishedAt`, `lastSyncStatus`, and `lastSyncError`
- `POST /tracks/:trackId/integrations/github/run-comment-sync/retry`
  - retries the latest failed GitHub run comment sync for the track by reusing the stored `lastRunId` and existing publish flow
  - returns `{ trackId, runId, results, integrations }`
  - `409 conflict` when the track has no failed GitHub run comment syncs to retry
- `PATCH /tracks/:trackId`
  - update workflow state
  - body: any of `{ status, specStatus, planStatus, githubIssue, githubPullRequest }`

### Admin OpenSpec
- `POST /admin/openspec/export`
  - export a track into an OpenSpec file bundle
  - body: `{ trackId, path, overwrite? }`
- `POST /admin/openspec/import`
  - preview or import an OpenSpec bundle and create/update the referenced track plus artifacts
  - body: `{ path, dryRun?, conflictPolicy?, resolutionPreset?, resolution? }`
  - `dryRun: true` previews the normalized track and collision status without writing files or track state
  - `conflictPolicy` supports `reject` (default, safe preview-first flow), `overwrite` (replace the whole imported payload), and `resolve` (apply a field/artifact-level `resolution` map where `existing` keeps the current value and `incoming` applies the bundle value)
  - `resolutionPreset` supports `policyDefaults`, `preferIncomingArtifacts`, `preserveWorkflowState`, and `preferIncomingAll`; explicit `resolution` entries override preset defaults field-by-field
  - source-of-truth defaults treat OpenSpec as authoritative for `title`, `description`, `spec`, `plan`, and `tasks`, while SpecRail remains authoritative for workflow state and local GitHub linkage (`status`, `specStatus`, `planStatus`, `priority`, `githubIssue`, `githubPullRequest`)
  - response now includes `provenance`, `importHistory`, `resolvedArtifacts`, `resolutionGuide`, `operatorGuide`, and `conflict.details[]` so callers can inspect source path, bundle metadata, available presets, operator-facing preset guidance, effective choices, policies, and which fields would be replaced
  - applied imports persist `track.openSpecImport` as the latest provenance plus `track.openSpecImportHistory[]` in state and artifact metadata (`track.json`) for auditability
- `GET /admin/openspec/import/help`
  - return operator-facing preset selection guidance without requiring a bundle path
  - query: `resolutionPreset?=policyDefaults|preferIncomingArtifacts|preserveWorkflowState|preferIncomingAll`
  - response includes `operatorGuide.recommendedFlow`, conflict-policy descriptions, example request payloads, and a human-friendly `selectedPreset`/`effectiveChoices` breakdown for the requested preset
- `GET /admin/openspec/imports`
  - list persisted OpenSpec import history across tracks with pagination metadata
  - query: `trackId?`, `page?=1`, `pageSize?=20`, `sourcePath?`, `conflictPolicy?=reject|overwrite|resolve`, `importedAfter?`, `importedBefore?`
  - response includes `meta: { page, pageSize, sortBy, sortOrder, total, totalPages, hasNextPage, hasPrevPage }`
- `GET /admin/openspec/exports`
  - list persisted OpenSpec export history across tracks with pagination metadata
  - query: `trackId?`, `page?=1`, `pageSize?=20`, `targetPath?`, `overwrite?=true|false`, `exportedAfter?`, `exportedBefore?`
  - response includes `meta: { page, pageSize, sortBy, sortOrder, total, totalPages, hasNextPage, hasPrevPage }`
- `GET /tracks/:trackId/openspec/imports`
  - return the latest OpenSpec import/export provenance plus paginated track-scoped audit history for a single track
  - query: `page?=1`, `pageSize?=20`, `importPage?`, `importPageSize?`, `exportPage?`, `exportPageSize?`
  - response includes `imports: { latest, items, meta }` and `exports: { latest, items, meta }`, mirroring the admin audit entry shape while keeping the newest summary easy to read
- `GET /tracks/:trackId` and `GET /tracks/:trackId/integrations`
  - now include the same paginated OpenSpec inspection data alongside track state and GitHub sync metadata
  - accept the same OpenSpec pagination query params when callers need to bound embedded track inspection payloads

### Terminal admin wrapper
A terminal wrapper now exposes the same guided OpenSpec admin flow without needing the HTTP admin routes first.

```bash
# export a track bundle from the terminal
pnpm --filter @specrail/api openspec:export -- --track-id track_123 --path ./bundle

# preview with operator guidance
pnpm --filter @specrail/api openspec:import -- --path ./bundle --preview

# apply with the recommended preset-driven resolve flow
pnpm --filter @specrail/api openspec:import -- --path ./bundle --apply --preset policyDefaults

# inspect preset guidance from the terminal
pnpm --filter @specrail/api openspec:import:help -- --preset policyDefaults

# inspect persisted import history
pnpm --filter @specrail/api openspec:imports -- --track-id track_123 --page-size 10 --filter-conflict-policy resolve

# inspect persisted export history
pnpm --filter @specrail/api openspec:exports -- --track-id track_123 --page-size 10 --overwrite-only

# inspect track-scoped OpenSpec history with shared pagination
pnpm --filter @specrail/api openspec:inspect -- --track-id track_123 --page-size 5

# inspect only track-scoped import history on a later page
pnpm --filter @specrail/api openspec:inspect:imports -- --track-id track_123 --page 2 --page-size 5

# inspect only track-scoped export history with separate paging
pnpm --filter @specrail/api openspec:inspect:exports -- --track-id track_123 --page-size 5 --page 3

# inspect the full persisted track payload
pnpm --filter @specrail/api track:inspect -- --track-id track_123

# list tracks in a shell-friendly view
pnpm --filter @specrail/api tracks:list -- --status ready --sort-by title --sort-order asc

# inspect track integrations plus embedded OpenSpec history
pnpm --filter @specrail/api track:inspect:integrations -- --track-id track_123 --page-size 5

# list runs for a track
pnpm --filter @specrail/api runs:list -- --track-id track_123 --status running --page-size 10

# inspect a persisted run payload
pnpm --filter @specrail/api run:inspect -- --run-id run_123
```

Notes:
- export requires `--track-id` and `--path`; pass `--overwrite` to reuse an existing bundle directory
- preview mode defaults to `dryRun=true` with `conflictPolicy=reject`
- apply mode auto-selects `conflictPolicy=resolve` when a preset or explicit keep/take overrides are supplied
- field overrides are available via `--existing track.status,artifacts.plan` and `--incoming track.title`
- import history supports `--page`/`--page-size` plus `--track-id`, `--source-path`, `--filter-conflict-policy`, `--after`, and `--before`
- export history supports `--page`/`--page-size` plus `--track-id`, `--target-path`, `--overwrite-only`/`--no-overwrite-only`, `--after`, and `--before`
- `tracks:list` mirrors `GET /tracks` with `--status`, `--priority`, `--page`, `--page-size`, `--sort-by`, `--sort-order`, and `--json`
- track inspection supports `--page`/`--page-size` for both import and export history together, plus `--import-page`, `--import-page-size`, `--export-page`, and `--export-page-size` when operators want to page each side independently
- `runs:list` mirrors `GET /runs` with `--track-id`, `--status`, `--page`, `--page-size`, `--sort-by`, `--sort-order`, and `--json`
- `track:inspect` mirrors `GET /tracks/:trackId`, `track:inspect:integrations` mirrors `GET /tracks/:trackId/integrations`, and `run:inspect` mirrors `GET /runs/:runId`
- JSON output is available with `--json` for scripting or operator tooling

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
  - also returns `githubRunCommentSync` for the parent track and `githubRunCommentSyncForRun` filtered to entries last published for that run
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
- `409` for retry/conflict cases such as retrying a track with no failed GitHub sync state
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
    github-run-comment-sync/
      <trackId>.json
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
- GitHub run summary sync metadata is persisted under `state/github-run-comment-sync/<trackId>.json`.
- session-level executor logs are also persisted separately under `sessions/`.

## Domain model snapshot

### Track
- lifecycle status: `new | planned | ready | in_progress | blocked | review | done | failed`
- approval status fields: `specStatus`, `planStatus`
- optional GitHub linkage fields: `githubIssue`, `githubPullRequest` with `{ number, url }`
- priority: `low | medium | high`

### Run
- status values include `created`, `queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`
- current API actively exercises `running`, `completed`, `failed`, and `cancelled`
- terminal run states reconcile back into track status with a first-pass policy: `completed -> review`, `failed -> failed`, `cancelled -> blocked`
- run metadata stores backend, profile, workspace path, branch name, session ref, command metadata, and event summary
- `@specrail/core` exposes `formatGitHubRunCommentSummary(...)` plus `SpecRailService.publishRunSummary(...)` for deterministic linked issue/PR comment sync
- published summary sync state stores last comment ids and sync outcomes so retries can reuse known GitHub comments before falling back to marker scans

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

# optional: publish linked run summaries back to GitHub via gh auth
SPECRAIL_GITHUB_PUBLISH=1 pnpm dev:api
```

Then call the API locally, for example:

```bash
curl -X POST http://127.0.0.1:3000/tracks \
  -H 'content-type: application/json' \
  -d '{"title":"Executor MVP","description":"Persist command metadata and launch runs.","priority":"high"}'
```

## OpenSpec adapter boundary

`@specrail/adapters` now exposes a transport-neutral `OpenSpecAdapter` contract plus a first `FileOpenSpecAdapter` implementation.

Current file bundle shape:

```text
<bundle-dir>/
  openspec.json
  spec.md
  plan.md
  tasks.md
```

Manifest example:

```json
{
  "metadata": {
    "version": 1,
    "format": "specrail.openspec.bundle",
    "exportedAt": "2026-04-10T01:02:03.000Z",
    "generatedBy": "specrail"
  },
  "track": {
    "id": "track-openspec-1"
  },
  "files": {
    "spec": "spec.md",
    "plan": "plan.md",
    "tasks": "tasks.md"
  }
}
```

Notes:
- the bundle stores full `Track` metadata in `openspec.json`
- markdown artifacts stay as separate files so they remain reviewable and diff-friendly
- the file adapter is now wired into `SpecRailService` and exposed through admin API import/export routes

## Verification source of truth

The docs above are aligned to the current MVP implementation and tests in:
- `apps/api/src/index.ts`
- `apps/api/src/__tests__/api.test.ts`
- `packages/core/src/services/specrail-service.ts`
- `packages/config/src/artifacts.ts`
- `packages/adapters/src/providers/codex-adapter.stub.ts`
- `packages/adapters/src/providers/file-openspec-adapter.ts`

## Related research

The original research and planning docs live under:
- `../research/agent-orchestrator-docs`
