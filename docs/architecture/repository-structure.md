# Repository Structure Rationale

## Top level

### `apps/`
Application entrypoints.

Current choice:
- `api/` for the service boundary

Why separate from packages:
- apps compose behavior
- packages define reusable logic and contracts

### `packages/`
Reusable internal libraries.

Current packages:
- `core` — domain model and service contracts
- `adapters` — executor-facing adapter interfaces and provider placeholders
- `config` — typed config and path conventions

### `docs/`
Product and architecture documentation.

### `.specrail-template/`
Template files for the control-plane artifact layout used in managed repositories.

### `scripts/`
Bootstrap and maintenance scripts that are not part of the runtime service.

### `tools/`
Small local tools or helper entrypoints.

## Why not a single-package repo?

A single package would be simpler today, but this product has a natural split:
- API transport will change independently of domain rules
- executor adapters will change independently of both
- config/workflow parsing is shared but distinct

The workspace structure keeps those seams visible early without forcing many dependencies yet.

## Why not a heavy Nx/Turborepo setup yet?

That would be premature.

For MVP we only need:
- pnpm workspaces
- TypeScript project references later if needed
- a clean directory contract

This keeps bootstrap friction low while leaving room to grow.
