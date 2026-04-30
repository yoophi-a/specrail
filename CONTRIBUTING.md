# Contributing to SpecRail

Thanks for helping improve SpecRail. This repository is a spec-driven orchestration service with several interfaces around the same core workflow, so the most useful PRs are small, scoped, and explicit about validation and contract impact.

## Pick the right surface

Before opening an issue or PR, identify the main surface you are changing:

- **Core domain/service**: track, planning, artifact revision, approval, run, channel binding, attachment, and event orchestration in `packages/core`.
- **Persistence layout**: file-backed repositories, JSON/JSONL state, `.specrail` artifacts, sessions, and workspaces.
- **Executor adapters**: Codex, Claude Code, provider metadata, stream normalization, spawn/resume/cancel behavior.
- **HTTP API/SSE**: routes, request validation, response shapes, error contract, and event streaming.
- **ACP server**: ACP session mapping, permission projection, and ACP-facing event updates.
- **Terminal client**: operator shell views, planning workspace, execution controls, and live event following.
- **Telegram adapter**: webhook handling, thin channel bindings, attachment references, and event relay.
- **OpenSpec/GitHub integration**: import/export, provenance, audit history, and run summary publishing.
- **Docs/CI/process**: documentation, GitHub workflows, templates, and repository metadata.

If a change crosses multiple surfaces, split it when practical or clearly explain why it should stay together.

## Open an issue first

Use the GitHub issue forms when possible:

- Bug reports should include affected surface, reproduction steps, expected/actual behavior, contract impact, and validation context.
- Feature or follow-up requests should include target surface, motivation, proposed behavior, contract impact, acceptance criteria, and suggested validation.

If the surface or contract impact is unclear, choose `Unsure` and describe the uncertainty.

## Local setup

```bash
pnpm install
pnpm dev:api
```

Useful local app entry points:

```bash
pnpm dev:acp
pnpm dev:terminal
pnpm dev:telegram
```

The Telegram adapter requires `SPECRAIL_API_BASE_URL`, `TELEGRAM_BOT_TOKEN`, and optionally `TELEGRAM_APP_PORT` / `TELEGRAM_WEBHOOK_PATH`.

## Validation

Run the checks that match your change. For most code PRs, use the full baseline:

```bash
pnpm check
pnpm test
pnpm build
```

For docs-only or repository metadata-only changes, `pnpm check` is usually enough unless the change affects workflow behavior or generated artifacts.

Claude Code smoke coverage is intentionally opt-in and provider-dependent. Only run it when your environment has the required Claude credentials and the change touches Claude Code behavior:

```bash
SPECRAIL_RUN_CLAUDE_SMOKE=1 pnpm test:claude-smoke
```

The GitHub Actions Claude smoke workflow is also gated by `SPECRAIL_ENABLE_CLAUDE_SMOKE=1` so default validation stays stable without provider credentials.

## Pull requests

Use the pull request template and include:

- a concise summary
- linked issues, preferably with `Closes #...`
- the surfaces touched
- API/event/persistence contract impact, or explicit confirmation that there is none
- validation commands and results

Standard PR validation should match the baseline workflow when possible:

```bash
pnpm check
pnpm test
pnpm build
```

## Contract-impact checklist

Call out contract changes explicitly when touching:

- HTTP route paths, query params, request bodies, response bodies, or status/error semantics
- `ExecutionEvent` type/subtype/payload mapping
- file-backed state layout or artifact materialization paths
- ACP `_meta.specrail` payloads or permission request shapes
- terminal or Telegram behavior that operators/users depend on

When contract changes are intentional, update tests and the relevant docs in the same PR.

## Documentation map

Start with these docs when changing related areas:

- `README.md` — current MVP, API summary, and operator entry points
- `docs/architecture/mvp-architecture.md` — system slices, API coverage, data model, and persistence layout
- `docs/acp-server-edge-adapter.md` — ACP boundary, session/event mapping, and limitations
- `docs/claude-code-operations.md` — Claude Code setup, smoke tests, and operational guidance
- `docs/terminal-client.md` — terminal client behavior
- `docs/domain-entities.md` — domain entity overview
- `docs/interfaces-and-adapters.md` — adapter boundaries
