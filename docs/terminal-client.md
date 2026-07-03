# Terminal client

`apps/terminal` is the first operator-facing terminal surface for SpecRail.

## Goals of the current skeleton

- prove workspace/package wiring for a terminal app
- establish environment/config loading for API base URL and refresh cadence
- define a simple app shell with screen-oriented rendering
- keep the first cut dependency-light so it is easy to evolve

## Runtime model

- configuration comes from `@specrail/config`
- `SpecRailTerminalApiClient` loads small track/run summaries from the API
- `runTerminalApp()` renders a shell and listens for keypress navigation
- when stdin is not a TTY, the app renders once and exits, which is useful for smoke runs
- `report <runId>` is a non-interactive command that writes `GET /runs/:runId/report.md` Markdown to stdout using the configured `SPECRAIL_API_BASE_URL`

## Current screens

- `home`: overview counts and last fetch time
- `tracks`: recent track summary list plus planning-session, revision, and approval context for the selected track
- `runs`: recent run summary list
- `settings`: resolved config values and extension notes

## Current operator flow

The runs screen now does more than snapshot inspection:

- filters the visible runs between all, active, and terminal states
- keeps the selected run detail panel in sync with periodic refreshes
- opens an SSE stream against `/runs/:id/events/stream` for the selected run
- caches the most recent run events in-memory for a tail-style activity view
- toggles a focused event detail block with `d` and moves across cached events with `p` / `n`, including metadata, provider-aware highlights for known payloads, and a bounded pretty JSON payload preview
- surfaces provider `stdout`/`stderr` stream labels and bounded text previews when run events include stream payloads
- adds compact structured details for tool calls, tool results, and runtime approval events when payload fields are available
- lets operators pause and resume the live tail without changing selection
- deduplicates replayed events after reconnect because the API replays prior history on each SSE connection
- retries dropped streams with bounded backoff for non-terminal runs
- stops reconnecting once the selected run reaches `completed`, `failed`, or `cancelled`

The run detail pane also highlights:

- event count and last-event timestamp
- the latest event summary
- failure focus, including exit code or signal when present in event payloads
- planning-context staleness and last planning-context update timestamp
- operator actions for starting runs from tracks, resuming terminal runs, cancelling active runs, and guarded workspace cleanup
- folder-session discovery in the start composer: operators can edit a folder path, call `GET /runs?workspacePath=...`, preview the selected run with `GET /runs/:runId/session-preview`, then resume, fork, or start fresh using the existing run lifecycle endpoints
- contextual keyboard help for the active screen or currently open multi-step composer
- startup defaults for initial project scope and run filter, plus optional local persistence for project scope, run filter, refresh interval, live-tail pause, and event-detail visibility changes

## Planning and approval workflow support

The tracks screen now also acts as the first planning-workspace inspector:

- loads planning sessions for the selected track
- lets operators open a planning-session creation composer with `N`, cycle the initial status with `y`, submit with Enter, cancel with Esc, cycle the selected session status with `T`, or open a planning-session chooser with `M`, move with `j/k`, submit with Enter, or cancel with Esc
- shows the selected planning-session position, an overflow hint for hidden sessions, and latest messages from the selected planning session
- has typed API-client support for appending planning messages through the existing planning-session message endpoint
- lets operators open a lightweight planning-message composer with `m`, apply reusable handoff/question/decision/test-note templates with `Ctrl+T`, edit a multiline body with `Ctrl+N`, open `$EDITOR` for longer notes with `Ctrl+E`, cycle author/kind/related artifact, and append handoff notes without leaving the terminal
- can load project/team-specific planning-message templates from `SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH`; the JSON file must be a non-empty array of `{ "name", "kind", "relatedArtifact", "body" }` objects, where `kind` is `message`, `question`, `decision`, or `note`, and `relatedArtifact` is `none`, `spec`, `plan`, or `tasks`; `kind` and `relatedArtifact` values are trimmed and parsed case-insensitively
- summarizes revision focus and approval-request status for `spec`, `plan`, and `tasks`
- compares the selected revision against the current artifact with changed-line counts and a short +/- preview, with `u` to toggle an expanded all-changed-lines view and `U` to export a patch-like diff file; `SPECRAIL_TERMINAL_DIFF_EXPORT_DIR` can route exports to a fixed directory instead of the process working directory, and terminal exports append metadata to `specrail-revision-diff-exports.jsonl`
- lets operators switch artifact focus with `h` / `l`
- lets operators cycle revision history for the focused artifact with `[` / `]`
- highlights pending approval requests and whether the approved execution context is stale or blocked by newer planning changes
- lets operators approve or reject the next pending approval request with `a` / `x`
- opens a lightweight revision proposal composer with `v`

