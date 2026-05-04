# Release Process

This checklist keeps SpecRail release handoffs predictable while the project is still an MVP. It is intentionally lightweight and does not introduce release automation yet.

## 1. Confirm repository state

Before preparing a release candidate:

- Review open pull requests for changes that affect API contracts, event payloads, persistence layout, adapter behavior, or operator workflows.
- Confirm whether any open PR is intended to be part of the release.
- Confirm known limitations in the README still match the current implementation.
- Check for uncommitted local changes before tagging or building.

## 2. Run baseline validation

Run the deterministic local checks:

```bash
pnpm check
pnpm test
pnpm build
```

If the change is documentation-only, `pnpm check` may be enough for that PR, but release candidates should use the full baseline above.

## 3. Validate provider-dependent paths when relevant

Claude Code smoke tests are opt-in because they require a real local/provider environment:

```bash
SPECRAIL_RUN_CLAUDE_SMOKE=1 pnpm test:claude-smoke
```

Run this only when the release includes Claude Code adapter, process execution, cancellation, resume, or smoke workflow changes.

## 4. Check operator-facing configuration

For release handoff notes, call out any changes to:

- `SPECRAIL_PORT`
- `SPECRAIL_DATA_DIR`
- `SPECRAIL_REPO_ARTIFACT_DIR`
- `SPECRAIL_EXECUTION_BACKEND`
- `SPECRAIL_EXECUTION_PROFILE`
- `SPECRAIL_API_BASE_URL`
- `SPECRAIL_TERMINAL_REFRESH_MS`
- `SPECRAIL_TERMINAL_INITIAL_SCREEN`
- `SPECRAIL_TERMINAL_INITIAL_PROJECT_ID`
- `SPECRAIL_TERMINAL_INITIAL_RUN_FILTER`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_APP_PORT`
- `TELEGRAM_WEBHOOK_PATH`
- Claude smoke-test environment variables

Never include real provider credentials, bot tokens, local transcripts, or run logs in public release notes.

## 5. Prepare release notes

Release notes should include:

- high-level summary
- notable API, event, persistence, adapter, terminal, or Telegram changes
- migration or cleanup steps, if any
- validation commands and results
- known limitations or follow-up issues

## 6. Tag or hand off

Until automated releases exist, use a simple manual handoff:

1. Ensure the release branch or commit is pushed.
2. Record the commit SHA.
3. Record validation results.
4. Create a tag only after the intended commit is confirmed.
5. Share release notes with the operator or reviewer.

## 7. Post-release follow-up

After a release or handoff:

- Create follow-up issues for deferred known limitations.
- Close release-blocking issues that were completed.
- Keep sensitive incident or credential-exposure reports out of public issues.
