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
- `specrail/workspace/read`
  - reads an explicit file or directory under the linked run workspace
  - rejects absolute paths and traversal outside the SpecRail-managed workspace root
  - returns `_meta.specrail.workspaceCapability` metadata with the linked `runId`, workspace path, allowed operations, and cleanup block state

## Session identity

- ACP `sessionId` is an adapter-level handle persisted under `state/acp-sessions/`
- SpecRail `Execution.id` remains the canonical durable run id
- ACP session metadata stores the linked `runId` once a run has been started
- provider session ids remain secondary adapter/backend metadata, unchanged from the current run model

## Event mapping

The adapter now keeps the raw SpecRail event payload in `_meta.specrail.executionEvent`, but it also adds a few ACP-facing projections so clients can render session state with less guesswork.
Known event families additionally include `_meta.specrail.eventProjection`, a compact stable summary intended for display logic. Unknown event types still include the raw execution event and readable message chunk without a projection.

### Session update mapping

| SpecRail signal | ACP projection | Notes |
| --- | --- | --- |
| `task_status_changed` with `payload.status` | `session/update` with `session_info_update` | Mirrors the current run status into `_meta.specrail.status`. |
| any persisted execution event | `session/update` with `agent_message_chunk` | Still emits a readable text chunk like `[tool_call] ...` and includes the full event in `_meta`. Known event families also include `_meta.specrail.eventProjection`. |
| `approval_requested` | `session/update` + `session/request_permission` | Session status is promoted to `waiting_approval`, and the permission request carries request/tool metadata when present. |
| `approval_resolved` | `session/update` with `session_info_update` + `agent_message_chunk` | Clears the pending permission marker and surfaces the resolution outcome back to ACP clients. |

### Event projection shape

`_meta.specrail.eventProjection` is intentionally compact and additive. Current projections cover:

- `tool_call`: `kind`, `toolName`, `toolUseId`
- `tool_result`: `kind`, `toolName`, `toolUseId`, `exitCode`, `status`
- `approval_requested`: `kind`, `requestId`, `toolName`, `toolUseId`
- `approval_resolved`: `kind`, `requestId`, `outcome`, `decidedBy`
- `task_status_changed`: `kind`, `status`
- `message`: `kind`, `subtype`, `role`
- `summary`: `kind`, `subtype`, `status`
- `test_result`: `kind`, `status`, `passed`, `failed`
- `file_change`: `kind`, `path`, `operation`
- `shell_command`: `kind`, `command`, `exitCode`, `status`

Clients should use these fields for common rendering, and fall back to `_meta.specrail.executionEvent` when they need provider-specific or not-yet-projected payload details. Projection fields are optional when the source payload does not provide the corresponding value.

Claude Code events additionally include `eventProjection.provider` when `event.source` is `claude_code` or the subtype starts with `claude_`. The nested provider projection is compact and may include `kind: "claude_code"`, `subtype`, `providerSessionId`, `providerInvocationId`, `providerEventType`, `providerEventSubtype`, `model`, `lifecycleStatus`, `durationMs`, `durationApiMs`, `totalCostUsd`, `numTurns`, and `isError`.

### Permission round-trip

Runtime approval decisions now use the same domain service/API path as non-ACP clients:

1. SpecRail emits `approval_requested`.
2. The ACP adapter publishes `session/request_permission` with the original event attached in `_meta.specrail.executionEvent`.
3. The client answers on the next `session/prompt` with `_meta.specrail.permissionResolution`.
4. The adapter calls `SpecRailService.resolveRuntimeApprovalRequest(...)` to record the canonical `approval_resolved` event and deliver the decision to executor callbacks when supported.
5. If an approved decision is not handled by an executor callback, the adapter falls back to resuming the linked SpecRail run. Rejected decisions stay resolved without a resume fallback.

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

## Workspace ownership rules

ACP clients must treat SpecRail workspaces as **SpecRail-managed execution workspaces**, not as client-owned filesystem roots.

- SpecRail allocates and records execution workspaces through the configured execution workspace manager.
- The linked SpecRail `Execution.id` remains the owner of workspace lifecycle, cleanup eligibility, and audit history.
- ACP clients may display workspace paths from run metadata as contextual references, but they should not assume direct read/write access unless a future ACP filesystem capability explicitly grants it.
- Any future ACP filesystem or terminal capability must be scoped to the linked run workspace and mediated by SpecRail, so access checks, refusal reasons, and cleanup state stay consistent with the existing REST/API model.
- Workspace cleanup remains a SpecRail operation. Clients should call the existing cleanup preview/apply flow rather than deleting paths directly.
- Provider-created session metadata and transient terminal state are adapter/backend details; they do not transfer ownership of the workspace to the ACP client.

