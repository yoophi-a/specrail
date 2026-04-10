# OpenSpec vs Speckit, and practical Speckit support inside SpecRail

## Purpose

This note compares OpenSpec and Speckit from a SpecRail integration perspective, then proposes concrete ways SpecRail can support Speckit without losing its current control-plane role.

The working conclusion is:

- OpenSpec is closer to a portable spec/change-artifact model with customizable artifact schemas and a fluid workflow.
- Speckit is closer to a repository-local feature workflow toolkit with stronger phase structure, richer generated planning artifacts, and agent-command conventions.
- SpecRail should not try to become either tool.
- SpecRail should support both by acting as an orchestration layer that can ingest, materialize, reconcile, and publish their artifacts.

## Scope of evidence

Primary sources used here:

### OpenSpec
- Repo: https://github.com/Fission-AI/OpenSpec
- README: https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/README.md
- Concepts: https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/concepts.md
- OPSX workflow: https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/opsx.md
- Workflows: https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/docs/workflows.md
- Built-in schema: https://raw.githubusercontent.com/Fission-AI/OpenSpec/main/schemas/spec-driven/schema.yaml

### Speckit
- Repo: https://github.com/github/spec-kit
- README: https://raw.githubusercontent.com/github/spec-kit/main/README.md
- SDD overview: https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md
- Spec template: https://raw.githubusercontent.com/github/spec-kit/main/templates/spec-template.md
- Plan template: https://raw.githubusercontent.com/github/spec-kit/main/templates/plan-template.md
- Tasks template: https://raw.githubusercontent.com/github/spec-kit/main/templates/tasks-template.md
- Constitution template: https://raw.githubusercontent.com/github/spec-kit/main/templates/constitution-template.md
- Command prompt: specify: https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/specify.md
- Command prompt: plan: https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/plan.md

### Current SpecRail context
- `README.md`
- `packages/adapters/src/interfaces/openspec-adapter.ts`
- `packages/adapters/src/providers/file-openspec-adapter.ts`
- `packages/core/src/domain/types.ts`
- `docs/architecture/github-speckit-openspec-integration-plan.md`

## Current SpecRail baseline

SpecRail already behaves like a file-backed execution control plane.

Current shape, from `README.md` and source:
- Track-centric model: `Track`, `Run`, workflow status, approval status
- First-class artifacts: `spec.md`, `plan.md`, `tasks.md`
- Run lifecycle: start, resume, cancel
- Persisted event history and SSE streaming
- OpenSpec import/export scaffold via `OpenSpecAdapter`
- GitHub comment sync around runs/issues/PRs

Important current constraint:
- SpecRail's current OpenSpec support is not a native OpenSpec schema implementation.
- It is a SpecRail-defined bundle format, exported as `specrail.openspec.bundle` in `packages/adapters/src/interfaces/openspec-adapter.ts` and `file-openspec-adapter.ts`.

That means SpecRail currently supports an OpenSpec-shaped exchange path in name, but not direct compatibility with OpenSpec's actual repository layout and schema system.

## Comparison: OpenSpec vs Speckit

### 1. Primary goal

#### OpenSpec
OpenSpec presents itself as a lightweight, open, customizable spec framework for coding agents. Its README and docs emphasize:
- fluid not rigid
- iterative not waterfall
- easy not complex
- brownfield-first

Its main abstraction is a change package under `openspec/changes/<change>/` plus canonical specs under `openspec/specs/`.

#### Speckit
Speckit presents itself as a toolkit for spec-driven development that turns feature descriptions into structured feature specs, implementation plans, and executable task breakdowns. Its docs emphasize:
- specifications as executable drivers of implementation
- strong feature-directory workflow
- project constitution/governance
- richer planning outputs from `/speckit.plan`
- agent command flows and extension hooks

Its main abstraction is a feature directory under `specs/<feature>/` with plan/design artifacts, plus command-driven generation.

