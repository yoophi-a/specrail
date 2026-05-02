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
  - runtime permission approval is still adapter-mediated rather than a backend-native broker callback
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
- model backend-native permission requests independent of adapter-specific payloads
- persist approval requested/resolved events with a consistent domain contract
- route approval decisions back to active executors without relying on edge-adapter synthesis

### Milestone C — Worktree and branch orchestration
- create isolated workspaces per execution when requested
- record branch/worktree metadata consistently
- define cleanup and recovery behavior for interrupted runs

### Milestone D — Project management APIs
- expose project create/list/get/update endpoints
- define how tracks are scoped and filtered by project
- add API and service tests for multi-project behavior

### Milestone E — Hosted operator UI / GitHub entrypoints
- introduce a web UI or GitHub-facing entrypoint after the core state contracts stabilize
- keep HTTP/SSE as the system of record for new clients
- reuse existing approval, event, and listing APIs rather than inventing parallel workflows

## Suggested issue framing from the current baseline

1. **Define artifact/state event-history ownership**
   - settle what belongs in repo-visible artifacts versus internal state.
2. **Add backend-native runtime approval broker callbacks**
   - make approval requests/resolutions first-class outside ACP/adapter synthesis.
3. **Add execution worktree orchestration**
   - isolate agent runs and track branch/worktree lifecycle.
4. **Add project management APIs**
   - move beyond the default bootstrap project.
5. **Plan the first hosted operator UI slice**
   - build on the stabilized HTTP/SSE API rather than adding new core behavior.
