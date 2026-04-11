# ACP fit analysis for SpecRail

## Summary

ACP (Agent Client Protocol) is a good fit for **adding a standard interactive agent surface** to SpecRail, but it is **not a good replacement for SpecRail's current control-plane API**.

My recommendation is:

- keep SpecRail's current HTTP + SSE API as the system-of-record API
- add ACP as an **additional interface adapter** for editor and ACP-native clients
- map ACP sessions onto SpecRail runs and planning context carefully, instead of trying to force Track and approval workflow concepts directly into ACP

In short, ACP helps most at the **edge**, not at the **core**.

## What SpecRail has today

SpecRail is currently built around a file-backed orchestration model with three strong opinions:

1. **Control plane first**
   - `Track`, `PlanningSession`, `ArtifactRevision`, `ApprovalRequest`, `Execution`, `ChannelBinding`, and `AttachmentReference` are first-class persisted entities.
   - `packages/core/src/services/specrail-service.ts` is the orchestration center.

2. **Provider-specific execution behind a small adapter contract**
   - `packages/adapters/src/interfaces/executor-adapter.ts` exposes `spawn`, `resume`, `cancel`, and `normalize`.
   - Current backends are `codex` and `claude_code`.

3. **Custom interface layer optimized for SpecRail workflows**
   - `apps/api` exposes track/run/planning/approval endpoints and SSE event streaming.
   - `apps/terminal` is an operator UI over that API.
   - `apps/telegram` is a thin chat adapter that binds external chats to tracks and starts runs.

That means SpecRail is already more than "an agent". It is a small orchestration platform with durable workflow state.

## What ACP would actually give SpecRail

ACP is strongest where SpecRail currently has custom, product-specific integration code.

### 1. Standard client compatibility

Today, every new surface needs a custom adapter like `apps/terminal` or `apps/telegram`.

With ACP, SpecRail could expose itself as an ACP-compatible agent so ACP clients could connect without a bespoke integration layer. That would reduce interface-specific work for:

- editor integrations
- ACP desktop/mobile clients
- third-party ACP bridges

For SpecRail specifically, this is most valuable if the team wants SpecRail runs to be started and observed from IDEs or generic ACP clients instead of only from the current API/terminal/chat flows.

### 2. Better fit for interactive execution than the current generic event model

SpecRail's normalized `ExecutionEvent` model is intentionally small:

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

That is enough for the current API and terminal UI, but it is still a lowest-common-denominator event rail.

ACP gives a stronger interaction contract for:

- session updates/chunks
- terminal lifecycle and output
- file reads/writes
- permission requests
- richer client-side UX for agent turns

For SpecRail, that could reduce how much provider detail is flattened too early in `normalize()`, especially for long-running interactive work where terminal/file events matter more than a simple stdout summary.

### 3. A real permission handshake shape

SpecRail has approval concepts, but they are split today:

- planning approvals are durable domain objects (`ApprovalRequest`)
- execution-time approvals are mostly normalized events and backend capability flags (`supportsApprovalBroker`)
- the README and docs still call out the approval broker as incomplete

ACP already has a concrete permission request/response pattern. That is attractive for SpecRail because it can give a standard wire format for runtime approval decisions, especially in interactive clients.

### 4. Less bespoke terminal/editor plumbing

SpecRail's terminal client currently talks to custom HTTP endpoints and opens SSE streams. ACP has built-in concepts for agent-client sessions, terminal creation/output, and client-mediated file access.

If SpecRail adds an ACP interface, the terminal app could eventually become either:

- an ACP client itself, or
- a thinner SpecRail-specific shell over an ACP session layer

That could simplify future clients more than it simplifies the current server.

## Where ACP does not fit SpecRail cleanly

This is the important part: ACP and SpecRail are solving overlapping but different problems.

### 1. SpecRail's core unit is a Track, not an ACP session

ACP is session/turn-oriented. SpecRail is workflow-oriented.

SpecRail persists and reasons about:

- track lifecycle (`new`, `planned`, `ready`, `in_progress`, `review`, etc.)
- revision history for `spec`, `plan`, and `tasks`
- approval state per artifact
- stale-vs-approved planning context on each run
- execution-to-track reconciliation

