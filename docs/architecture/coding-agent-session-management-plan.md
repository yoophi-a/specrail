# Coding agent session management plan

SpecRail already starts coding agents as local child processes and persists a run-local `sessionRef` on each execution. This document records how each supported coding-agent backend models sessions today and defines the implementation plan for choosing whether to continue an existing session or start a fresh one.

## Implementation status

Implemented in the MVP slice:

- `GET /runs/:runId/session` returns the run, session metadata when available, and backend continuity capabilities.
- `POST /runs/:runId/resume` keeps same-run provider continuity and marks the execution `continuityMode: "resume_same_run"`.
- `POST /runs/:runId/fork` creates a new linked execution with `parentExecutionId`, `parentSessionRef`, `sourceRunId`, and `continuityMode`.
- Claude Code advertises provider-native fork support and uses `--resume <provider-session-id> --fork-session` for `mode: "provider_fork"`.
- Codex advertises context-copy fork support and starts a fresh Codex session seeded with source run/session context.
- Hosted operator UI exposes resume and fork controls; terminal run detail renders continuity/parent session metadata.

## Current SpecRail control-plane model

The shared executor boundary is `ExecutorAdapter` in `packages/adapters/src/interfaces/executor-adapter.ts`:

- `spawn(input)` starts a new provider invocation and returns a stable SpecRail `sessionRef`.
- `resume(input)` continues the provider session referenced by `sessionRef` and returns new command metadata/events.
- `cancel(input)` performs a best-effort local process cancel.
- `ExecutorSessionMetadata` is persisted per adapter under `.specrail-data/sessions/`.

Core execution state in `packages/core/src/domain/types.ts` stores:

- `Execution.backend`
- `Execution.profile`
- `Execution.sessionRef`
- command metadata with optional `resumeSessionRef`
- run lifecycle status and event-derived summaries

`resumeRun()` resumes the existing run's backend session. `forkRun()` creates a new linked run and chooses either provider-native fork or context-copy fork based on backend capability and requested mode.

## Backend session findings

### Codex CLI backend (`codex`)

Current adapter: `packages/adapters/src/providers/codex-adapter.stub.ts`

Despite the historical filename, the adapter is process-backed:

- spawn command:

```bash
codex exec \
  --json \
  --output-last-message .specrail-data/sessions/<sessionRef>.last-message.txt \
  --skip-git-repo-check \
  [--profile <profile>] \
  '<prompt>'
```

- resume command:

```bash
codex exec resume \
  --json \
  --output-last-message .specrail-data/sessions/<sessionRef>.last-message.txt \
  --skip-git-repo-check \
  <provider-session-id-or-sessionRef> \
  '<prompt>'
```

Session metadata:

```text
.specrail-data/sessions/
  <sessionRef>.json
  <sessionRef>.events.jsonl
  <sessionRef>.last-message.txt
```

Important behavior:

- SpecRail `sessionRef` is currently `<runId>-codex`.
- Codex emits JSONL events; the adapter extracts `session_id`, `sessionId`, `thread_id`, `threadId`, `conversation_id`, `conversationId`, or `id` as the provider session identifier.
- The adapter persists that value as `codexSessionId`, `providerSessionId`, and `resumeSessionRef`.
- `codex exec resume` can resume by explicit session id. The CLI also supports `--last` and `--all`, but SpecRail should avoid those ambiguous modes and use the persisted provider session id.
- `--ephemeral` disables persistence and should not be used by SpecRail-managed sessions.

Session-management implications:

- Continuing a Codex session should use persisted `providerSessionId` when available, falling back to `codexSessionId` or SpecRail `sessionRef` only as a degraded path.
- Starting a fresh Codex session should call `spawn()` with a new SpecRail run/sessionRef; it should not pass a previous provider session id.
- Forking is not a native adapter concept today. A fork can be modeled as a new run with a `parentSessionRef` plus prompt context copied from the source run/report, but it will not be a provider-level fork unless Codex exposes one.

### Claude Code backend (`claude_code`)

