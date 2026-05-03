# MVP Roadmap

This roadmap reflects the implemented MVP baseline and the next practical gaps to turn into issues.

## Baseline status as of 2026-05-02

### Done
- workspace bootstrap
- artifact document rendering for `spec.md`, `plan.md`, and `tasks.md`
- artifact materialization and path helpers
- file-backed repositories for projects, tracks, planning sessions/messages, artifact revisions, approval requests, channel bindings, attachment references, executions, and events
- Codex executor MVP with spawn/resume/cancel
- Claude Code executor MVP with spawn/resume/cancel and structured stream normalization
- HTTP API for tracks, planning sessions/messages, artifact revisions, approval requests, channel bindings, attachments, runs, and run events
- track and run listing with filtering, pagination, and explicit sorting
- approval request proposal, approve, and reject APIs for artifact revisions
- planning-context capture for runs, including stale-context rejection while newer planning revisions are pending approval
- execution state reconciliation from terminal adapter events into run and track records
- SSE event streaming for run history and appended events, with deterministic integration coverage
- API validation/error contract tests
- baseline validation workflow with typecheck, Markdown link check, tests, and build
- terminal client planning workspace, run monitor, and SSE follow support
- Telegram update handling for track binding, attachments, and run-event relay
- ACP edge adapter for session/run mapping and permission-resolution projection

### In progress / partial
- event schema breadth
  - shared event types are defined
  - adapters still emit different fidelity depending on provider capabilities
  - some provider-specific fields remain in `payload` / `_meta`
- approval workflow depth
  - artifact revision approval is implemented
  - runtime permission request resolution is available through core service and HTTP APIs
  - Codex and Claude Code runtime approval callbacks use provider-specific resume/no-retry fallbacks
- artifact contract convergence
  - generated track artifacts exist in the repo-visible layout
  - authoritative run events still live under `state/events/<runId>.jsonl`
  - artifact-local event surfaces need a clear long-term contract
- interface expansion
  - terminal, Telegram, ACP, and HTTP surfaces exist
  - hosted web UI and GitHub app/webhook entrypoints are still deferred

### Not started
- database-backed persistence
- production auth system
- production deployment manifests
- worktree/git branch orchestration beyond metadata
- hosted GitHub app/webhook automation
- web UI

## Next milestone candidates

### Milestone A — Artifact/state convergence
- decide whether repo-visible artifacts should include canonical run history, summaries, or only generated planning documents
- remove or document duplicated event persistence surfaces
- connect completed run summaries back into track artifacts if desired

### Milestone B — Runtime approval broker
- core/API approval decisions route back to active executors through callback hooks
- approval requested/resolved events stay provider-neutral while preserving provider metadata
- Codex and Claude Code currently use normal resume fallbacks for approved decisions and no-retry cancellation for rejected decisions
- future provider-native permission continuation can replace the resume fallback when available

### Milestone C — Worktree and branch orchestration
- current contract defines `directory` and `git_worktree` workspace modes
- workspace manager abstraction supports default directory allocation and explicit git worktree command planning/execution
- config/env wiring exposes workspace mode selection to API and ACP server entrypoints
- record branch/worktree metadata consistently
- cleanup safety contract defines dry-run, ownership checks, event recording, and partial-failure behavior
- non-destructive cleanup planner previews directory and git worktree operations with guardrail refusal reasons
- API cleanup preview endpoint exposes dry-run plans without filesystem or git side effects
- core cleanup applier requires explicit confirmation and injectable filesystem/git runners before applying previewed operations
- API cleanup apply endpoint requires a run-id-specific confirmation phrase and reconstructs the plan server-side
- cleanup apply attempts are recorded as run summary events for applied, refused, and failed outcomes
- terminal API client exposes cleanup preview/apply methods and preserves server-provided confirmation/refusal details
- terminal UI exposes guarded cleanup preview/apply controls for selected terminal runs
- GitHub Actions workflows opt JavaScript actions into the Node.js 24 runtime ahead of runner defaults
- terminal cleanup apply refreshes selected run detail/events immediately after apply attempts when possible
- terminal cleanup controls have an integration-style keypress flow test for preview, confirmation, apply, and refresh

### Milestone D — Project management APIs
- project create/list/get/update endpoints expose basic project metadata beyond the bootstrap default
- track create/list APIs accept project scope while preserving default-project behavior for existing clients
- terminal client can load projects and cycle project-scoped track listings while preserving all-project behavior by default
- Telegram and ACP entrypoints can opt into explicit project context while preserving default behavior when omitted
- hosted operator UI can select project scope for track listings via the same HTTP contract

### Milestone E — Hosted operator UI / GitHub entrypoints
- first hosted operator UI slice is served from `GET /operator` with HTML/script helpers isolated in `apps/api/src/operator-ui.ts`
- hosted UI loads project, track, and run summary state from the existing HTTP API
- hosted UI can create/update projects through existing project APIs
- hosted UI project selection filters tracks via the same `GET /tracks?projectId=...` contract used by thin clients
- hosted UI can create tracks and update selected-track workflow/approval state through existing track APIs
- hosted UI can create planning sessions and append planning messages through existing planning APIs
- hosted UI selected-track detail shows artifact/planning context previews from existing track detail APIs
- hosted UI selected-track detail can propose spec/plan/tasks revisions through existing artifact proposal APIs
- hosted UI selected-track detail can approve/reject pending artifact requests through existing approval endpoints
- hosted UI selected-track detail can start runs through the existing run creation API
- hosted UI selected-run detail shows run metadata and recent events from existing run/event APIs
- hosted UI selected-run detail can resume/cancel runs through existing lifecycle APIs
- hosted UI selected-run detail appends live SSE event updates while a run is selected
- hosted UI selected-run detail can request cleanup preview/apply through the existing explicit confirmation flow
- hosted UI action controls use shared in-flight/error handling and preserve cleanup apply results if post-apply refresh fails
- hosted UI shell rendering composes separately testable style and client script helpers without adding a new frontend build pipeline
- hosted UI top-level project and track actions use inline form controls while preserving the same HTTP API calls
- hosted UI selected-track planning and artifact proposal actions use inline controls for session/message/proposal fields
- hosted UI selected-detail workflow and run lifecycle actions use inline controls for status and prompt fields
- hosted UI destructive run cancel and workspace cleanup apply flows use in-page confirmation controls
- hosted UI tests guard against reintroducing browser-native prompt/confirm dialogs and group shell coverage by action area without adding a frontend build pipeline
- hosted UI markup exposes stable `data-control-group` selectors for major action areas
- hosted UI client action harness exercises top-level project/track, project-scope filtering, form validation guardrails, selected-detail failure states, selected-track, artifact approval, selected-run click handlers, and live event stream lifecycle without a browser dependency
- hosted UI fake DOM/fetch harness is isolated in a focused API test helper with named setup-flow methods
- keep HTTP/SSE as the system of record for new clients
- reuse existing approval, event, and listing APIs rather than inventing parallel workflows

## Suggested issue framing from the current baseline

1. **Hosted operator UI action failure harness**
   - add no-dependency client coverage for failed POST/PATCH actions and user-visible status errors while preserving button re-enable behavior.
