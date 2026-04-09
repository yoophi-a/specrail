# MVP Roadmap

This roadmap now reflects the implemented MVP baseline rather than the original scaffold plan.

## Baseline status as of 2026-04-09

### Done
- workspace bootstrap
- artifact document rendering for spec/plan/tasks
- artifact materialization and path helpers
- file-backed repositories for projects, tracks, executions, and events
- Codex executor MVP with spawn/resume/cancel
- HTTP API for tracks and runs
- SSE event streaming
- API validation/error contract tests

### In progress / partial
- approval workflow modeling
  - track-level `specStatus` and `planStatus` fields exist
  - dedicated approval events and approval action APIs do not
- event schema breadth
  - shared event types are defined
  - current adapter only emits a subset needed for lifecycle visibility
- artifact contract convergence
  - artifact-local `events.jsonl` exists in the generated layout
  - current API reads authoritative run events from `state/events/<runId>.jsonl`

### Not started
- project management APIs beyond the default bootstrap project
- database-backed persistence
- non-Codex adapters
- worktree/git branch orchestration beyond metadata
- UI, GitHub hooks, and chat integrations
- track/run listing and search endpoints

## Next milestone candidates

### Milestone A — Approval workflow completion
- add explicit approval action endpoints or commands
- persist approval events in run logs
- reconcile track readiness rules with approval state

### Milestone B — Artifact/state convergence
- decide whether per-track `events.jsonl` or `state/events/<runId>.jsonl` is the long-term source of truth
- document or remove duplicated event persistence surfaces
- connect run summaries back into track artifacts if desired

### Milestone C — Run lifecycle completeness
- update execution state to `completed` or `failed` from adapter lifecycle consistently at service level
- expose clearer status transitions to callers
- consider run listing endpoints for observability

### Milestone D — Second executor backend
- add another adapter behind the existing executor contract
- verify normalization remains stable across providers

### Milestone E — Interface expansion
- project CRUD
- artifact editing endpoints
- web UI and GitHub-facing entrypoints

## Suggested issue framing from the current baseline

1. **Approval workflow endpoints and event persistence**
   - finish the currently partial approval model
2. **Unify artifact-local and state-local event logs**
   - remove ambiguity in where callers should inspect history
3. **Propagate adapter completion/failure into execution records**
   - close the loop on run lifecycle state
4. **Add run/track listing endpoints**
   - improve basic API observability
5. **Add second executor adapter**
   - validate abstraction boundaries before UI work
