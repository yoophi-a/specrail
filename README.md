# SpecRail

SpecRail is a spec-driven orchestration service for coding-agent work.

It turns a feature request into durable artifacts and controlled execution:
- create project context and track artifacts
- draft specs and plans before implementation
- launch executions in isolated workspaces
- normalize runtime events from different coding-agent backends
- enforce approval checkpoints
- resume follow-up work with durable state

## Why this repo exists

The research repo captured the architecture thesis. This repo is the implementation-oriented bootstrap for building the actual product.

The initial scaffold intentionally avoids overbuilding product code. It focuses on:
- a practical monorepo layout
- clear domain boundaries
- MVP-oriented docs
- starter TypeScript packages and placeholders

## MVP scope

### Included in this scaffold
- monorepo/workspace structure
- backend API app placeholder
- core domain package placeholder
- adapter package placeholder
- config package placeholder
- architecture and MVP docs
- `.specrail-template/` for repo-local control-plane artifacts

### Not included yet
- full REST API implementation
- real DB integration
- worktree orchestration
- live executor adapters
- streaming event pipeline

## Repository layout

```text
specrail/
  apps/
    api/                  # HTTP API / SSE entrypoint for the service
  packages/
    core/                 # Domain types, state transitions, service interfaces
    adapters/             # Executor adapter contracts and provider-specific adapters
    config/               # Shared config loading, policy parsing, env typing
  docs/
    architecture/         # MVP architecture decisions and domain design
  .specrail-template/     # Repo-local artifact template for managed projects
  scripts/                # Dev scripts and future bootstrap helpers
  tools/                  # Local tooling helpers and utilities
```

## Design choices

### Why a light monorepo
A workspace layout makes sense here because the product naturally separates into:
- interface/API concerns
- domain/state-machine concerns
- executor integration concerns
- shared config/policy concerns

Keeping those split from day 1 should reduce accidental coupling without forcing a heavy build system.

### Why TypeScript first
The research plan recommended TypeScript for v1 because:
- coding-agent ecosystems are already CLI- and Node-heavy
- integration speed matters more than low-level runtime optimization at MVP stage
- JSON/Markdown/JSONL artifact handling is straightforward

## Getting started

```bash
pnpm install
pnpm dev:api
```

At this stage the API app is only a bootstrap placeholder.

## First implementation milestones

1. project + track artifact creation
2. spec/plan approval workflow endpoints
3. single execution bootstrap with local workspace allocation
4. normalized event persistence
5. resumable follow-up execution flow

## Related research

The original research and plan live separately under:
- `../research/agent-orchestrator-docs`

This repo is the practical starting point for building the actual service.