Current adapter: `packages/adapters/src/providers/claude-code-adapter.ts`

Spawn command:

```bash
claude \
  --permission-mode bypassPermissions \
  --print \
  --verbose \
  --output-format stream-json \
  [--model <profile>] \
  --session-id <derived-uuid-from-sessionRef> \
  '<prompt>'
```

Resume command:

```bash
claude \
  --permission-mode bypassPermissions \
  --print \
  --verbose \
  --output-format stream-json \
  --resume <provider-session-id-or-resumeSessionRef> \
  [--model <profile>] \
  '<prompt>'
```

Session metadata:

```text
.specrail-data/sessions/
  <sessionRef>.json
  <sessionRef>.events.jsonl
  <sessionRef>.claude-stream.jsonl
```

Important behavior:

- SpecRail `sessionRef` is currently `<runId>-claude`.
- Spawn passes a deterministic UUID through `--session-id` so the run is addressable before Claude emits runtime metadata.
- The adapter captures Claude `stream-json` stdout to `.claude-stream.jsonl` and promotes selected events.
- It persists Claude's `session_id` as `providerSessionId` and `resumeSessionRef`.
- Claude Code CLI supports `--resume <session-id>`, `--continue`, and `--fork-session` when resuming.
- SpecRail currently uses `--resume`; it does not expose `--fork-session`.

Session-management implications:

- Continuing a Claude session should prefer `providerSessionId`, then `resumeSessionRef`, then local `sessionRef` as a degraded path.
- Starting fresh should pass a new deterministic `--session-id` from the new run/sessionRef.
- Forking can become provider-native for Claude Code by adding `--fork-session` to a new adapter method or option. The new SpecRail run should record both `parentSessionRef` and the new provider session id.

### ACP edge adapter

`apps/acp-server` maps external ACP sessions onto SpecRail runs. It is not the internal execution backend for Codex or Claude Code.

Implication: session management should be implemented in the SpecRail execution/session model first, then projected through ACP metadata/events where useful. ACP should not replace the process-backed adapters.

## Target session operations

SpecRail should explicitly support these operator intents:

1. **Continue same run**
   - Existing behavior: append a prompt to the current run's provider session.
   - API shape: `POST /runs/:runId/resume` remains valid.
   - Metadata: same `Execution.id`, same `sessionRef`, updated command and events.

2. **Start fresh from track**
   - Start a new provider session for the track using current approved spec/plan/tasks context.
   - API shape: existing `POST /runs` with `trackId`, `backend`, `profile`, `prompt`.
   - Metadata: new `Execution.id`, new `sessionRef`, no parent session.

3. **Fork from an existing run/session**
   - Create a new run linked to a source run/session, preserving traceability but not mutating the source run.
   - API shape proposal: `POST /runs/:runId/fork`.
   - Request fields: `prompt`, optional `backend`, `profile`, `mode`.
   - Metadata: new `Execution.id`, new `sessionRef`, `parentExecutionId`, `parentSessionRef`, source run summary/report link.
   - Provider behavior:
     - Claude Code: use `--resume <source-provider-session-id> --fork-session` when `mode=provider_fork`.
     - Codex: create a new `codex exec` session seeded with source context when `mode=context_copy`; avoid ambiguous `--last`.

4. **Resume a previous session into a new run**
   - Create a new run that resumes a previous provider conversation, keeping the old run immutable.
   - API shape proposal: `POST /runs/:runId/continue-as-new` or `POST /sessions/:sessionRef/resume-runs`.
   - This is riskier because one provider conversation may now map to multiple SpecRail executions. Prefer fork/context-copy unless the operator explicitly needs provider-level continuity.

## Data model plan

Add a first-class execution session lineage model without replacing current fields:

```ts
interface ExecutionSessionLink {
  sessionRef: string;
  backend: string;
  providerSessionId?: string;
  parentSessionRef?: string;
  parentExecutionId?: string;
  continuityMode: "fresh" | "resume_same_run" | "provider_resume" | "provider_fork" | "context_copy";
  createdFromRunId?: string;
  createdFromEventId?: string;
}
```

