# Development Environment

This document captures the local runtime baseline for working on SpecRail.

## Runtime baseline

- Node.js: 22.x
- pnpm: 10.x, as declared by the root `packageManager` field

Use a Node version manager such as `mise`, `fnm`, `asdf`, `nodenv`, or `nvm` to select the version from `.node-version` when your shell supports it.

## Install

```bash
pnpm install
```

## Standard validation

Run the baseline checks before opening code changes:

```bash
pnpm validate
```

`pnpm validate` runs `pnpm check`, `pnpm test`, and `pnpm build` in order. Use the individual commands for narrower iteration.

For docs-only or repository metadata-only changes, run `pnpm check:links` plus `pnpm check` unless the change affects generated artifacts, workflows, scripts, or runtime behavior. In those broader cases, run `pnpm validate`.

## Provider-dependent smoke tests

Claude Code smoke tests are opt-in because they require a local/provider environment:

```bash
SPECRAIL_RUN_CLAUDE_SMOKE=1 pnpm test:claude-smoke
```

Do not fold provider-dependent smoke tests into the default validation path unless CI and local credential behavior are explicitly handled.

## Local services

Useful development entry points:

```bash
pnpm dev:api
pnpm dev:acp
pnpm dev:terminal
pnpm dev:telegram
```

The Telegram adapter requires `SPECRAIL_API_BASE_URL`, `TELEGRAM_BOT_TOKEN`, and optionally `TELEGRAM_APP_PORT` / `TELEGRAM_WEBHOOK_PATH`.