#### Practical distinction
- OpenSpec is more like an extensible spec/change framework.
- Speckit is more like a structured repo workflow kit for feature-spec generation and execution prep.

### 2. Canonical artifacts

#### OpenSpec artifacts
From `docs/concepts.md`, `docs/opsx.md`, and `schemas/spec-driven/schema.yaml`:
- canonical system specs under `openspec/specs/<capability>/spec.md`
- change workspace under `openspec/changes/<change>/`
- common artifacts inside a change:
  - `proposal.md`
  - `design.md`
  - `tasks.md`
  - `specs/...` delta specs
  - optional `.openspec.yaml`
- schema-defined artifact graph, where built-in `spec-driven` uses:
  - `proposal -> specs -> design -> tasks`

Distinctive artifact characteristic:
- OpenSpec separates current truth (`openspec/specs`) from proposed change deltas (`openspec/changes/.../specs`).

#### Speckit artifacts
From `README.md`, `spec-driven.md`, `templates/*.md`, and command templates:
- project constitution, typically created by `/speckit.constitution`
- feature spec directory under `specs/<###-feature-name>/`
- core artifacts:
  - `spec.md`
  - `plan.md`
  - `tasks.md`
- richer planning outputs from `/speckit.plan`:
  - `research.md`
  - `data-model.md`
  - `quickstart.md`
  - `contracts/`
- validation/checklist files under feature-local subdirectories
- metadata in `.specify/feature.json`
- optional extension hooks in `.specify/extensions.yml`

Distinctive artifact characteristic:
- Speckit centers one feature folder with all planning outputs needed to drive implementation.

### 3. Workflow model

#### OpenSpec workflow model
OpenSpec's current OPSX docs explicitly reject rigid phase-locking.

Key traits:
- action-oriented commands, not hard phase gates
- dependencies as enablers, not strict lifecycle state
- change folders can be updated iteratively
- archive merges delta specs back into canonical specs
- schema-driven customization is a first-class concept

In effect:
- OpenSpec is artifact-graph driven and intentionally fluid.

#### Speckit workflow model
Speckit uses a clearer staged workflow:
- constitution
- specify
- plan
- tasks
- implement

Its docs allow iteration, but the toolkit itself strongly encodes a planning funnel. The command prompts and templates show a concrete generation pipeline, explicit preconditions, and command handoffs.

In effect:
- Speckit is workflow-command driven and more phase-shaped.

### 4. Integration surfaces

#### OpenSpec integration surfaces
From README/docs:
- CLI-driven initialization and update
- slash/agent commands (`/opsx:*`)
- customizable schemas and templates
- project config `openspec/config.yaml`
- repository layout as the primary interoperability surface

For SpecRail, the important surface is:
- file-system import/export of repository-local artifacts and schema-shaped change data

#### Speckit integration surfaces
From README and command templates:
- `specify` CLI init/check flow
- agent command prompts (`/speckit.*`, `$speckit-*`)
- repository-local templates and scripts
- `.specify/feature.json` and `.specify/extensions.yml`
- feature folders under `specs/`
- generated planning artifacts under each feature

For SpecRail, the important surfaces are:
- feature directory discovery
- artifact ingestion/materialization
- hook/extension interoperability
- constitution and plan-context preservation

### 5. Overlap

OpenSpec and Speckit overlap in the following ways:
- both are spec-driven development systems for AI-assisted coding
- both rely on repository-local markdown artifacts
- both have `spec`, `design/plan`, and `tasks` concepts
- both expect artifacts to steer implementation
- both treat artifacts as inputs to agent workflows, not just passive docs

This overlap is large enough that SpecRail can support both with a shared internal artifact model.

### 6. Important differences

#### A. Delta specs vs feature folders
- OpenSpec has a canonical spec tree plus change-local deltas.
- Speckit has feature-local spec packages, not a built-in canonical-vs-delta split.

