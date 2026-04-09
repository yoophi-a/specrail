# GitHub speckit + OpenSpec integration plan

## Goal

Define how SpecRail should interoperate with:
- GitHub-native spec/review workflows (referred to here as "speckit-style" flows)
- OpenSpec as a spec schema / exchange layer

The goal is not to make SpecRail replace those systems.
The goal is to position SpecRail as the orchestration layer that can:
- ingest or materialize structured specs
- connect them to tracked work (`Track` / `Run`)
- execute coding-agent runs
- persist state, events, and review-relevant artifacts
- sync back to GitHub and external spec systems in a controlled way

---

## Simple mental model

- **OpenSpec** defines or exchanges the spec itself
- **GitHub speckit-style workflow** manages collaboration around issues, PRs, review, and repository-native artifacts
- **SpecRail** manages execution orchestration, runtime state, and lifecycle tracking for coding-agent work

In short:
- OpenSpec = spec language / interchange
- GitHub = collaboration and merge surface
- SpecRail = execution control plane

---

## Why this integration matters

SpecRail already has an MVP that can:
- create tracks
- materialize `spec.md`, `plan.md`, `tasks.md`
- start/resume/cancel runs
- persist run state and events
- expose JSON and SSE APIs
- reconcile run/track state

What it does **not** yet do is define how these artifacts and states should connect to:
- repository-native GitHub workflows
- external spec schemas or shared spec ecosystems

Without that integration plan, SpecRail risks becoming an isolated execution tool instead of a useful coordination layer.

---

## Role boundaries

### SpecRail should own
- track identity and workflow state
- run lifecycle and execution state
- runtime events and execution observability
- workspace/session metadata
- reconciliation between runtime outcomes and tracked work state

### GitHub should own
- repository source of truth for code
- issue discussion and team-visible task discussion
- pull request review and merge workflows
- repository branch and PR metadata
- collaborator/permission model

### OpenSpec should own
- portable spec structure
- spec interchange format
- compatibility rules for importing/exporting specs between systems
- shared schema evolution for spec content

### Shared / negotiated boundaries
- whether spec artifacts in repo are canonical or mirrored
- how approval state maps between systems
- whether task decomposition is generated in SpecRail, OpenSpec, or repo-local files

---

## Proposed integration architecture

### 1. SpecRail as orchestration layer

SpecRail should remain the system that answers:
- What track is active?
- What run is in progress?
- What did the coding agent do?
- What is the latest execution outcome?

That means SpecRail should not try to become:
- a full GitHub replacement
- a full document/spec authoring suite
- a full VCS abstraction layer

It should instead focus on connecting external spec/workflow inputs to execution.

### 2. GitHub as repo-native collaboration layer

GitHub integration should focus on:
- linking tracks to issues
- linking runs to branches / commits / PRs
- receiving review/approval state
- publishing execution summaries to issues or PRs
- optionally materializing artifacts under a repository directory such as `.specrail/`

### 3. OpenSpec as import/export schema layer

OpenSpec integration should focus on:
- importing structured spec documents into SpecRail tracks
- exporting SpecRail track artifacts into OpenSpec-compatible documents
- preserving stable identifiers between systems where possible
- allowing round-trip updates with conflict detection

---

## Entity mapping

### Core SpecRail entities
- `Project`
- `Track`
- `Execution` / `Run`
- artifact files: `spec.md`, `plan.md`, `tasks.md`
- event logs and session metadata

### Proposed GitHub mapping
- `Project` -> GitHub repository
- `Track` -> GitHub issue (primary mapping), optionally issue + branch namespace
- `Execution` / `Run` -> one coding-agent attempt associated with branch / commit / PR metadata
- `Track.status` / approval fields -> GitHub labels, PR checks, or issue state annotations
- execution summary -> PR comment, issue comment, check-run summary, or status artifact

### Proposed OpenSpec mapping
- `Track` -> one imported/exported spec package
- `spec.md` -> OpenSpec problem / scope / intent section
- `plan.md` -> OpenSpec execution or implementation plan section
- `tasks.md` -> decomposed task list / milestones
- track metadata -> OpenSpec identifiers, provenance, timestamps, sync metadata

---

## Lifecycle mapping

### GitHub-oriented lifecycle
1. Issue created or selected in GitHub
2. SpecRail creates or links a `Track`
3. SpecRail materializes or imports spec artifacts
4. Approval/review signals move `specStatus` and `planStatus`
5. SpecRail starts a `Run`
6. Run creates runtime events and execution summaries
7. Result is published back to GitHub as comment/PR/check metadata
8. Track moves to `review`, `done`, `blocked`, or `failed`

### OpenSpec-oriented lifecycle
1. OpenSpec document imported into SpecRail
2. Track is created with stable external reference
3. SpecRail generates plan/tasks or accepts imported ones
4. Runs execute against the imported spec context
5. Updated artifacts are exported back to OpenSpec form
6. Sync metadata records divergence / conflicts / source-of-truth decisions

---

## File and storage strategy

### Recommended repo-local layout for GitHub integration

```text
.specrail/
  project.yaml
  tracks/
    <trackId>/
      spec.md
      plan.md
      tasks.md
      sync.json
```

### Why this layout
- keeps execution-facing artifacts near the codebase
- gives GitHub PRs something concrete to diff/review
- provides a stable import/export surface for OpenSpec adapters
- separates repo-managed artifacts from API runtime state under `.specrail-data/`

