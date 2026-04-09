# SpecRail Next Steps — 2026-04-09

This document turns the current MVP architecture into a practical implementation sequence.

## Priority order

1. **Spec schema + task document format definition**
   - Lock the artifact contract before building orchestration logic.
   - Define the minimum fields for spec, plan, task list, approvals, and execution prompts.
   - Make the format explicit enough that API handlers, adapters, and repo-local artifacts all speak the same language.

2. **`.specrail` control-plane artifact concretization**
   - Turn the template into a concrete artifact layout for managed projects/tracks.
   - Define required files, path conventions, track folders, metadata JSON, and event log locations.
   - Ensure new tracks can be materialized deterministically.

3. **Run state persistence**
   - Add file-backed repositories for projects, tracks, executions, and execution events.
   - Keep v1 artifact-first: readable JSON/JSONL with stable path conventions.
   - Make state transitions durable before wiring real executor runs.

4. **Codex executor MVP**
   - Replace the adapter stub with a practical local-Codex runner contract.
   - Support spawn/resume/cancel in MVP shape, even if event normalization remains intentionally small.
   - Persist session references and command metadata so failed runs are inspectable and resumable.

5. **MVP API for specs / runs / logs**
   - Expose enough HTTP surface to create tracks, inspect artifacts, start runs, and fetch logs.
   - Keep routing thin and delegate logic to file-backed services from the core/config layers.
   - Prefer stable JSON responses over broad feature coverage.

## Recommended issue split

### Issue 1 — Define spec schema and task document format
**Goal**
- Add shared types for spec/plan/task artifacts and a minimal serialization strategy.

**Deliverables**
- Core types for artifact metadata and task status
- Markdown/document conventions for `spec.md`, `plan.md`, and `tasks.md`
- Tests covering shape/serialization helpers

**Done when**
- A new track can be created with a deterministic, typed artifact contract.

### Issue 2 — Concretize `.specrail` control-plane artifacts
**Goal**
- Materialize managed-project and per-track artifact trees from code rather than docs alone.

**Deliverables**
- Shared path helpers
- Template/materialization utility for project index + per-track files
- Tests verifying generated layout and contents

**Done when**
- Code can create the expected artifact tree for a project/track in a temp directory.

### Issue 3 — Add file-backed run state persistence
**Goal**
- Persist projects, tracks, executions, and JSONL events using local files.

**Deliverables**
- File repositories / event store
- Read/write/update helpers with stable paths
- Tests for create/get/update/list flows and event append/list behavior

**Done when**
- A run lifecycle can survive process restarts using repo-local state only.

### Issue 4 — Build Codex executor MVP
**Goal**
- Implement a real MVP adapter contract for local Codex execution.

**Deliverables**
- Spawn command builder and persisted session metadata
- Resume/cancel behavior contract
- Initial normalized events for lifecycle transitions / shell invocation
- Tests for command/session metadata behavior

**Done when**
- SpecRail can start one Codex-backed run and persist enough metadata to inspect or resume it.

### Issue 5 — Expose MVP API for specs, runs, and logs
**Goal**
- Ship a minimal HTTP API over the artifact-first core.

**Deliverables**
- `POST /tracks`
- `GET /tracks/:trackId`
- `POST /runs`
- `GET /runs/:runId`
- `GET /runs/:runId/events`

**Done when**
- Another client can create a track, start a run, and fetch logs over HTTP.

## Execution notes

- Prefer **small focused commits** that map cleanly to the issues above.
- Close issues immediately if the implementation fully lands; otherwise leave them open with partial progress in the issue thread or commit references.
- Keep tests close to the changed package and run `pnpm check` plus targeted test commands before pushing.
- Avoid DB work for now; use readable artifacts first, then layer richer storage later if the API needs it.
