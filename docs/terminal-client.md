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
- toggles a focused latest-event detail block with `d`, including metadata, provider-aware highlights for known payloads, and a bounded pretty JSON payload preview
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
- contextual keyboard help for the active screen or currently open multi-step composer
- startup defaults for initial project scope and run filter, plus optional local persistence for project scope, run filter, live-tail pause, and event-detail visibility changes

## Planning and approval workflow support

The tracks screen now also acts as the first planning-workspace inspector:

- loads planning sessions for the selected track
- shows the latest messages from the selected planning session
- summarizes revision focus for `spec`, `plan`, and `tasks`
- lets operators switch artifact focus with `h` / `l`
- lets operators cycle revision history for the focused artifact with `[` / `]`
- highlights pending approval requests and whether the approved execution context is stale or blocked by newer planning changes
- lets operators approve or reject the next pending approval request with `a` / `x`
- opens a lightweight revision proposal composer with `v`

This is intentionally still lightweight:

- revision proposal authoring is review-oriented for now, not a full text editor
- proposal authoring uses a single-buffer content field plus optional summary and author selector
- approval decisions use a minimal `decidedBy: "terminal"` payload
- the client optimizes for browsing and unblocking runs without dropping to raw API calls

## Follow-up direction

Good next steps after the live monitor baseline:
- richer planning interaction beyond the current focused revision selector and lightweight proposal authoring
- richer event detail navigation for selecting older cached events instead of only the latest event
- optional persistence for refresh interval if operators need custom refresh cadence to survive restarts
