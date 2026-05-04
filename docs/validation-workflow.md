# Validation Workflow

SpecRail uses the GitHub Actions workflow in `.github/workflows/validation.yml` for pull requests and pushes to `main`.

## Full validation

Full validation runs for:

- Every push to `main`.
- Pull requests that touch source code, tests, package/config files, workflow files, scripts, or any non-documentation asset.

Full validation steps are:

1. Checkout with full history for change detection.
2. Setup pnpm and Node.js 22.
3. Run `pnpm check:links`.
4. Install dependencies with `pnpm install --frozen-lockfile`.
5. Run `pnpm check`.
6. Run `pnpm test`.
7. Run `pnpm build`.

## Docs-only pull request fast path

For pull requests only, the workflow detects a docs-only change when every changed file is either:

- Under `docs/`, or
- A Markdown file matching `*.md` at its changed path.

Docs-only PRs still run the same Validation job, but only execute `pnpm check:links`. Dependency installation, typecheck, tests, and build are skipped.

This keeps documentation changes fast while still validating local Markdown links. It also prevents unrelated source-test timing from blocking documentation-only updates.

## What is not docs-only

The workflow intentionally falls back to full validation for changes such as:

- `.github/workflows/*`
- `package.json`, `pnpm-lock.yaml`, or workspace configuration
- `scripts/*`
- `apps/*`, `packages/*`, or tests
- Non-Markdown assets outside `docs/`

If a documentation PR also includes one of these files, expect full validation.

## Local verification

Use the narrowest command that matches the change:

```sh
pnpm check:links
```

For source, config, workflow, or test changes, run the full gate before merging:

```sh
pnpm check && pnpm test && pnpm build
```
