# ACP server edge adapter

SpecRail now includes an initial ACP-facing server in `apps/acp-server`.

## Boundary

This server is an **edge adapter**, not a new system of record.

Authoritative state remains in the existing SpecRail stack:
- `SpecRailService` owns run lifecycle and persistence
- the existing HTTP + SSE API remains the control-plane and admin surface
- ACP adds a client-facing session transport for ACP-native tools and editors

## Current mapping

The initial adapter keeps the ACP surface intentionally narrow.

- ACP `session/new`
  - creates a lightweight ACP session record
  - requires `_meta.specrail.trackId`
  - may also carry `planningSessionId`, `backend`, and `profile`
- ACP `session/prompt`
  - first prompt starts a SpecRail run via `SpecRailService.startRun`
  - later prompts resume the same run via `SpecRailService.resumeRun`
- ACP `session/cancel`
  - maps to `SpecRailService.cancelRun`
- ACP `session/load`
  - replays persisted SpecRail run events as ACP `session/update` notifications
- ACP `session/list`
  - lists ACP session records and their linked SpecRail run ids when present

## Session identity

- ACP `sessionId` is an adapter-level handle persisted under `state/acp-sessions/`
- SpecRail `Execution.id` remains the canonical durable run id
- ACP session metadata stores the linked `runId` once a run has been started
- provider session ids remain secondary adapter/backend metadata, unchanged from the current run model

## Event mapping

For the first slice, the adapter emits normalized SpecRail execution events as generic ACP `session/update` agent message chunks and also includes the full original event in `_meta.specrail.executionEvent`.

That keeps the mapping stable without pretending SpecRail events already have a perfect ACP-native shape.

## Current limitations

This is intentionally an initial bridge, not a full ACP implementation.

1. `session/new` currently requires SpecRail-specific metadata, especially `_meta.specrail.trackId`.
2. Planning artifacts, approvals, channel bindings, and attachment flows stay in the existing REST API.
3. Runtime permission requests are **not** yet translated into ACP `session/request_permission` round-trips.
4. Event updates are currently surfaced as generic message-chunk notifications with SpecRail metadata attached, instead of a richer ACP-native event taxonomy.
5. The adapter stores ACP session records locally, but run state still lives in the normal SpecRail repositories.
6. Terminal and filesystem ACP capabilities are not exposed yet, because SpecRail-managed workspaces need a clearer ownership model first.

## Why this shape

This follows the ACP fit analysis in `docs/research/acp-fit-for-specrail.md`:
- ACP is useful at the outer interactive edge
- SpecRail should keep its domain-native workflow model
- the existing HTTP API should remain the place for track/planning/admin operations

## Near-term follow-up

Good next steps after this slice:
- translate runtime approval events into ACP permission requests
- enrich event mapping for tool calls, summaries, and status changes
- add an ACP-aware terminal or editor client spike against this adapter
- decide whether issue #81 should build on ACP event fidelity or another adjacent edge surface first