### Split of responsibilities
- `.specrail/` = repo-visible collaboration artifacts
- `.specrail-data/` = runtime state, sessions, local execution history

---

## API and webhook integration points

### Near-term SpecRail API additions
- `POST /integrations/github/link-track`
- `POST /integrations/github/sync-issue`
- `POST /integrations/openspec/import`
- `POST /integrations/openspec/export`
- `GET /tracks/:trackId/integrations`

These should start as internal/admin endpoints before being generalized.

### GitHub webhook candidates
- issue opened / edited / closed
- pull request opened / synchronized / closed
- issue comment created
- pull request review submitted
- check suite / check run completed

### OpenSpec sync hooks
- import from file bundle
- import from API payload
- export to file bundle
- export to API payload

---

## Approval and review mapping

### Current SpecRail approval fields
- `specStatus`
- `planStatus`

### Proposed GitHub mapping options

#### Option A: labels
- `spec:approved`
- `spec:changes-requested`
- `plan:approved`
- `plan:changes-requested`

Pros:
- simple
- visible in issue lists

Cons:
- weak history model
- easy to drift

#### Option B: issue/PR comments with bot parsing
Pros:
- better audit trail
- natural for humans

Cons:
- more parsing complexity

#### Option C: PR checks / check runs
Pros:
- structured and automation-friendly
- good for branch/PR gating

Cons:
- more implementation work

### Recommendation
Start with **labels + structured comments**, then add **check-run integration** later.

---

## Source-of-truth strategy

This is the most important design decision.

### Recommended initial policy
- runtime execution state: **SpecRail source of truth**
- code state: **GitHub repo source of truth**
- portable spec structure: **OpenSpec-compatible document source of truth**
- repo-local artifact visibility: mirrored from SpecRail and exportable back

### Practical first rule
For MVP integration:
- SpecRail owns run/execution history
- repo-local `.specrail/` artifacts are the review surface
- OpenSpec import/export is explicit, not continuously automatic

That avoids hard-to-debug bidirectional sync too early.

---

## Conflict handling

### Expected conflict cases
- GitHub issue title/description diverges from `spec.md`
- repo-local artifact edits diverge from SpecRail state
- OpenSpec import updates a field already changed in SpecRail
- multiple runs propose different task/status outcomes

### Recommended initial policy
- explicit sync direction per operation: `import`, `export`, or `reconcile`
- write sync metadata to `sync.json`
- never auto-merge conflicting spec text in the first version
- surface conflicts for review instead of guessing

---

## Phased implementation roadmap

### Phase 1. Repo-local artifact contract
- formalize `.specrail/` repo-visible artifact layout
- add import/export utilities between runtime artifacts and repo-visible artifacts
- record sync metadata

### Phase 2. GitHub issue / PR linkage
- track <-> issue linking
- execution summary comments on issue/PR
- optional branch / commit / PR association fields on runs

### Phase 3. Approval sync
- map GitHub labels/comments to `specStatus` / `planStatus`
- publish SpecRail state changes back to GitHub
- add simple webhook receiver

### Phase 4. OpenSpec import/export
- [x] define OpenSpec adapter boundary
- [x] add first file-bundle scaffold for import/export of track + `spec.md`/`plan.md`/`tasks.md`
- [x] import OpenSpec package -> create/update track
- [x] export track artifacts -> OpenSpec package via API/service wiring
- [x] add preview/dry-run import flow and first explicit conflict policy (`reject` default, `overwrite` explicit)
- [x] conflict reporting and provenance metadata

### Phase 5. Round-trip and policy hardening
- repeated sync safety
- [x] conflict workflows (`resolve` with selective keep-existing choices for track/artifact fields)
- [x] import history inspection endpoints for track and admin APIs
- source-of-truth policies by field
- better auditability and operator tools

---

## Immediate next implementation candidates

1. Add repo-visible `.specrail/` artifact sync separate from `.specrail-data/`
2. Add track external reference fields for GitHub issue/PR linkage
3. Add execution summary publishing format for issue/PR comments
   - implemented in core as `formatGitHubRunCommentSummary(...)`
   - current payload includes linked issue/PR refs, run outcome, backend/profile/branch/session metadata, and recent event highlights
   - next step is wiring this formatter into a GitHub publishing adapter/upsert flow
4. Add an import/export adapter boundary for OpenSpec-compatible documents
5. Add sync metadata schema (`sync.json`) and conflict markers

---

## Risks

- trying to do bidirectional sync too early will create hidden state drift
- GitHub workflow conventions vary heavily by repo/team
- OpenSpec schema assumptions may change as that ecosystem evolves
- approval semantics may differ between planning-heavy and coding-heavy teams
- branch/PR ownership gets more complicated with multiple agents or multiple runs per track

---

## Decisions still needed

- Should GitHub issue be the required external anchor for a track, or optional?
- Should `.specrail/` artifacts be committed to the target repo by default?
- Should OpenSpec import/export be file-based first, API-based first, or both?
- Which fields are authoritative in SpecRail vs imported/exported systems?
- When a run succeeds, should SpecRail automatically open/update a PR summary?

---

## Recommendation

The safest near-term path is:
1. keep SpecRail as the execution control plane
2. add repo-visible `.specrail/` artifacts as the first GitHub-facing layer
3. treat OpenSpec as an explicit import/export adapter boundary
4. delay full bidirectional sync until source-of-truth and conflict rules are proven

That sequence gives SpecRail practical integration value without turning it into an unreliable sync engine too early.
