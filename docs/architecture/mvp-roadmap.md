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
- project management APIs beyond the default bootstrap project
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

### Milestone D — Project management APIs
- expose project create/list/get/update endpoints
- define how tracks are scoped and filtered by project
- add API and service tests for multi-project behavior

### Milestone E — Hosted operator UI / GitHub entrypoints
- introduce a web UI or GitHub-facing entrypoint after the core state contracts stabilize
- keep HTTP/SSE as the system of record for new clients
- reuse existing approval, event, and listing APIs rather than inventing parallel workflows

## Suggested issue framing from the current baseline

1. **Record workspace cleanup apply events**
   - append normalized summary events for applied/refused/failed cleanup attempts.
3. **Add project management APIs**
   - move beyond the default bootstrap project.
5. **Plan the first hosted operator UI slice**
   - build on the stabilized HTTP/SSE API rather than adding new core behavior.