This matters because SpecRail currently models one `Track` with one `spec.md`, `plan.md`, `tasks.md`. That maps more directly to Speckit than to OpenSpec's canonical-plus-delta model.

#### B. Schema system vs template workflow kit
- OpenSpec has an explicit schema concept (`schemas/<name>/schema.yaml`) with artifact dependency graphs.
- Speckit has templates, command prompts, hooks, and presets, but not the same explicit artifact-graph contract.

This makes OpenSpec a better candidate for generic adapter architecture, and Speckit a better candidate for workflow-specific adapter logic.

#### C. Planning richness
- OpenSpec's default built-in schema is comparatively compact: proposal, specs, design, tasks.
- Speckit's planning flow produces richer intermediate planning outputs: constitution, research, data model, contracts, quickstart, checklist.

This means naive Speckit support inside SpecRail will lose important context unless SpecRail expands its artifact model or supports auxiliary artifacts.

#### D. Process rigidity
- OpenSpec intentionally avoids rigid phase gates.
- Speckit is much more opinionated about sequence and command boundaries.

This means SpecRail should not force OpenSpec into a Speckit lifecycle, and should not flatten Speckit so much that its useful workflow structure disappears.

## Recommended positioning for SpecRail

SpecRail should position itself as:
- the orchestration and state layer
- not the authoring framework
- not the template engine
- not the canonical schema owner for external systems

Concretely:
- OpenSpec support should mean native-ish import/export of OpenSpec repository artifacts and change state.
- Speckit support should mean native-ish import/materialization of Speckit feature directories and planning context.
- Internal execution should remain Track/Run based.

## Practical support strategies for Speckit inside SpecRail

## Strategy 1. Add a Speckit adapter, parallel to OpenSpec

### What to build
Add a `SpeckitAdapter` interface in `packages/adapters`, analogous to `OpenSpecAdapter`.

Suggested responsibilities:
- discover a Speckit feature directory
- import feature artifacts into a SpecRail track
- export a SpecRail track back into a Speckit-compatible feature directory
- read/write auxiliary planning artifacts when present

Suggested initial file targets:
- `specs/<feature>/spec.md`
- `specs/<feature>/plan.md`
- `specs/<feature>/tasks.md`
- optional: `research.md`, `data-model.md`, `quickstart.md`, `contracts/**`
- optional: `.specify/feature.json`

### Why this is the right first step
This gives SpecRail a concrete interoperability surface without prematurely redesigning the whole domain model.

### MVP import mapping
- `Track.title` <- feature dir name or heading from `spec.md`
- `Track.description` <- summary extracted from `spec.md`
- `artifacts.spec` <- `spec.md`
- `artifacts.plan` <- `plan.md`
- `artifacts.tasks` <- `tasks.md`
- provenance <- feature path + detected metadata

### MVP export mapping
- write `spec.md`, `plan.md`, `tasks.md`
- optionally emit a `specrail.json` or update `.specify/feature.json` with external track linkage
- preserve unknown files in the feature directory

### Implementation note
This should be a new adapter, not a retrofit into the current `OpenSpecAdapter`, because the artifact shapes and repo layouts are meaningfully different.

## Strategy 2. Expand SpecRail's artifact model beyond the current fixed trio

### Problem
Today SpecRail has first-class handling only for:
- `spec.md`
- `plan.md`
- `tasks.md`

That is enough for OpenSpec's compact default flow and for minimal Speckit support, but not for practical Speckit parity.

### What to build
Introduce auxiliary artifact support in the core domain.

Suggested domain addition:
- keep the core trio as promoted artifacts
- add `supportingArtifacts: Array<{ kind, path, title?, content?, mediaType? }>`

Suggested reserved kinds for Speckit support:
- `constitution`
- `research`
- `data-model`
- `quickstart`
- `contract`
- `checklist`

### Why this matters
Without this, a Speckit import either drops important planning context or stuffs unrelated content into `plan.md`, which is a bad fit.