Practical MVP fields can live directly on `Execution` and `ExecutorSessionMetadata` first:

- `parentExecutionId?: string`
- `parentSessionRef?: string` (already present in `ExecutorSessionMetadata`, not used yet)
- `continuityMode?: ...`
- `sourceRunId?: string`
- `sourceProviderSessionId?: string`

Persistence requirement:

- Existing `.specrail-data/sessions/<sessionRef>.json` stays the adapter-local source of truth for provider ids.
- Execution repository records enough lineage to render UI/API history even if adapter metadata is unavailable.

## API and UI plan

### API

Add endpoints after the model is in place:

- `GET /runs/:runId/session`
  - returns execution session metadata, provider ids, capabilities, and lineage.
- `POST /runs/:runId/fork`
  - creates a new run from a source run with `continuityMode` defaulting to the safest supported mode.
- optional later: `POST /sessions/:sessionRef/resume-runs`
  - explicitly resumes a provider session into a new run.

Adapter capability extension:

```ts
interface AdapterCapabilities {
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
  supportsApprovalBroker: boolean;
  supportsProviderFork?: boolean;
  supportsContextCopyFork?: boolean;
}
```

Adapter execution extension:

```ts
interface ForkExecutionInput {
  sourceSessionRef: string;
  executionId: string;
  prompt: string;
  workspacePath: string;
  profile: string;
  mode: "provider_fork" | "context_copy";
}
```

### Hosted operator UI

Expose three clearly separated actions:

- `Resume this run` — current behavior.
- `Start fresh run for this track` — current `POST /runs` behavior.
- `Fork from this run` — new endpoint, with a visible source run/session badge.

### Terminal client

Add action labels that make session continuity explicit:

- `r`: resume selected run
- `n`: new run from selected track
- future `f`: fork selected run into a new run

The UI should display:

- backend/profile
- `sessionRef`
- provider session id when known
- parent run/session when present
- continuity mode

## Implementation phases

### Phase 1 — document and expose current session facts

- Add session management documentation and issue plan.
- Add `GET /runs/:runId/session` returning current metadata and adapter capabilities.
- Render session facts in hosted UI and terminal detail views.
- Tests: core service session metadata lookup, API route, hosted/terminal selectors.

### Phase 2 — safe fresh-vs-resume controls

- Make operator controls explicit: resume current run vs new run from track.
- Ensure API responses include enough command metadata to audit whether a call resumed or spawned fresh.
- Tests: existing resume remains same sessionRef; new track run always gets new sessionRef.

### Phase 3 — fork runs

- Add `POST /runs/:runId/fork`.
- Claude Code: support provider-native fork with `--resume <providerSessionId> --fork-session`.
- Codex: support context-copy fork by generating a prompt from the source run report/event summary and starting a fresh `codex exec` session.
- Persist `parentExecutionId`, `parentSessionRef`, and `continuityMode`.
- Tests: fork creates a new execution, keeps source run immutable, records lineage, and chooses backend-specific strategy.

### Phase 4 — provider-session resume into new run, if still needed

- Add explicit advanced API/UI path for mapping one provider conversation into a new SpecRail run.
- Require clear operator confirmation because two SpecRail runs can then point at one provider conversation lineage.
- Add conflict/traceability safeguards in reports and event summaries.

## Open questions

- Should cross-backend forks be allowed, or should fork always preserve the source backend by default?
- Should context-copy forks include full event history, completed report, latest artifacts, or only a compact run summary?
- Do we need a separate `sessions` repository, or are execution fields plus adapter metadata enough for the first implementation?
- Should provider-native fork be the default for Claude Code, or should the safer default be context-copy with provider fork as an explicit advanced option?

## Recommendation

Implement Phase 1 and Phase 2 first. They are low risk and clarify existing behavior. Then add `POST /runs/:runId/fork` with Claude provider-native fork and Codex context-copy fork. Avoid provider-session resume into a new run until there is a concrete operator need, because it weakens the one-run-to-one-control-plane-session invariant.