Those are not natural ACP primitives.

If SpecRail tried to replace its API with ACP, it would still need custom extension methods or out-of-band APIs for:

- track CRUD
- artifact revision history
- planning session history
- approval request listing and resolution
- list/filter/paginate tracks and runs
- channel binding lookup
- attachment reference registration

So ACP cannot replace most of the current control plane without immediately becoming "ACP + lots of SpecRail-specific extensions".

### 2. ACP is editor/interactive-agent shaped, while SpecRail also supports orchestration and chat flows

ACP assumes a client that is actively mediating the interaction, often an editor.

But SpecRail already has non-editor workflows:

- `apps/telegram` creates tracks from chat messages
- channel bindings resolve external chat/thread IDs back to a SpecRail context
- attachment references are registered independently of the execution backend
- the HTTP API supports list/query/reporting flows that do not look like prompt-turn RPC

That means ACP would naturally cover only part of SpecRail's surface area.

Telegram in particular would not become simpler just because ACP exists. The Telegram app still needs channel identity, binding persistence, attachment mapping, and message fan-out policy. ACP does not replace those concerns.

### 3. SpecRail already has a backend abstraction, but ACP sits at a different layer

`ExecutorAdapter` is a provider/runtime abstraction for starting and controlling coding agents.

ACP is not really a drop-in replacement for that interface. ACP is usually the protocol **between a client and an agent**, not the internal adapter between SpecRail and provider CLIs.

So replacing current adapters with ACP would only make sense if the actual backends SpecRail runs were exposed as ACP agents and SpecRail became an ACP client to them.

That would add a translation layer:

- SpecRail `Execution` -> ACP session
- SpecRail events -> ACP notifications
- ACP file/terminal/permission calls -> SpecRail event + persistence model

That may be worthwhile later, but it is a larger architecture move than just "support ACP".

### 4. File-backed, resumable workflow state remains a SpecRail concern

SpecRail's value is not only transport. It is durable orchestration state:

- state in `state/`
- artifacts in `artifacts/`
- session and event logs in `sessions/` and `events/`
- planning context snapshots stored on each run

ACP does not remove the need for any of that. It only standardizes how one client talks to one agent session.

So ACP would not reduce the hardest SpecRail-specific logic in `SpecRailService`, especially:

- planning-context validation before run start
- stale-context detection after approvals change
- run-to-track reconciliation
- artifact approval side effects
- multi-surface binding logic

## Detailed comparison by SpecRail subsystem

## 1. API layer (`apps/api`)

### Current strength

The current API is directly aligned to SpecRail's domain.

Examples:

- `POST /tracks`
- `GET /tracks/:trackId`
- `POST /runs`
- `POST /runs/:runId/resume`
- `POST /approval-requests/:id/approve`
- `GET /runs/:runId/events/stream`

This is very good for automation, admin tooling, and domain inspection.

### ACP impact

ACP could complement the API for interactive runs, but it should not replace these routes.

Best fit:

- expose an ACP agent that internally calls `SpecRailService.startRun`, `resumeRun`, `cancelRun`, and `recordExecutionEvent`
- keep REST endpoints for durable entities and reporting

Bad fit:

- trying to model `Track`, `ApprovalRequest`, and artifact revision CRUD purely as ACP methods

### Net result

- **Advantage:** adds a standard interactive surface
- **Disadvantage:** duplicates some runtime/session capabilities unless boundaries are kept clear

## 2. Adapters/execution backends (`packages/adapters`)

### Current strength

Current adapters are very small and pragmatic:

- spawn a CLI
- capture metadata
- normalize events
- support resume/cancel best-effort

This matches the current Codex/Claude Code integrations well.

### ACP impact

There are two possible uses of ACP here.

#### Option A: keep current adapters, add ACP only at the client-facing edge

This is the safer option.

- SpecRail remains the orchestrator
- current `ExecutorAdapter` stays unchanged
- ACP server translates client session actions into existing SpecRail run actions

Pros:

- low disruption
- preserves current backend behavior
- keeps migration incremental