### Minimal rollout
- phase 1: persist supporting artifact metadata and raw content
- phase 2: add API exposure on `GET /tracks/:trackId`
- phase 3: let execution prompts include selected supporting artifacts

## Strategy 3. Add “artifact profile” support per track

### Problem
SpecRail currently assumes one artifact shape for all tracks.

### What to build
Add a track-level profile field, for example:
- `artifactProfile: "specrail" | "openspec" | "speckit"`

Optional richer variant:
- `artifactProfile: { kind: "openspec" | "speckit" | "custom", version?: string }`

### Behavior
- `specrail`: current native trio behavior
- `openspec`: import/export and UI wording reflect proposal/design/tasks + delta spec model
- `speckit`: feature-dir import/export and richer supporting artifacts are enabled

### Why this matters
This prevents SpecRail from pretending all artifact sets are identical while still keeping one internal Track/Run model.

## Strategy 4. Add Speckit-aware import/export admin flows

### What to build
Mirror the OpenSpec admin flow with Speckit-specific endpoints and CLI wrappers.

Examples:
- `POST /admin/speckit/import`
- `POST /admin/speckit/export`
- `GET /admin/speckit/imports`
- `GET /tracks/:trackId/speckit`

CLI examples:
- `pnpm --filter @specrail/api speckit:import -- --path ./specs/003-user-auth --preview`
- `pnpm --filter @specrail/api speckit:export -- --track-id track_123 --path ./specs/003-user-auth`

### Why
This reuses an existing SpecRail pattern and makes Speckit support operationally symmetrical with current OpenSpec work.

## Strategy 5. Preserve Speckit provenance and local workflow metadata

### What to build
Persist import/export provenance equivalent to current OpenSpec provenance.

Suggested fields:
- source path
- feature directory name
- constitution path if present
- imported artifact list
- missing artifact list
- `.specify/feature.json` payload if present
- import/export timestamps

### Why
Speckit workflows are repository-local and convention-heavy. Debugging support becomes much easier when SpecRail keeps exact provenance.

## Strategy 6. Add execution-context assembly rules for Speckit tracks

### Problem
If SpecRail starts a run from a Speckit-imported track using only `spec.md`, `plan.md`, and `tasks.md`, execution quality may degrade because Speckit workflows expect richer planning context.

### What to build
Add profile-based run context assembly.

For `artifactProfile = "speckit"`, default prompt/input bundle should include:
- `spec.md`
- `plan.md`
- `tasks.md`
- `research.md` if present
- `data-model.md` if present
- `quickstart.md` if present
- `contracts/**` summaries if present
- constitution file if configured/imported

### Why
This gives SpecRail execution parity with the context Speckit usually provides to agents.

## Strategy 7. Support round-trip, but do not try to execute Speckit commands directly at first

### Recommendation
Initial SpecRail support should be artifact-level interoperability, not command emulation.

SpecRail should first support:
- import existing Speckit features
- export track state into Speckit-compatible files
- run agents with Speckit artifact context

SpecRail should avoid, in the first version:
- acting as a `/speckit.*` command host
- evaluating `.specify/extensions.yml` hooks itself
- duplicating Speckit's setup scripts or command runtime

### Why
That keeps the boundary clean:
- Speckit remains the authoring/generation workflow toolkit
- SpecRail remains the orchestration/execution layer

Later, hook-awareness can be added as metadata or optional adapters.

## Strategy 8. Rework current “OpenSpec” support naming

### Problem
Current code uses `OpenSpecAdapter`, but the payload format is actually `specrail.openspec.bundle`, not OpenSpec-native repo layout.

### Recommendation
Rename or clarify the current abstraction to avoid confusion:
- option A: rename current adapter to `TrackBundleAdapter`
- option B: keep it, but add a new `OpenSpecRepositoryAdapter` for native repo layout support

### Why it matters for Speckit
Once SpecRail supports both OpenSpec and Speckit, adapter naming needs to reflect whether the adapter handles:
- native external repo format
- or a SpecRail-owned interchange bundle

