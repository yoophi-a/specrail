# Troubleshooting

This runbook collects common SpecRail operator checks. Keep secrets, local paths, transcripts, run logs, bot tokens, and provider credentials out of public issues and release notes.

## First checks

Start with deterministic local validation:

```bash
pnpm check
pnpm test
pnpm build
```

Then confirm the runtime configuration you expect:

- `SPECRAIL_PORT`
- `SPECRAIL_DATA_DIR`
- `SPECRAIL_REPO_ARTIFACT_DIR`
- `SPECRAIL_EXECUTION_BACKEND`
- `SPECRAIL_EXECUTION_PROFILE`
- `SPECRAIL_API_BASE_URL`

## API server does not start

Check:

1. The selected port is free.
2. `SPECRAIL_DATA_DIR` and `SPECRAIL_REPO_ARTIFACT_DIR` are writable.
3. The configured default execution backend is supported by the current build.
4. `pnpm dev:api` is being run from the repository root.

If startup still fails, capture the error message and the relevant environment keys, but redact secrets and machine-specific paths before sharing publicly.

## Tracks or artifacts are missing

Check:

1. The API process is using the expected `SPECRAIL_DATA_DIR`.
2. The repository artifact directory matches `SPECRAIL_REPO_ARTIFACT_DIR`.
3. The track was created through the current API process, not a previous local data directory.
4. File-backed state was not deleted or moved between runs.

For data-layout questions, inspect the repository and runtime paths locally rather than pasting full artifact contents into public issues.

## Terminal client cannot connect

Check:

1. The API server is running.
2. `SPECRAIL_API_BASE_URL` points to the same port as the API server.
3. `SPECRAIL_TERMINAL_REFRESH_MS` is a valid number.
4. `SPECRAIL_TERMINAL_INITIAL_SCREEN` is one of `home`, `tracks`, `runs`, or `settings`.

Then restart the terminal client:

```bash
pnpm dev:terminal
```

## Telegram adapter is not receiving updates

Check:

1. `TELEGRAM_BOT_TOKEN` is set locally and was not committed.
2. `SPECRAIL_API_BASE_URL` points to a reachable API server.
3. `TELEGRAM_APP_PORT` is open locally or in the deployment environment.
4. `TELEGRAM_WEBHOOK_PATH` matches the webhook registration.
5. The adapter was started with `pnpm dev:telegram` from the repository root.

Never paste a real Telegram token into an issue, pull request, release note, or chat report.

## Claude Code smoke test is skipped

The Claude smoke path is opt-in. A skip is expected unless this is set:

```bash
SPECRAIL_RUN_CLAUDE_SMOKE=1 pnpm test:claude-smoke
```

For CI, the smoke workflow is additionally gated by the repository variable `SPECRAIL_ENABLE_CLAUDE_SMOKE=1`.

## Claude Code run fails

Check:

1. `claude --version` works in the same shell or runner environment.
2. The selected profile/model is available.
3. The failure message records whether Claude exited with a code, returned an error result, or required permission handling.
4. Cancellation metadata indicates whether process termination was delivered or needs manual follow-up.

Use `docs/claude-code-operations.md` for deeper Claude-specific recovery and smoke-test behavior.

## SSE or run events look stale

Check:

1. The run id is correct.
2. The API process is reading the expected event JSONL files under the selected data directory.
3. The client has not paused event following.
4. The run has not already reached a terminal state.
5. The planning context has not become stale because newer revisions were approved after the run started.

If the terminal client shows stale planning context or failure focus, compare it with the persisted run metadata before retrying or resuming.

## Public issue guidance

Use public issues for reproducible product or code problems. For anything involving credentials, local workspace contents, private transcripts, run logs, or path disclosure, use a private disclosure path instead.
