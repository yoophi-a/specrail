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
| Built runtime | Docker images and publish smoke checks | `node dist/index.js` or a documented service-specific built path |

The preferred target is a flat service output:

```text
apps/api/dist/index.js
apps/github/dist/index.js
apps/telegram/dist/index.js
```

If the repository keeps workspace-relative output paths instead, every service must declare the exact built command in `package.json` so Dockerfiles and checks do not infer paths.

## Package Exports

Workspace package exports should support built runtime resolution without breaking source-checkout execution. The implementation can choose one of these strategies:

1. Add a dedicated built-runtime script path that runs after package exports point at built `dist` files.
2. Add explicit source conditions for source-checkout commands and use built `import`/`default` conditions for normal Node.js runtime.
3. Keep source exports for local use but generate image-specific package metadata that points at built outputs.

Whichever strategy is chosen, built service smoke checks must prove that Node resolves built `@specrail/*` packages without `tsx`.

## Build Output Expectations

- Service builds must not emit `src/**/__tests__` files.
- Built service commands must not require repository-local `.env` files, transcripts, `.specrail-data`, or test fixtures.
- API images need writable mounted paths for `SPECRAIL_DATA_DIR`, `SPECRAIL_REPO_ARTIFACT_DIR`, and execution workspaces.
- GitHub images need durable relay storage when terminal outcome comments are enabled.
- Telegram images should keep all canonical state in the API-owned storage.

## Validation Before Dockerfiles

Before adding image builds, add a smoke check that:

1. Runs `pnpm build`.
2. Starts each built long-running service command with `PORT=0`-style configuration where supported.
3. Confirms `GET /healthz` returns `{ ok: true, service: "<service-id>" }`.
4. Fails if Node needs `tsx` or resolves workspace imports to `.ts` source.

This smoke check should run before Docker build/publish jobs and can later be reused inside image tests.

## Implementation Sequence

1. Normalize package exports and service built commands while preserving source-checkout scripts.
2. Add built service smoke checks for API, GitHub, and Telegram.
3. Update the container image publishing contract with the concrete built commands.
4. Add Dockerfiles or a generated image build script.
5. Add a publish workflow that runs only after validation and smoke checks pass.