These rules keep ACP as a thin interactive edge while preserving SpecRail as the canonical owner of execution state, artifacts, and workspace cleanup.

## Scoped filesystem and terminal capability shape

Filesystem and terminal ACP capabilities stay narrow. The current spike exposes read-only workspace inspection through `specrail/workspace/read`; terminal access and writes remain future work.

- Capability grants are session-local and tied to a linked SpecRail `runId`; clients must not request arbitrary host paths.
- The effective root is the SpecRail-managed `workspacePath` for that run. Relative paths resolve under that root and must be rejected if they escape it.
- The adapter should expose capability metadata through `_meta.specrail.workspaceCapability`, including `runId`, `workspacePath`, allowed operations, and whether cleanup is currently blocked by active execution.
- Filesystem reads start as explicit file/directory reads, not broad recursive sync. Writes require a separate future operation grant and should record a SpecRail execution event or equivalent audit entry.
- Terminal access should run through a SpecRail-mediated command/session API, inherit the linked run workspace, and emit execution events for command start/output/exit rather than becoming an unmanaged client shell.
- Refusals should be structured and non-sensitive, for example `missing_run`, `workspace_unavailable`, `path_outside_workspace`, `operation_not_allowed`, `cleanup_blocked`, or `active_run_required`.
- Cleanup remains outside the ACP capability. Clients may surface cleanup status and links/actions, but deletion must still use the SpecRail cleanup preview/apply flow.

This shape preserves the workspace ownership rules while leaving room for ACP-native clients to inspect and interact with a run workspace in a controlled way.

Current `specrail/workspace/read` responses are intentionally bounded:
- directory reads return up to 100 entries and a `truncated` flag
- file reads return UTF-8 content up to 64,000 characters and a `truncated` flag
- refusals use structured non-sensitive `error.data.reason` values such as `missing_run`, `workspace_unavailable`, `path_outside_workspace`, `path_not_found`, or `operation_not_allowed`

## Planning and admin boundary

ACP should stay focused on interactive session transport. Planning and admin flows remain owned by the REST/API surface unless they need direct, session-local interaction.

REST/API-native flows:
- project create/list/update and project-scoped track discovery
- track creation, status updates, and workflow metadata updates outside an ACP `session/new` bootstrap
- planning session history, artifact revision proposals, and spec/plan/task approval state
- channel binding, attachment registration, report serving, and cleanup preview/apply operations
- operator/admin actions that need full auditability or batch-oriented UI controls

ACP-native candidates:
- interactive `session/prompt`, `session/cancel`, `session/load`, and `session/list`
- runtime permission request/response round-trips that are tied to the active ACP session
- future scoped filesystem or terminal interactions for the linked run workspace, after applying the workspace ownership rules above
- lightweight session-local projections that help ACP clients render run progress without becoming the canonical artifact store

This boundary keeps canonical planning artifacts, approvals, channel bindings, and cleanup lifecycle in SpecRail APIs while allowing ACP clients to provide a native interactive run experience.

## Current limitations

This is intentionally an initial bridge, not a full ACP implementation.

1. `session/new` currently requires SpecRail-specific metadata, especially `_meta.specrail.trackId`.
2. Planning artifacts, approvals, channel bindings, attachment flows, and cleanup operations stay in the existing REST API per the planning/admin boundary above.
3. Runtime permission requests are translated into ACP-friendly updates; decisions are persisted through the core approval path and delivered to executors that implement `resolveRuntimeApproval`.
4. Event updates include compact projections for common SpecRail event families, but many provider-specific details still remain in `session/update` plus raw `_meta` rather than a full ACP-native event taxonomy.
5. The adapter stores ACP session records locally, but run state still lives in the normal SpecRail repositories.
6. Terminal ACP capabilities and filesystem writes are not exposed yet; future versions should follow the scoped capability shape above before granting additional access.
7. `approval_resolved` records the operator decision. Callback delivery may additionally append handled, unsupported, or failed callback events depending on the selected executor.

## Why this shape

This follows the ACP fit analysis in `docs/research/acp-fit-for-specrail.md`:
- ACP is useful at the outer interactive edge
- SpecRail should keep its domain-native workflow model
- the existing HTTP API should remain the place for track/planning/admin operations

## Near-term follow-up

Good next steps from the current bridge:
- replace approved-permission resume fallbacks with narrower provider-native permission continuation when Codex or Claude Code expose a usable primitive
- expand ACP-facing projections for additional provider-specific details when clients need them beyond the current Claude Code metadata
- extend the scoped ACP filesystem capability with audited write operations if a concrete ACP client needs them
- build an ACP-aware terminal or editor client spike against this adapter to validate the session/update and permission request shapes with a real client
- revisit the planning/admin boundary only when a concrete ACP client needs a narrowly scoped session-local interaction