Cons:

- ACP benefits stop at the outer boundary
- provider-specific richness is still limited by current adapter normalization

#### Option B: let SpecRail talk to ACP-native agents as backends

This means adding something like an `AcpExecutorAdapter`.

Pros:

- opens backend choice beyond Codex/Claude-specific process wrappers
- better standardization for session updates and permission handling

Cons:

- much larger change
- requires ACP session orchestration inside SpecRail
- resume/cancel semantics must be re-mapped carefully
- local workspace/file ownership becomes more ambiguous because ACP often assumes client-mediated fs/terminal operations

### Net result

ACP is better as a **new backend option** or **new outer interface**, not as an immediate replacement for all current adapters.

## 3. Terminal client (`apps/terminal`)

### Current strength

The terminal app is a SpecRail operator console, not just a chat window. It knows about:

- tracks
- planning sessions
- artifact revisions
- approval queues
- run event tails
- stale planning context

### ACP impact

ACP would help most with the **run interaction** part, but much less with the **operator control-plane** part.

A pure ACP client terminal would be good at:

- interactive prompt turns
- streaming agent output
- tool/terminal/permission display

But SpecRail's terminal also needs:

- list views with sorting/filtering over many tracks/runs
- planning workspace inspection
- approval review across artifacts
- stateful admin operations

So ACP can improve the live run pane, but it does not replace the current terminal architecture.

### Net result

- **Advantage:** cleaner standardized live-session UX
- **Disadvantage:** terminal still needs the existing API for operator views

## 4. Telegram flow (`apps/telegram`)

### Current strength

The Telegram app is intentionally thin:

- resolve or create a `ChannelBinding`
- optionally create a new track
- register attachment references
- start a run
- relay event summaries back to Telegram

### ACP impact

ACP does not solve:

- Telegram chat/thread identity
- webhook ingestion
- attachment lookup/registration
- outbound message formatting and throttling
- mapping multiple Telegram messages onto durable track/planning state

If SpecRail exposed ACP, the Telegram bridge could theoretically talk ACP to SpecRail instead of calling REST directly. But the app would still need almost all of its current chat-specific logic.

So ACP would be a transport swap here, not a major product simplifier.

### Net result

Low leverage relative to editor or desktop client scenarios.

## 5. Planning and approval model

### Current strength

SpecRail has a stronger planning model than ACP:

- `PlanningSession`
- `PlanningMessage`
- `ArtifactRevision`
- `ApprovalRequest`
- run start gates on approved planning context
- run records persist the exact approved revision IDs they launched with

This is a meaningful product feature, not just metadata.

### ACP impact

ACP can help with **runtime permission prompts**, but it does not natively cover SpecRail's planning artifact lifecycle.

That means:

- planning approvals should remain SpecRail-native domain objects
- ACP permission requests should be treated as execution-time interaction, not as a replacement for artifact approvals

If those two approval systems are merged carelessly, the model gets muddy fast.

### Net result

ACP helps the missing runtime approval handshake, but not the planning approval workflow.

## Concrete migration/integration options

## Option 1. Add an ACP server in front of SpecRail, keep existing API as source of truth

### Shape

Add something like:

- `apps/acp-server/` or `apps/api/src/acp.ts`

Responsibilities:

- accept ACP initialization/session requests
- create/load ACP sessions backed by SpecRail runs
- stream SpecRail execution events as ACP session notifications
- translate ACP permission requests/responses into runtime approval events
- optionally expose file/terminal actions via current execution workspace rules

### Mapping

Possible first mapping:

- ACP session -> SpecRail run
- ACP session metadata -> `Execution` + planning context snapshot
- ACP user prompt turn -> `startRun` or `resumeRun`
- ACP progress notifications -> `ExecutionEvent`
- ACP permission outcome -> runtime event and optional approval persistence

### Why this is the best first move

- minimal disruption to current architecture
- preserves current REST/SSE clients
- proves real interoperability value quickly
- avoids forcing `Track` semantics into ACP prematurely

## Option 2. Add an `AcpExecutorAdapter` backend

### Shape

Implement a new adapter under `packages/adapters/src/providers/acp-adapter.ts` that talks to ACP-native agents.

