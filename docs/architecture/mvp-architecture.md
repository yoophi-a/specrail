# SpecRail MVP Architecture

## Goal

Build a practical v1 service that combines:
- durable planning artifacts
- file-backed project, track, planning, run, channel, and attachment state
- local executor paths for Codex and Claude Code
- machine-readable interfaces for HTTP/SSE, ACP, terminal, and thin chat clients

The current MVP supports these caller flows:
1. create a track and materialize `spec.md`, `plan.md`, and `tasks.md`
2. inspect, list, sort, and update track workflow state
3. create planning sessions, append planning messages, propose artifact revisions, and approve/reject revisions
4. start Codex-backed or Claude Code-backed runs in isolated workspace directories
5. persist normalized execution events, summaries, provider metadata, and linked planning context
6. resume or cancel existing runs
7. read run events through JSON history or SSE streams
8. bind external channels, register attachment references, and project runs through terminal, Telegram, and ACP edge adapters

## Current system slices

### 1. Control plane

Owns product, planning, workflow, and artifact state.

Currently implemented:
- default project bootstrap
- track creation, inspection, listing, sorting, and workflow/approval status updates
- generated per-track `spec.md`, `plan.md`, `tasks.md`, and artifact-local `events.jsonl`
- planning sessions and planning messages
- artifact revision proposal and approval request workflows
- approved artifact materialization back into the artifact tree
- file-backed repositories for projects, tracks, planning sessions, artifact revisions, approval requests, channel bindings, attachment references, and executions
- JSONL-backed execution and planning-message stores

Primary artifacts:
- Markdown: `spec.md`, `plan.md`, `tasks.md`, index/workflow/track summaries
- JSON: project, track, planning, approval, channel, attachment, and execution metadata
- JSONL: run events, planning messages, and session-local adapter events

### 2. Execution plane

Owns runtime orchestration.

Currently implemented:
- workspace directory allocation per run
- backend selection between `codex` and `claude_code`
- persisted execution backend/profile normalization
- local Codex spawn/resume/cancel lifecycle
- local Claude Code process-backed execution with stream-event promotion
- persisted session metadata, provider metadata, and last-message files
- normalized lifecycle, stream, approval, message, tool, result, and summary events where supported by the backend
- run summary derivation from persisted events
- terminal-state reconciliation back into track status (`completed -> review`, `failed -> failed`, `cancelled -> blocked`)
- planning-context capture for runs, including stale-context rejection when newer planning revisions are pending approval

Currently not implemented:
- worktree/git orchestration beyond metadata/workspace path allocation
- backend-native approval broker callbacks independent of adapters
- scheduler/queue management

### 3. Interface plane

Owns how external callers interact with the service.

Currently implemented:
- Node HTTP API
- JSON responses
- SSE event stream
- request validation and structured API errors
- terminal client surfaces for track/run inspection, planning, execution controls, backend/profile selection, run filters, and live event following
- ACP stdio edge adapter that maps ACP sessions onto SpecRail runs while keeping HTTP/SSE as the system of record
- thin Telegram adapter that binds chats to tracks, registers attachment references, and relays run events
- GitHub/OpenSpec integration surfaces for import/export and run-summary publication

Deferred:
- web UI
- production auth/authz and multi-user access control
- GitHub app/webhook automation
- database-backed persistence

## Concrete module ownership

### `packages/core`

Owns:
- domain types and enums
- artifact document rendering
- file-backed repositories
- event store and planning-message store contracts plus JSONL implementations
- `SpecRailService` orchestration logic for tracks, planning, approvals, runs, channel bindings, and attachment references

### `packages/adapters`

Owns:
- executor adapter contracts
- Codex adapter
- Claude Code adapter
- provider command/session metadata persistence shapes
- provider stream normalization into the shared execution event schema
- OpenSpec and GitHub integration provider boundaries

### `packages/config`

Owns:
- config loading
- path conventions for artifacts/state/workspaces
- track artifact materialization helpers
- terminal client config loading

### `apps/api`

Owns:
- HTTP routing
- request validation
- JSON and SSE response handling
- service composition with file-backed dependencies and configured executors
- CLI/admin wrappers around HTTP, OpenSpec, and GitHub-oriented workflows

### `apps/acp-server`

Owns:
- ACP JSON-RPC stdio edge adapter
- ACP session state under `state/acp-sessions/`
- mapping ACP `session/new`, `session/prompt`, `session/cancel`, `session/load`, and `session/list` onto SpecRail service calls
- ACP-facing projections for execution events and permission requests

### `apps/terminal`

Owns:
- terminal client state and rendering
- track/run list and detail views
- planning and approval workspace views
- execution start/resume/cancel controls
- live SSE follow mode and event filters

### `apps/telegram`

Owns:
- Telegram webhook handling
- thin-channel binding to SpecRail tracks/planning sessions
- attachment reference registration
- run event relay back to Telegram chats

## API coverage in the MVP

Implemented routes:

### Tracks and planning
- `POST /tracks`
- `GET /tracks`
- `GET /tracks/:trackId`
- `PATCH /tracks/:trackId`
- `POST /tracks/:trackId/artifacts/:artifact`
- `GET /tracks/:trackId/artifacts/:artifact`
- `POST /tracks/:trackId/planning-sessions`
- `GET /tracks/:trackId/planning-sessions`
- `GET /planning-sessions/:planningSessionId`
- `POST /planning-sessions/:planningSessionId/messages`
- `GET /planning-sessions/:planningSessionId/messages`
- `POST /approval-requests/:approvalRequestId/approve`
- `POST /approval-requests/:approvalRequestId/reject`

### Runs and events
- `POST /runs`
- `GET /runs`
- `GET /runs/:runId`
- `POST /runs/:runId/resume`
- `POST /runs/:runId/cancel`
- `GET /runs/:runId/events`
- `GET /runs/:runId/events/stream`

