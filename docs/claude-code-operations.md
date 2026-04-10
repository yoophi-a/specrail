# Claude Code operations

This document is the operator guide for SpecRail's `claude_code` backend.

## What SpecRail actually runs

SpecRail launches Claude Code as a local child process.

Spawn mode:

```bash
claude \
  --permission-mode bypassPermissions \
  --print \
  --verbose \
  --output-format stream-json \
  [--model <profile>] \
  --session-id <derived-session-id> \
  '<prompt>'
```

Resume mode:

```bash
claude \
  --permission-mode bypassPermissions \
  --print \
  --verbose \
  --output-format stream-json \
  --resume <provider-session-id> \
  [--model <profile>] \
  '<prompt>'
```

Important expectations:
- SpecRail uses `--print`, not an interactive TTY flow.
- structured runtime data is discovered from Claude's `stream-json` stdout.
- the process must be able to run in the allocated workspace directory.
- `profile` is passed through as `--model` unless it is `default`.

## Setup and environment assumptions

Minimum operator checklist:
- `claude` CLI is installed and available on `PATH`
- the host environment is already authenticated for Claude Code
- the workspace path exists and is writable
- the Claude Code account/runtime can access any files the prompt expects

Recommended preflight checks:

```bash
which claude
claude --version
claude --permission-mode bypassPermissions --print --output-format stream-json 'Reply with ok'
```

If the last command fails, SpecRail will also fail because it depends on the same non-interactive invocation mode.

For code-level readiness probes, the adapter also exports `checkClaudeCodeReadiness()`.
Today it intentionally stays lightweight and verifies that `claude --version` succeeds for the current host user.
Use it when you need a fast operator-facing readiness signal without starting a full run.

## Session and metadata model

SpecRail keeps two identifiers around:
- `sessionRef`: SpecRail's stable run-local reference, usually `<runId>-claude`
- `providerSessionId`: the real Claude session id observed from streamed JSON events

On initial spawn, SpecRail also passes a deterministic derived UUID via `--session-id` so the run is addressable before Claude emits a provider session id.

Persisted session metadata lives under:

```text
.specrail-data/sessions/
  <sessionRef>.json
  <sessionRef>.events.jsonl
  <sessionRef>.claude-stream.jsonl
```

Meaning:
- `*.json`: latest normalized session metadata
- `*.events.jsonl`: normalized SpecRail events generated from runtime activity
- `*.claude-stream.jsonl`: raw stdout captured from Claude's `stream-json` output

## Operational behavior

### Start
- SpecRail writes initial session metadata immediately.
- the run is marked `running` before the first Claude event arrives.
- when Claude emits structured JSON lines, SpecRail updates:
  - `providerSessionId`
  - `providerInvocationId`
  - `resumeSessionRef`
  - `providerMetadata.model`
  - last observed event type/subtype

### Resume
- SpecRail prefers the persisted `providerSessionId` for `--resume`.
- if Claude never emitted a real provider session id, SpecRail falls back to the previously persisted reference.
- the SpecRail `sessionRef` stays stable across resume attempts even if Claude rotates per-run UUIDs.

### Cancel
- SpecRail cancellation is local-process-first: it sends `SIGTERM` to the latest tracked PID.
- SpecRail always marks the run `cancelled` in its own state, even if Claude has already exited or ignores the signal.
- this is a local control-plane cancel, not a remote provider-side kill contract.
- cancellation metadata now records `cancelRequestedAt`, `cancelSignal`, `cancelSignalDelivered`, and `cancelFailureReason` when SpecRail cannot positively verify signal delivery.
- if `cancelFailureReason` is populated, treat it as an operator follow-up hint, for example checking whether the Claude child process is still running.

### Completion and failure
- exit code `0` becomes `completed`.
- non-zero exit becomes `failed`.
- failed exits now persist an explicit `failureMessage` like `Claude Code exited with code 17` when Claude did not provide a richer process error.
- Claude `result` envelopes with `is_error: true` now also promote a more actionable `failureMessage`, for example `Claude Code reported an error result: Permission denied`.

## Known limitations

These are current, expected limitations of the MVP:

1. `resume` depends on the provider session id appearing in stdout.
   - if Claude never emits `session_id`, later resumes may only have the synthetic/local reference to work from.

2. `cancel` is best-effort and local.
   - SpecRail kills the child process it started.
   - it does not currently verify remote provider-side cancellation semantics.

3. event coverage is selective.
   - SpecRail promotes high-value Claude `stream-json` events into shared execution event subtypes.
   - examples: `claude_init`, `claude_assistant_text`, `claude_tool_call`, `claude_tool_result`, `claude_permission_denial`, `claude_result_*`.
   - low-value transport noise still stays in raw transcript files instead of flooding shared surfaces.

4. `providerInvocationId` is not a durable thread id.
   - it tracks the latest observed Claude event UUID/run identifier.
   - it may change across outputs or resumes.

5. the raw transcript file is stdout-oriented.
   - `*.claude-stream.jsonl` captures Claude stdout stream-json output.
   - stderr is normalized into SpecRail events, but not mirrored into that raw stdout transcript file.

6. no approval broker exists yet.
   - SpecRail advertises the capability shape, but there is not yet a separate approval workflow layered on top of Claude Code.

## Recovery guide

### Claude process failed immediately
Check:
- `which claude`
- auth/session state for the host user
- workspace permissions
- the run's `failureMessage`
- `.specrail-data/sessions/<sessionRef>.claude-stream.jsonl`
- `.specrail-data/sessions/<sessionRef>.events.jsonl`

### Resume does not pick up the prior conversation
Check `providerSessionId` and `resumeSessionRef` in `.specrail-data/sessions/<sessionRef>.json`.
If they were never populated from Claude stdout, the original session was not fully discovered by SpecRail.

### SSE/UI looked quiet even though Claude was working
SpecRail only emits normalized events after stdout/stderr chunks or process lifecycle changes arrive.
This means:
- some long tool activity may appear silent until Claude emits another chunk
- the raw stdout file is the best source of truth for exact stream-json payloads

### Cancelled runs still show late process output
A late process exit can still arrive after SpecRail marks the run cancelled.
SpecRail keeps the terminal state as `cancelled`, but you may still see previously buffered stdout/stderr events written before exit handling completes.

## Smoke test workflow

Use this when validating a deployment or local machine:

1. Verify Claude CLI directly:

```bash
claude --permission-mode bypassPermissions --print --output-format stream-json 'Reply with the word ok'
```

2. Start a SpecRail run with `backend: "claude_code"`.
3. Confirm the run metadata captures:
   - `backend: "claude_code"`
   - `sessionRef`
   - `providerSessionId` after first structured event
4. Confirm `GET /runs/:runId/events` shows:
   - `Run started`
   - `Spawned Claude Code session ...`
   - at least one promoted Claude event such as `Initialized Claude Code session ...`, `Claude requested tool ...`, or a terminal lifecycle event
5. Resume the same run and verify `--resume` behavior through persisted metadata.
6. Cancel a separate test run and verify the run transitions to `cancelled`.
   - inspect `.specrail-data/sessions/<sessionRef>.json` and confirm the cancellation verification fields look sensible for that machine.

## Source of truth in code

- `packages/adapters/src/providers/claude-code-adapter.ts`
- `packages/adapters/src/providers/claude-code-contract.ts`
- `packages/adapters/src/__tests__/claude-code-adapter.test.ts`
- `packages/adapters/src/__tests__/claude-code-contract.test.ts`
