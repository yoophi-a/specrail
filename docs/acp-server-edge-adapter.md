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

The adapter now keeps the raw SpecRail event payload in `_meta.specrail.executionEvent`, but it also adds a few ACP-facing projections so clients can render session state with less guesswork.

### Session update mapping

| SpecRail signal | ACP projection | Notes |
| --- | --- | --- |
| `task_status_changed` with `payload.status` | `session/update` with `session_info_update` | Mirrors the current run status into `_meta.specrail.status`. |
| any persisted execution event | `session/update` with `agent_message_chunk` | Still emits a readable text chunk like `[tool_call] ...` and includes the full event in `_meta`. |
| `approval_requested` | `session/update` + `session/request_permission` | Session status is promoted to `waiting_approval`, and the permission request carries request/tool metadata when present. |
| `approval_resolved` | `session/update` with `session_info_update` + `agent_message_chunk` | Clears the pending permission marker and surfaces the resolution outcome back to ACP clients. |

### Permission round-trip

Runtime approval is still adapter-mediated, but the ACP edge now supports a basic round-trip shape:

1. SpecRail emits `approval_requested`.
2. The ACP adapter publishes `session/request_permission` with the original event attached in `_meta.specrail.executionEvent`.
3. The client answers on the next `session/prompt` with `_meta.specrail.permissionResolution`.
4. The adapter records a synthetic `approval_resolved` execution event and resumes the linked SpecRail run.

Example client payload:

```json
{
  "sessionId": "specrail-abc123",
  "prompt": [{ "type": "text", "text": "Permission approved, continue" }],
  "_meta": {
    "specrail": {
      "permissionResolution": {
        "requestId": "run-1-approval-request",
        "outcome": "approved",
        "decidedBy": "user",
        "comment": "ok"
      }
    }
  }
}
```

## Current limitations

This is intentionally an initial bridge, not a full ACP implementation.

1. `session/new` currently requires SpecRail-specific metadata, especially `_meta.specrail.trackId`.
2. Planning artifacts, approvals, channel bindings, and attachment flows stay in the existing REST API.
3. Runtime permission requests are translated into ACP-friendly updates, but they are still mediated by the adapter rather than a backend-native approval broker.
4. Event updates are richer than the initial bridge, but the mapping still collapses many provider-specific details into `session/update` plus `_meta` rather than a full ACP-native event taxonomy.
5. The adapter stores ACP session records locally, but run state still lives in the normal SpecRail repositories.
6. Terminal and filesystem ACP capabilities are not exposed yet, because SpecRail-managed workspaces need a clearer ownership model first.
7. `approval_resolved` is currently synthesized by the ACP adapter when the client sends `permissionResolution`, so the persisted event expresses the ACP decision clearly but does not yet prove that the underlying executor consumed a real broker callback.

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