Otherwise the architecture will get muddy quickly.

## Suggested implementation roadmap

## Phase 1: Safe MVP
1. Add `SpeckitAdapter` in `packages/adapters`
2. Add import-only support for:
   - `spec.md`
   - `plan.md`
   - `tasks.md`
   - optional supporting artifacts metadata
3. Add provenance persistence for Speckit imports
4. Add admin preview/import endpoints and matching CLI wrappers
5. Add `artifactProfile = "speckit"`

Outcome:
- SpecRail can ingest existing Speckit work and execute runs against it.

## Phase 2: Useful interoperability
1. Add export support back into `specs/<feature>/...`
2. Add supporting artifact persistence/content APIs
3. Add Speckit-aware run context assembly
4. Add track inspection endpoints for imported/exported Speckit state

Outcome:
- SpecRail can round-trip Speckit feature work without losing most useful context.

## Phase 3: Higher-fidelity support
1. Read `.specify/feature.json`
2. Read constitution and extension metadata
3. Add conflict policies for Speckit export/import similar to current OpenSpec flow
4. Add optional mapping from SpecRail approvals/statuses to Speckit workflow checkpoints

Outcome:
- SpecRail can operate as a durable control plane around repo-native Speckit workflows.

## Suggested internal interfaces

## Core domain

Possible additions in `packages/core/src/domain/types.ts`:

```ts
export type ArtifactProfileKind = "specrail" | "openspec" | "speckit";

export interface SupportingArtifact {
  id: string;
  kind:
    | "constitution"
    | "research"
    | "data-model"
    | "quickstart"
    | "contract"
    | "checklist"
    | "other";
  path: string;
  title?: string;
  mediaType?: string;
  content?: string;
}
```

Add on `Track`:

```ts
artifactProfile?: ArtifactProfileKind;
supportingArtifacts?: SupportingArtifact[];
```

## Adapter layer

Possible adapter shape:

```ts
export interface SpeckitImportSource {
  kind: "file";
  path: string; // feature dir, e.g. specs/003-user-auth
}

export interface SpeckitTrackPackage {
  track: Partial<Track>;
  artifacts: {
    spec?: string;
    plan?: string;
    tasks?: string;
  };
  supportingArtifacts: SupportingArtifact[];
  metadata: {
    format: "speckit.feature-dir";
    importedAt?: string;
    featurePath: string;
    featureName: string;
  };
}
```

## Recommended mapping policy

### Speckit -> SpecRail
- `spec.md` -> canonical `artifacts.spec`
- `plan.md` -> canonical `artifacts.plan`
- `tasks.md` -> canonical `artifacts.tasks`
- `research.md` -> supporting artifact `research`
- `data-model.md` -> supporting artifact `data-model`
- `quickstart.md` -> supporting artifact `quickstart`
- `contracts/**` -> supporting artifacts `contract`
- constitution file -> supporting artifact `constitution`

### SpecRail -> Speckit
- always emit the core trio
- emit supporting artifacts only when present
- never delete unknown files by default
- use overwrite/conflict policy explicitly, mirroring current OpenSpec safety posture

## What not to do

- Do not force OpenSpec and Speckit into one adapter interface that assumes the same repo layout.
- Do not treat Speckit's richer planning outputs as disposable noise.
- Do not claim current `specrail.openspec.bundle` export is OpenSpec-native compatibility.
- Do not bind SpecRail's internal workflow state too tightly to external command names.

## Bottom line

The cleanest path is:

1. keep SpecRail as the Track/Run/event control plane
2. support OpenSpec and Speckit through separate repo-aware adapters
3. expand the artifact model to preserve richer external planning context
4. start with import/export + execution-context support, not command emulation

If done this way, SpecRail can support Speckit practically without becoming a fork of Speckit, and can support OpenSpec more honestly without overloading the current bundle-based adapter.
