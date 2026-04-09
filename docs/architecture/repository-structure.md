# Repository Structure Rationale

## Top level

### `apps/`
Application entrypoints.

Current app:
- `api/` for the Node HTTP service boundary

What it currently contains:
- route handlers for tracks and runs
- SSE streaming implementation
- dependency wiring for file-backed repositories, artifact writers, and the Codex adapter

### `packages/`
Reusable internal libraries.

Current packages:
- `core` — domain model, artifact renderers, file repositories, event store, service orchestration
- `adapters` — executor contracts plus the Codex MVP adapter
- `config` — config loading, artifact path helpers, and artifact materialization

### `docs/`
Product and architecture documentation.

Current docs here should describe the executable MVP, not just the original scaffold intent.

### `.specrail-template/`
Seed markdown templates for project-level artifact files such as:
- `index.md`
- `workflow.md`
- `tracks.md`

Track-specific files are then materialized by code in `packages/config`.

### `scripts/`
Bootstrap and maintenance scripts that are not part of the runtime service.

### `tools/`
Small local tools or helper entrypoints.

## Why not a single-package repo?

A single package would still be possible, but the current implementation already has stable seams:
- API transport and streaming behavior in `apps/api`
- workflow/domain logic in `packages/core`
- executor-specific process/session behavior in `packages/adapters`
- path/config/artifact conventions in `packages/config`

That separation is now justified by real code, not just anticipated growth.

## Why not a heavy Nx/Turborepo setup yet?

Still premature.

The repo currently only needs:
- pnpm workspaces
- TypeScript package builds/checks
- lightweight package boundaries

This keeps the MVP easy to inspect while leaving room for stronger build orchestration later if package count or CI complexity grows.

## Current structure snapshot

```text
specrail/
  apps/
    api/
      src/
        __tests__/
        index.ts
  packages/
    adapters/
      src/
        __tests__/
        interfaces/
        providers/
    config/
      src/
        __tests__/
        artifacts.ts
        index.ts
    core/
      src/
        domain/
        services/
        index.ts
  docs/
    architecture/
  .specrail-template/
```