### Channel and attachment references
- `POST /channel-bindings`
- `GET /channel-bindings`
- `POST /attachments`
- `GET /attachments`

Not implemented yet:
- project CRUD endpoints beyond default project bootstrap
- direct artifact edit/update endpoints outside the proposal/approval flow
- backend-native approval action callbacks for executor-level permission brokers
- webhook callback endpoints for GitHub or other hosted integrations

## Data model snapshot

### Project
- `id`
- `name`
- `repoUrl`
- `localRepoPath`
- `defaultWorkflowPolicy`
- `defaultPlanningSystem`
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
- `planningSystem`
- `createdAt`
- `updatedAt`

### PlanningSession
- `id`
- `trackId`
- `status`
- `latestRevisionId`
- `createdAt`
- `updatedAt`

### ArtifactRevision
- `id`
- `trackId`
- `artifact`
- `version`
- `content`
- `summary`
- `createdBy`
- `approvalRequestId`
- `approvedAt`
- `createdAt`

### ApprovalRequest
- `id`
- `trackId`
- `artifact`
- `revisionId`
- `status`
- `requestedBy`
- `requestedAt`
- `decidedAt`
- `decidedBy`
- `decisionComment`

### ChannelBinding
- `id`
- `projectId`
- `channelType`
- `externalChatId`
- `externalThreadId`
- `externalUserId`
- `trackId`
- `planningSessionId`
- `createdAt`
- `updatedAt`

### AttachmentReference
- `id`
- `sourceType`
- `externalFileId`
- `fileName`
- `mimeType`
- `localPath`
- `trackId`
- `planningSessionId`
- `uploadedAt`

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
- `planningSessionId`
- approved planning revision ids (`specRevisionId`, `planRevisionId`, `tasksRevisionId`)
- planning context freshness metadata
- provider metadata fields surfaced through backend-specific event/session metadata
- `status`
- `createdAt`
- `startedAt`
- `finishedAt`

### Event
- `id`
- `executionId`
- `type`
- `subtype`
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
  planning-sessions/
    <planningSessionId>.json
  planning-messages/
    <planningSessionId>.jsonl
  artifact-revisions/
    <trackId>/
      <artifact>/
        <revisionId>.json
  approval-requests/
    <approvalRequestId>.json
  channel-bindings/
    <bindingId>.json
  attachments/
    <attachmentId>.json
  executions/
    <runId>.json
  events/
    <runId>.jsonl
  acp-sessions/
    <acpSessionId>.json
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
5. caller can fetch the track plus artifact contents and inferred planning context

### Update track workflow state
1. caller patches any of `status`, `specStatus`, `planStatus`
2. service validates enum values
3. track metadata is updated in file-backed state

### Propose and approve artifact revisions
1. caller posts artifact content for `spec`, `plan`, or `tasks`
2. service stores a versioned `ArtifactRevision` and creates an `ApprovalRequest`
3. approve/reject endpoints resolve the request
4. approved revisions are materialized into the track artifact files

### Start run
1. caller submits `trackId`, prompt, optional backend/profile, and optional planning session
2. service rejects stale planning context when newer revisions are pending approval
3. service allocates `workspaces/<runId>/`
4. selected executor builds and spawns the provider command
5. execution metadata, planning-context refs, provider/session metadata, and initial normalized events are persisted

### Resume run
1. caller submits a follow-up prompt
2. service loads execution + persisted session reference
3. optional backend must match the persisted run backend
4. adapter resumes the provider session
5. resumed events are appended and run summary/status are recomputed

### Cancel run
1. caller requests cancellation
2. adapter best-effort terminates the persisted process/session
3. cancellation event is persisted
4. execution status becomes `cancelled` and the linked track reconciles to `blocked`

### Stream run events
1. caller opens SSE stream for a run
2. API replays existing persisted events first
3. file watcher tails appended JSONL lines
4. keep-alive comments preserve long-lived connection health

### Bind channel and register attachments
1. channel frontend creates or refreshes a channel binding for a chat/thread/user context
2. channel frontend registers attachment references with external ids and optional local metadata
3. later calls resolve the external channel back to the linked track/planning context and list associated attachments

### ACP session prompt
1. ACP client creates a session with SpecRail metadata, including `trackId`
2. first prompt starts a SpecRail run and links it to the ACP session
3. later prompts resume the linked run
4. run events are projected into ACP session updates while retaining the original event payload in `_meta.specrail.executionEvent`

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

Current Codex coverage:
- spawn -> `shell_command`
- run started/resumed/cancelled/completed/failed -> `task_status_changed`
- stdout/stderr capture -> `message`

Current Claude Code coverage:
- initialization and result envelopes -> `summary` subtypes
- assistant text -> `message` subtypes
- tool use and tool result stream events -> `tool_call` / `tool_result`
- permission denials and approval-like runtime signals -> `approval_requested`
- provider metadata such as model, transcript/log path, and working directory is attached through shared metadata/payload shapes

Current ACP edge coverage:
- `task_status_changed` updates ACP session status metadata
- `approval_requested` can be projected as ACP `session/request_permission`
- client `_meta.specrail.permissionResolution` can synthesize an `approval_resolved` event and resume the run

Some provider-specific details are still carried in event `payload` / `_meta` rather than promoted into a larger native taxonomy. That keeps the core event contract stable while adapter fidelity improves incrementally.

## Out of scope for the current MVP

- database layer
- production auth system
- production deployment manifests
- backend-native approval broker callbacks
- rich artifact editing/versioning API outside the current proposal/approval flow
- multi-project tenant management beyond default project bootstrap
- hosted GitHub app/webhook automation
- web UI
