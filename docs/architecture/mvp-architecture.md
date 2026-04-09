# SpecRail MVP Architecture

## Goal

Build a practical v1 service that combines:
- Conductor-style durable planning artifacts
- Vibe-Kanban-style execution/session abstractions
- optional fallback adapters for weaker agent interfaces

The MVP should let one caller:
1. create a project context
2. create a track with spec + plan
3. approve the plan
4. start one execution in an isolated workspace
5. persist normalized events
6. resume with follow-up instructions
7. end with a structured summary

## System slices

### 1. Control plane
Owns product/process state.

Primary responsibilities:
- maintain project metadata
- create and update tracks
- store spec and plan artifacts
- track approval state
- expose machine-readable metadata for execution

Durable artifacts:
- Markdown: human-readable specs/plans
- JSON: metadata and workflow state
- JSONL: event logs and execution summaries

### 2. Execution plane
Owns runtime orchestration.

Primary responsibilities:
- allocate isolated workspace
- choose executor backend/profile
- materialize prompt from approved artifacts
- run initial or follow-up execution
- normalize backend-specific output into shared events
- persist session references

### 3. Interface plane
Owns how external callers interact with the service.

MVP interface:
- HTTP API
- SSE event stream

Deferred:
- web UI
- GitHub app/webhooks
- chat integrations

## Bounded modules

### `packages/core`
The most important package in the repo.

Owns:
- domain types
- status enums
- state transition rules
- service ports/interfaces
- event schema contracts

This package should stay free of vendor-specific executor logic.

### `packages/adapters`
Owns executor and infrastructure adapter boundaries.

Initial subareas:
- adapter interface definitions
- provider capability descriptors
- provider-specific event normalization

Longer term this may split into multiple packages if adapters become large.

### `packages/config`
Owns:
- env parsing
- path conventions
- workflow/config defaults
- reusable config schemas

### `apps/api`
Owns:
- HTTP routes
- request validation
- SSE streaming layer
- composition root that wires ports to concrete implementations

## Initial data model

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

## Persistence strategy for v1

MVP should be artifact-first.

Recommended starting mix:
- repo-local files for specs/plans/event logs
- optional lightweight DB integration added once API queries become awkward

Reasoning:
- artifact transparency is a core product feature
- early development benefits from easy inspection and git diffability
- the initial service can move faster if it does not require DB migrations on day 1

## Request flow

### Create track
1. caller submits title/description
2. control plane creates track id
3. service writes spec and plan placeholders
4. metadata is persisted
5. caller reviews and edits artifacts

### Approve plan
1. caller marks spec/plan approved
2. approval event is written
3. track becomes execution-ready

### Start execution
1. service allocates workspace
2. service selects adapter/profile
3. service materializes prompt bundle
4. adapter spawns session
5. normalized events are appended to JSONL
6. execution summary endpoint reflects live state

### Follow-up execution
1. caller submits follow-up instruction
2. execution plane loads session ref
3. adapter resumes or forks session
4. event stream continues under same execution lineage

## Event normalization constraints

The event model should be small and stable.

MVP event categories:
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

Anything adapter-specific should live inside `payload` rather than exploding the top-level schema.

## Directory rationale

### `.specrail-template/`
A starter template for the control-plane artifacts written into managed repos.

Reason to keep it here:
- version the default artifact contract with the service
- make template evolution explicit in git history

### `docs/architecture/`
Architecture decisions should live in repo docs rather than in issues only.

Reason to keep these separate from code:
- they explain why the module split exists
- they help future implementation avoid cargo-culting the research plan

## Out-of-scope for this scaffold

- real database layer
- auth system
- production deployment manifests
- fully working adapters
- worktree manager implementation
- PR automation
