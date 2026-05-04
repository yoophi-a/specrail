# SpecRail Documentation

Use this index to find the right reference before changing SpecRail's core service, adapters, APIs, clients, or operator workflows.

## Start here

- [MVP architecture](./architecture/mvp-architecture.md) — current system slices, API coverage, data model, persistence layout, and request/event flows.
- [Domain entities](./domain-entities.md) — domain object overview for projects, tracks, planning, approvals, executions, events, and integrations.
- [Interfaces and adapters](./interfaces-and-adapters.md) — adapter boundaries and how external surfaces connect to the core service.

## Architecture and roadmap

- [Repository structure](./architecture/repository-structure.md) — package and app ownership.
- [MVP roadmap](./architecture/mvp-roadmap.md) — historical MVP milestones and validation focus.
- [Completed run report export](./architecture/completed-run-report-export.md) — explicit derived Markdown export contract for completed run summaries/history.
- [Next steps from 2026-04-09](./architecture/next-steps-2026-04-09.md) — earlier planning notes for follow-up work.
- [Interactive planning layer](./architecture/interactive-planning-layer.md) — planning workflow direction.
- [Telegram bot interface strategy](./architecture/telegram-bot-interface-strategy.md) — Telegram-facing product and integration strategy.
- [GitHub entrypoint architecture slice](./architecture/github-entrypoint-slice.md) — minimal GitHub issue/PR command and webhook design over existing SpecRail APIs.
- [GitHub Speckit/OpenSpec integration plan](./architecture/github-speckit-openspec-integration-plan.md) — integration strategy for GitHub, Speckit, and OpenSpec.

## Execution and adapters

- [ACP server edge adapter](./acp-server-edge-adapter.md) — ACP boundary, session mapping, event projections, permission round-trip, and limitations.
- [Claude Code operations](./claude-code-operations.md) — Claude Code setup, runtime behavior, smoke tests, and operational recovery.
- [Agent invocation analysis](./agent-invocation-analysis.md) — agent invocation behavior and design observations.
- [Agent invocation design notes](./agent-invocation-design-notes.md) — design notes for invocation and execution flows.

## Client surfaces

- [Terminal client](./terminal-client.md) — terminal UI behavior, run following, planning workspace, and controls.
- [GitHub App setup](./github-app-setup.md) — runnable webhook app configuration, command flow, binding semantics, and current limitations.
- [Telegram bot interface strategy](./architecture/telegram-bot-interface-strategy.md) — Telegram-facing product and integration strategy.

## Research

- [ACP fit for SpecRail](./research/acp-fit-for-specrail.md) — research notes on where ACP fits in SpecRail's architecture.

## How to keep docs current

When a PR changes API routes, event payloads, persistence layout, adapter behavior, or operator workflow, update the relevant docs in the same PR. If a change spans multiple surfaces, update this index when it creates a new durable reference.
