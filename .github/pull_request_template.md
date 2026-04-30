## Summary

-

## Linked issues

Closes #

## Scope

Mark the areas this PR touches:

- [ ] Core domain/service logic
- [ ] File-backed repositories or persistence layout
- [ ] Executor adapters (`codex`, `claude_code`, or provider normalization)
- [ ] HTTP API or SSE contract
- [ ] ACP server edge adapter
- [ ] Terminal client
- [ ] Telegram adapter or channel bindings
- [ ] OpenSpec/GitHub integration
- [ ] Documentation only
- [ ] CI/process metadata only

## Contract impact

- [ ] No API/event/persistence contract changes
- [ ] API request/response contract changed; docs/tests updated
- [ ] Execution event schema or subtype mapping changed; docs/tests updated
- [ ] Persistence layout changed; migration/backward-compatibility notes included

## Validation

Run the relevant checks and mark what passed:

- [ ] `pnpm check`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:claude-smoke` (only when provider credentials and local environment are available)
- [ ] Not applicable; explain why below

Validation notes:

-
