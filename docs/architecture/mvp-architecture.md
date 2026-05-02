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
- generated per-track `spec.md`, `plan.md`, `tasks.md`, and reserved runtime artifact `events.jsonl` placeholders
- planning sessions and planning messages
- artifact revision proposal and approval request workflows
- approved artifact materialization back into the artifact tree
- file-backed repositories for projects, tracks, planning sessions, artifact revisions, approval requests, channel bindings, attachment references, and executions
- JSONL-backed execution and planning-message stores

Primary artifacts:
- Markdown: `spec.md`, `plan.md`, `tasks.md`, index/workflow/track summaries
- JSON: project, track, planning, approval, channel, attachment, and execution metadata
- JSONL: authoritative run events, planning messages, and session-local adapter events

Event-history ownership:
- `state/events/<runId>.jsonl` is the canonical run-event log used by HTTP history, SSE replay, run summaries, and lifecycle reconciliation.
- `sessions/<sessionRef>.events.jsonl` is provider-adapter telemetry for debugging and replaying executor output; normalized domain events are copied into `state/events/<runId>.jsonl`.
- `artifacts/tracks/<trackId>/events.jsonl` is a reserved runtime artifact placeholder in the current MVP. It is not read by the API and must not be treated as the source of truth.
- the repo-visible artifact tree intentionally contains only `spec.md`, `plan.md`, `tasks.md`, and `sync.json` for each track; run history should be exposed through API/SSE until a future export contract is designed.

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
- executor callback delivery for runtime approval decisions through Codex and Claude Code resume/no-retry fallbacks

Currently not implemented:
- worktree/git orchestration beyond metadata/workspace path allocation
- provider-native permission continuation beyond normal resume fallback behavior
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
- `POST /runs/:runId/approval-requests/:requestId/approve`
- `POST /runs/:runId/approval-requests/:requestId/reject`
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

### Execution workspace and branch contract

The current MVP always allocates a per-run workspace path before starting an executor:

```text
workspacePath = workspaces/<runId>/
branchName = specrail/<runId>
```

The workspace path is persisted on the execution record and passed to the selected executor as its working directory. The branch name is currently metadata only; future git orchestration should make it real without changing the execution record shape.

Workspace modes:

- `directory`: create `workspaces/<runId>/` as an empty/plain directory. This is the current behavior and remains the safe fallback.
- `git_worktree`: create a git worktree rooted at `workspaces/<runId>/` with branch `specrail/<runId>` when the project has a local git repository and worktree creation is enabled.

Branch and worktree ownership rules:

- SpecRail owns branches matching `specrail/<runId>` that it creates.
- SpecRail must not delete or mutate unrelated branches/worktrees.
- If `specrail/<runId>` already exists, startup should fail with a validation error rather than silently reusing it.
- If worktree creation fails, the run should not start unless the caller/config explicitly allows falling back to `directory` mode.
- `workspacePath`, `branchName`, backend, profile, and session refs are the durable recovery handles.

Cleanup expectations:

- `completed`: keep the workspace by default until review/merge tooling decides what to do.
- `failed`: keep the workspace for debugging.
- `cancelled`: keep the workspace for inspection unless explicit cleanup is requested.
- interrupted process: recover from persisted execution metadata and event history; do not assume the worktree can be deleted automatically.

The first implementation slice provides a workspace manager abstraction with:

- `DirectoryExecutionWorkspaceManager` for the default plain directory behavior.
- `GitWorktreeExecutionWorkspaceManager` for explicit `git worktree add -b specrail/<runId> workspaces/<runId>` allocation when a local repository path is provided.
- `GitCommandRunner` injection so tests and future operators can validate command planning without invoking git directly.

Actual branch deletion/cleanup remains a separate explicit operation.

## Request flow

### Create track
1. caller submits title/description/priority
2. service ensures a default project exists
3. service creates a track record
4. service writes `track.json`, `spec.md`, `plan.md`, `tasks.md`, and a reserved runtime artifact `events.jsonl` placeholder
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
2. API replays existing persisted events from `state/events/<runId>.jsonl` first
3. file watcher plus polling fallback tails appended JSONL lines from the same canonical state log
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
- client `_meta.specrail.permissionResolution` is resolved through `SpecRailService.resolveRuntimeApprovalRequest(...)` and then resumes the run

### Runtime approval callback contract

Runtime approval resolution has two separate responsibilities:

1. persist the domain decision in SpecRail
2. deliver that decision to the active executor when the backend implements `resolveRuntimeApproval(...)`

The implemented domain decision path is canonical:

```text
POST /runs/:runId/approval-requests/:requestId/approve|reject
  -> SpecRailService.resolveRuntimeApprovalRequest(...)
  -> append approval_resolved to state/events/<runId>.jsonl
  -> reconcile the run snapshot from persisted execution events
```

Executors treat the persisted `approval_resolved` event as the durable source of truth. The optional executor callback receives the resolved event plus the current execution snapshot, not a provider-specific API shape. The stable fields are:

- `executionId`
- `payload.requestId`
- `payload.requestEventId`
- `payload.outcome` (`approved` or `rejected`)
- `payload.decidedBy` (`user`, `agent`, or `system`)
- `payload.comment`
- `payload.toolName`
- `payload.toolUseId`

Expected callback behavior:

- `approved`: continue the blocked operation when the provider exposes a permission-continuation primitive; otherwise resume the run with a clear event explaining the fallback path.
- `rejected`: do not retry the blocked operation; mark or keep the run cancelled unless a backend can represent a narrower blocked-step state.
- unsupported callbacks append a `summary` event so the gap is visible in run history and edge adapters can use their fallback resume path.
- handled callbacks let edge adapters skip duplicate resume/continuation behavior.
- callback failure after the domain event is recorded appends an additional `summary` event rather than mutating the approval decision.

Provider-specific metadata can remain under event `payload` / `_meta`, but the callback boundary should not require callers to know Codex, Claude Code, or ACP transport details. That keeps the core event contract stable while adapter fidelity improves incrementally.

## Out of scope for the current MVP

- database layer
- production auth system
- production deployment manifests
- provider-native permission continuation primitives beyond current resume fallback behavior
- rich artifact editing/versioning API outside the current proposal/approval flow
- multi-project tenant management beyond default project bootstrap
- hosted GitHub app/webhook automation
- web UI
