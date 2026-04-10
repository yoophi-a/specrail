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
- `tracks`: recent track summary list
- `runs`: recent run summary list
- `settings`: resolved config values and extension notes

## Current operator flow

The runs screen now does more than snapshot inspection:

- keeps the selected run detail panel in sync with periodic refreshes
- opens an SSE stream against `/runs/:id/events/stream` for the selected run
- caches the most recent run events in-memory for a tail-style activity view
- deduplicates replayed events after reconnect because the API replays prior history on each SSE connection
- retries dropped streams with bounded backoff for non-terminal runs
- stops reconnecting once the selected run reaches `completed`, `failed`, or `cancelled`

The run detail pane also highlights:

- event count and last-event timestamp
- the latest event summary
- failure focus, including exit code or signal when present in event payloads
- planning-context staleness and last planning-context update timestamp

## Follow-up direction

Good next steps after the live monitor baseline:
- filters for active vs terminal runs
- pausing/resuming the live tail without changing selection
- richer provider-specific event formatting for long stdout/stderr payloads
- operator actions from the terminal surface, such as resume/cancel shortcuts
