# Runtime Approval Workflow

This guide defines the provider-neutral runtime approval contract for SpecRail clients. It is separate from artifact revision approval: artifact approvals decide whether planning documents become current, while runtime approvals decide whether an active executor may continue after a provider reports a blocked tool or permission request.

## Event Contract

Runtime approvals are represented as normal run events.

Clients should detect pending approval from:

- `event.type === "approval_requested"`
- `event.status === "waiting_approval"` when present
- `run.status === "waiting_approval"` after the service reconciles the run from events

Clients should treat these fields as the provider-neutral display contract:

| Field | Meaning |
| --- | --- |
| `event.id` | Stable fallback request id when `payload.requestId` is absent. |
| `event.executionId` | Run id that owns the approval request. |
| `event.timestamp` | Time the request was recorded. |
| `event.summary` | Human-readable request summary. |
| `event.status` | Usually `waiting_approval` for pending requests. |
| `event.payload.requestId` | Provider or adapter request id when available. |
| `event.payload.toolName` | Tool or operation name when available. |
| `event.payload.toolUseId` | Provider tool-use id when available. |

Provider-specific fields such as `providerSessionId`, `providerInvocationId`, `providerEventType`, `providerEventSubtype`, raw tool input, model details, or adapter metadata are debug context. UI and automation should not require them for the primary approval flow.

## Resolution API

Resolve a runtime approval through the run-scoped API:

```http
POST /runs/:runId/approval-requests/:requestId/approve
POST /runs/:runId/approval-requests/:requestId/reject
```

Request body:

```json
{
  "decidedBy": "user",
  "comment": "Approved from operator UI"
}
```

`decidedBy` must be one of `user`, `agent`, or `system`. `comment` is optional.

`requestId` can be either the approval request event id or `event.payload.requestId` when the provider supplies one. SpecRail resolves the request by matching both forms.

The response contains the canonical `approval_resolved` event:

```json
{
  "event": {
    "type": "approval_resolved",
    "source": "specrail",
    "summary": "Approved runtime approval request run-1:approval-requested",
    "payload": {
      "status": "running",
      "requestId": "run-1:approval-requested",
      "requestEventId": "event-id",
      "outcome": "approved",
      "decidedBy": "user",
      "comment": "Approved from operator UI",
      "toolName": "Bash",
      "toolUseId": "toolu-1"
    }
  }
}
```

Rejected decisions use `outcome: "rejected"` and `payload.status: "cancelled"`.

## Client Behavior

Clients should:

1. Load run detail and recent events from `GET /runs/:runId` plus `GET /runs/:runId/events`, or follow `GET /runs/:runId/events/stream`.
2. Find unresolved `approval_requested` events by checking whether a later `approval_resolved` event references the same `requestId` or `requestEventId`.
3. Display the request using `summary`, `toolName`, `toolUseId`, timestamp, and run id.
4. Send an approve/reject request through the run-scoped API.
5. Refresh run detail/events after resolution because executor callbacks may append additional events.

Do not infer approval state from provider-specific payloads alone. The event type and resolved-event references are the canonical state.

## Current Executor Behavior

Codex and Claude Code currently implement runtime approval callbacks with conservative fallback behavior:

- Approved decisions spawn a normal resume fallback with the prompt `Permission approved. Continue the blocked operation.`
- Rejected decisions record a no-retry outcome and mark the adapter session cancelled.
- Callback delivery may append a `summary` event that reports `strategy: "resume_fallback"` or `strategy: "no_retry"`.
- If an executor does not implement `resolveRuntimeApproval`, SpecRail records an unsupported callback summary event.
- If callback delivery fails, SpecRail records a failed callback summary event and preserves the canonical `approval_resolved` decision.

Future provider-native permission continuation can replace the resume fallback without changing the client-facing `approval_requested` and `approval_resolved` contract.

## Surface Notes

- Hosted operator UI and terminal clients should show pending approvals near the active run detail and disable duplicate decisions after a resolution event appears.
- ACP clients receive approval projections as session updates and permission requests, but should still treat SpecRail events as canonical.
- GitHub and Telegram frontends should stay thin: they can notify that a run is waiting for approval and link operators back to the authenticated operator surface rather than exposing raw provider payloads in chat.

## Related Docs

- [Domain entities](./domain-entities.md)
- [ACP server edge adapter](./acp-server-edge-adapter.md)
- [Claude Code operations](./claude-code-operations.md)
- [Hosted Operator UI deployment](./operator-ui-deployment.md)
