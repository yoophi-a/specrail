# Built Runtime Entrypoint Contract

SpecRail currently runs services from a source checkout with `node --import tsx src/index.ts`. Container images need a different contract: they should run built JavaScript without depending on TypeScript source files or `tsx`.

This note defines the target shape before Dockerfiles or publish workflows are added.

## Goals

- Keep source-checkout `start` and `dev` scripts working for systemd and local development.
- Give container images stable Node.js commands that execute built JavaScript.
- Ensure built service code resolves built `@specrail/*` workspace packages, not source `.ts` files.
- Keep service image contents runtime-oriented: built JavaScript, production dependencies, package metadata, runtime assets, and mounted state only.
- Add smoke checks before image builds enter CI.

## Current State

Package exports currently point at source:

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
```

That shape is good for source-checkout execution but unsafe for built-only image runtimes. A built service importing `@specrail/core`, `@specrail/config`, or `@specrail/adapters` can still resolve to `.ts` source when Node reads package exports.

Service builds also do not yet define a stable built command such as `node dist/index.js`. Depending on TypeScript path-mapped workspace dependencies, emitted files can include workspace-relative paths such as `dist/apps/api/src/index.js`.

## Target Contract

Each long-running service package should expose two explicit runtime modes:

| Mode | Use case | Command shape |
| --- | --- | --- |
| Source checkout | local dev and systemd templates | `node --import tsx src/index.ts` |
| Built runtime | Docker images and publish smoke checks | package `start:built` scripts with `--conditions=specrail-built` |

The preferred target is a flat service output:

```text
apps/api/dist/index.js
apps/github/dist/index.js
apps/telegram/dist/index.js
```

The repository currently keeps a workspace-relative output path for the API service, so Dockerfiles and checks must use declared `start:built` scripts instead of inferring paths.

## Package Exports

Workspace package exports support built runtime resolution through a dedicated `specrail-built` condition. Source-checkout execution keeps the default source export so local `tsx` commands and tests do not require prebuilt `dist` files.

Built service smoke checks prove that Node can import built service entrypoints under the `specrail-built` condition without `tsx`.

## Build Output Expectations

- Service builds must not emit `src/**/__tests__` files.
- Built service commands must not require repository-local `.env` files, transcripts, `.specrail-data`, or test fixtures.
- API images need writable mounted paths for `SPECRAIL_DATA_DIR`, `SPECRAIL_REPO_ARTIFACT_DIR`, and execution workspaces.
- GitHub images need durable relay storage when terminal outcome comments are enabled.
- Telegram images should keep all canonical state in the API-owned storage.

## Validation Before Dockerfiles

Before adding image builds, run the built entrypoint smoke check:

1. Runs `pnpm build`.
2. Runs `pnpm check:built-entrypoints`.
3. Runs `pnpm check:built-health`.
4. Fails if Node needs `tsx`, cannot import a built service entrypoint under the `specrail-built` condition, or cannot serve `GET /healthz` from the built service process.

`check:built-entrypoints` is an import-level guard. `check:built-health` starts API, GitHub, and Telegram through their `start:built` scripts on allocated local ports and confirms `GET /healthz` returns `{ ok: true, service: "<service-id>" }`.

## Implementation Sequence

1. Update the container image publishing contract with any final command changes.
2. Add Dockerfiles or a generated image build script.
3. Add a publish workflow that runs only after validation and smoke checks pass.
