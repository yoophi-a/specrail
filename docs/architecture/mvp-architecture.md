# SpecRail MVP Architecture

## Goal

Build a practical v1 service that combines:
- durable planning artifacts
- file-backed run state
- one working local executor path
- simple machine-readable interfaces for callers

The current MVP already supports one caller flow:
1. create a track
2. materialize `spec.md`, `plan.md`, and `tasks.md`
3. inspect and update track workflow state
4. start one Codex-backed run in an isolated workspace directory
5. persist normalized events
6. resume or cancel that run
7. read events via JSON or SSE

## Current system slices

### 1. Control plane
Owns product and workflow state.

Currently implemented:
- default project bootstrap
- track creation
- track workflow/approval status updates
- artifact materialization for each track
- file-backed repositories for projects, tracks, and executions
- JSONL-backed event store

Primary artifacts:
- Markdown: `spec.md`, `plan.md`, `tasks.md`
- JSON: project/track/execution metadata
- JSONL: run events and session-local adapter events

### 2. Execution plane
Owns runtime orchestration.

Currently implemented:
- workspace directory allocation per run
- local Codex adapter spawn/resume/cancel lifecycle
- persisted session metadata and last-message files
- normalized lifecycle and stream events
- run summary derivation from persisted events

Currently not implemented:
- worktree/git orchestration
- approval pause/resume broker
- multiple executor backends
- scheduler/queue management

### 3. Interface plane
Owns how external callers interact with the service.

Currently implemented:
- Node HTTP API
- JSON responses
- SSE event stream
- basic request validation and structured error responses

Deferred:
- web UI
- GitHub app/webhooks
- chat integrations
- auth/authz

## Concrete module ownership

### `packages/core`
Owns:
- domain types and enums
- artifact document rendering
- file-backed repositories
- event store contract and JSONL implementation
- `SpecRailService` orchestration logic

### `packages/adapters`
Owns:
- executor adapter contracts
- Codex MVP adapter
- command/session metadata persistence shape
- runtime event normalization from adapter lifecycle to core event schema

### `packages/config`
Owns:
- config loading
- path conventions for artifacts/state
- track artifact materialization helpers

### `apps/api`
Owns:
- HTTP routing
- request validation
- JSON and SSE response handling
- service composition with file-backed dependencies

## API coverage in the MVP

Implemented routes:
- `POST /tracks`
- `GET /tracks/:trackId`
- `PATCH /tracks/:trackId`
- `POST /runs`
- `GET /runs/:runId`
- `POST /runs/:runId/resume`
- `POST /runs/:runId/cancel`
- `GET /runs/:runId/events`
- `GET /runs/:runId/events/stream`

Not implemented yet:
- project CRUD endpoints
- artifact edit/update endpoints
- run listing/filtering endpoints
- approval action endpoints beyond track status mutation
- webhook or callback endpoints

## Data model snapshot

### Project
- `id`
- `name`
- `repoUrl`
- `localRepoPath`
- `defaultWorkflowPolicy`
- `createdAt`
- `updatedAt`

### Track
- `id`
- `projectId`
- `title`
- `description`
- `status`
- `specStatus`
- `planStatus`
- `priority`
- `createdAt`
- `updatedAt`

### Execution
- `id`
- `trackId`
- `backend`
- `profile`
- `workspacePath`
- `branchName`
- `sessionRef`
- `command`
- `summary`
- `status`
- `createdAt`
- `startedAt`
- `finishedAt`

### Event
- `id`
- `executionId`
- `type`
- `timestamp`
- `source`
- `summary`
- `payload`

## Persistence layout

The runtime uses file-backed persistence under the configured data directory.

### Artifact tree
```text
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
```

### State tree
```text
state/
  projects/
    <projectId>.json
  tracks/
    <trackId>.json
  executions/
    <runId>.json
  events/
    <runId>.jsonl
```

### Session tree
```text
sessions/
  <sessionRef>.json
  <sessionRef>.events.jsonl
  <sessionRef>.last-message.txt
```

### Workspace tree
```text
workspaces/
  <runId>/
```

## Request flow

### Create track
1. caller submits title/description/priority
2. service ensures a default project exists
3. service creates a track record
4. service writes `track.json`, `spec.md`, `plan.md`, `tasks.md`, and a placeholder artifact-local `events.jsonl`
5. caller can fetch the track plus artifact contents

### Update track workflow state
1. caller patches any of `status`, `specStatus`, `planStatus`
2. service validates enum values
3. track metadata is updated in file-backed state

### Start run
1. caller submits `trackId` and prompt
2. service allocates `workspaces/<runId>/`
3. Codex adapter builds and spawns the command
4. execution metadata is persisted
5. normalized initial events are appended to `state/events/<runId>.jsonl`

### Resume run
1. caller submits follow-up prompt
2. service loads execution + persisted session reference
3. adapter resumes the Codex session
4. resumed event is appended and run summary is recomputed

### Cancel run
1. caller requests cancellation
2. adapter best-effort terminates the persisted PID
3. cancellation event is persisted
4. execution status becomes `cancelled`

### Stream run events
1. caller opens SSE stream for a run
2. API replays existing persisted events first
3. file watcher tails appended JSONL lines
4. keep-alive comments preserve long-lived connection health

## Event normalization constraints

The shared event model stays intentionally small:
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

Current Codex MVP coverage:
- spawn -> `shell_command`
- run started/resumed/cancelled/completed/failed -> `task_status_changed`
- stdout/stderr capture -> `message`

Approval and tool/file/test-specific events are schema-defined but not yet emitted by the current adapter.

## Out of scope for the current MVP

- database layer
- production auth system
- production deployment manifests
- real approval workflows
- rich artifact editing/versioning API
- multi-project tenant management
- PR automation and GitHub sync