Use cases:

- run ACP-compatible agents as providers behind SpecRail
- keep SpecRail's control plane unchanged while broadening backend choice

### Risks

- more architectural work than Option 1
- ACP transport and session lifecycle become part of the backend orchestration layer
- terminal/file access semantics may overlap awkwardly with SpecRail-managed workspaces

### When it makes sense

Only after SpecRail has a clear need to run ACP-native agents that are not easy to integrate directly as local CLIs.

## Option 3. Replace the current API with ACP

I do **not** recommend this.

Why:

- most durable SpecRail entities still need custom methods
- list/filter/admin/reporting flows become unnatural
- Telegram/operator workflows still need product-specific APIs
- you lose the clarity of the current domain-oriented surface

## Recommended boundary

If SpecRail adopts ACP, the clean boundary is:

- **SpecRail core remains domain-native**
  - tracks
  - planning sessions
  - revisions
  - approvals
  - runs
  - channel bindings
  - attachments

- **ACP becomes an interface adapter**
  - good for interactive clients and session streaming
  - not the persistence or workflow model

- **REST + SSE remain the control-plane/admin API**
  - good for listing, querying, approval review, and chat adapters

## Practical implementation notes

### 1. Do not collapse planning approval and runtime permission into one table immediately

Keep two concepts separate:

- artifact approval for `spec` / `plan` / `tasks`
- runtime permission requests during an active session

They may share UI later, but they are not the same workflow.

### 2. Keep run identity stable across ACP session reloads

SpecRail's durable key should stay the run ID.

Recommended mapping:

- SpecRail `Execution.id` is the canonical durable ID
- ACP `sessionId` maps to that run, or to a stable alias that can always resolve back to it
- provider session IDs remain secondary metadata

This preserves current resume/cancel/reporting behavior.

### 3. Preserve current event persistence even if ACP is introduced

ACP notifications are transport-level updates. SpecRail still benefits from persisting normalized events in JSONL because:

- SSE replay already depends on it
- terminal inspection depends on it
- postmortem/debugging depends on it
- Telegram summary fan-out depends on it

### 4. Treat file/terminal ACP features carefully with SpecRail-managed workspaces

SpecRail already allocates `workspaces/<runId>/` and stores command/session metadata.

If ACP clients start using filesystem and terminal capabilities directly, SpecRail needs clear rules for:

- which workspace is mounted/exposed
- whether file writes are advisory or authoritative
- how external writes are reflected in event history
- whether terminal sessions belong to SpecRail, the ACP client, or the backend agent

This is one of the biggest integration design points.

### 5. Expect extension methods for planning-aware UX

Even with ACP added, SpecRail will likely still need custom ACP extension methods or a parallel REST API for:

- list tracks/runs
- inspect planning sessions and revisions
- approve/reject artifact revisions
- resolve channel bindings
- query attachments

That is fine. The mistake would be pretending ACP eliminates those needs.

## Decision

ACP is worthwhile for SpecRail if the goal is one or both of these:

1. expose SpecRail to editor and ACP-native clients without building a bespoke integration for each one
2. support ACP-native agent backends later through a new adapter

ACP is **not** worthwhile if the goal is to replace SpecRail's current domain API or planning model.

## Recommended next steps

1. Implement ACP as an **additional interface adapter**, not a replacement.
2. Keep `apps/api` as the source of truth for durable workflow entities.
3. Start with a narrow ACP mapping around run/session lifecycle only.
4. Keep planning approvals and artifact revisions in SpecRail-native APIs.
5. Re-evaluate an `AcpExecutorAdapter` only after the ACP server edge proves useful.

## Suggested first implementation slice

A practical first slice would be:

- create `apps/acp-server`
- map ACP initialize + session creation to SpecRail run creation/resume
- stream persisted `ExecutionEvent`s as ACP session notifications
- support runtime permission round-trips without changing artifact approval semantics
- document how ACP session IDs map to `Execution.id`
- leave track listing/planning approval/revision browsing in the existing REST API

That gives SpecRail real ACP interoperability without destabilizing its current architecture.