## Non-interactive report export

Use the terminal entrypoint as a thin CLI wrapper when an operator wants the derived run report in a shell pipeline or explicit file:

```sh
pnpm --filter @specrail/terminal exec tsx src/index.ts --help
SPECRAIL_API_BASE_URL=http://127.0.0.1:4000 pnpm --filter @specrail/terminal exec tsx src/index.ts report <runId> > run-report.md
SPECRAIL_API_BASE_URL=http://127.0.0.1:4000 pnpm --filter @specrail/terminal exec tsx src/index.ts report <runId> --output artifacts/run-report.md
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-exports
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-exports --limit 5
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-exports --json --limit 5
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-exports --track <trackId> --artifact plan --limit 5
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-export 1
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-export 1 --track <trackId> --artifact plan
SPECRAIL_TERMINAL_DIFF_EXPORT_DIR=artifacts/diffs pnpm --filter @specrail/terminal exec tsx src/index.ts diff-export 1 --output artifacts/selected.patch
SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH=.specrail-terminal/message-templates.json pnpm --filter @specrail/terminal exec tsx src/index.ts message-templates
SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH=.specrail-terminal/message-templates.json pnpm --filter @specrail/terminal exec tsx src/index.ts message-templates --json
pnpm --filter @specrail/terminal exec tsx src/index.ts message-templates --output .specrail-terminal/message-templates.json
```

Use `help`, `--help`, or `-h` to print the available non-interactive commands. Without `--output`, the report command streams the read-only API response to stdout so callers can redirect, copy, or attach the Markdown as needed. With `--output`, parent directories are created automatically and the report is written to that file. `diff-exports` reads `specrail-revision-diff-exports.jsonl` from `SPECRAIL_TERMINAL_DIFF_EXPORT_DIR` or the process working directory and prints newest-first results as either a tab-separated list or JSON for automation; use `--limit <n>` to keep output compact, `--track <trackId>` to narrow by track, and `--artifact <spec|plan|tasks>` to narrow by artifact. `diff-export <index>` uses the same newest-first manifest ordering and prints the selected patch content, with `1` selecting the newest export. The detail command accepts the same `--track` and `--artifact` filters, applying them before resolving the index so it can select from a filtered `diff-exports` list. With `--output <file>` or `-o <file>`, it writes the selected patch to disk and creates parent directories automatically. `message-templates` loads the same built-in or `SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH` templates used by the interactive composer and prints either tab-separated metadata or JSON. With `--output <file>`, it writes the loaded templates as pretty JSON and creates parent directories automatically, which is useful for bootstrapping a custom template file from the built-ins.

This is intentionally still lightweight:

- revision proposal authoring is review-oriented for now, not a full text editor
- proposal authoring uses a single-buffer content field plus optional summary and author selector
- approval decisions use a minimal `decidedBy: "terminal"` payload
- planning message authoring is intentionally lightweight: a body buffer with `Ctrl+N` newline insertion and cycling author/kind/artifact selectors
- the client optimizes for browsing and unblocking runs without dropping to raw API calls
- start-run composition defaults the folder path to the selected project's local repository path when available, then falls back to the terminal process working directory; use `Tab` to switch between prompt and folder path, `Ctrl+F` to load related sessions, `[` / `]` to change the selected folder session, `Ctrl+R` to resume it, and `Ctrl+K` to fork it. The selected session preview includes workspace and report path context when available. Pressing `Enter` from the start composer still starts a fresh run.

## Follow-up direction

Good next steps after the current planning/run-operation baseline:

- make terminal planning-message authoring more ergonomic for longer notes, such as adding paste-mode controls or template import/export helpers
- add richer revision diff/compare views before approval, such as side-by-side paging or manifest browsing inside the terminal
- consider richer terminal controls for planning-session metadata if operators need fields beyond status
