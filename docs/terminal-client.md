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

## Follow-up direction

Issue `#74` can now build on this skeleton to add:
- list selection state
- detail panes for tracks and runs
- loading and error-state polish per screen
- richer refresh behavior and view models
