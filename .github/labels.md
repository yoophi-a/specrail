# GitHub Label Taxonomy

Use these labels to keep SpecRail issue and PR triage consistent. Labels are grouped by purpose so each item can describe what kind of work it is, which surface it affects, and whether it needs attention.

## Kind labels

Apply one primary kind label to most issues and PRs:

- `kind:bug` — incorrect behavior, regression, crash, or broken validation.
- `kind:feature` — new user-facing or operator-facing capability.
- `kind:docs` — documentation-only changes.
- `kind:chore` — repository maintenance, tooling, templates, CI, or metadata.
- `kind:refactor` — internal restructuring without intended behavior change.
- `kind:test` — test coverage, fixtures, or validation-only improvements.
- `kind:research` — investigation, design analysis, or decision support.

## Surface labels

Apply all relevant surface labels when the affected area is clear:

- `surface:api` — HTTP routes, request validation, responses, errors, or SSE.
- `surface:core` — domain entities, services, repositories, artifacts, runs, or events.
- `surface:adapters` — Codex, Claude Code, provider metadata, process execution, or event normalization.
- `surface:acp` — ACP server behavior, session mapping, permissions, or ACP metadata.
- `surface:terminal` — terminal client screens, controls, status panes, or event following.
- `surface:telegram` — Telegram webhook adapter, chat binding, messages, or attachment relay.
- `surface:docs` — README, architecture docs, operations docs, or process docs.
- `surface:ci` — GitHub Actions, validation scripts, Dependabot, or release automation.
- `surface:repo` — repository configuration such as `.gitignore`, CODEOWNERS, templates, and editor settings.

## Priority labels

Use priority labels when ordering matters:

- `priority:critical` — blocks safe operation, data integrity, or security-sensitive behavior.
- `priority:high` — blocks a near-term implementation path or user workflow.
- `priority:medium` — important but not currently blocking.
- `priority:low` — cleanup, polish, or future-facing improvement.

## Status labels

Status labels describe the next action or lifecycle state:

- `status:needs-triage` — needs owner review before implementation.
- `status:blocked` — cannot proceed without another PR, issue, credential, or decision.
- `status:ready` — scoped and ready to implement.
- `status:in-progress` — actively being worked on.
- `status:needs-review` — implementation is ready for reviewer attention.
- `status:follow-up` — intentionally deferred from a previous PR or design note.

## Suggested defaults

For new issues created from forms:

- Start with `status:needs-triage`.
- Add one `kind:*` label.
- Add one or more `surface:*` labels when obvious.
- Add `priority:*` only when ordering or urgency is meaningful.

For pull requests:

- Match the linked issue labels where possible.
- Add `status:needs-review` when the PR is ready.
- Remove `status:blocked` when the blocker is resolved.

## Automation notes

This taxonomy is intentionally documentation-first. Label creation or automatic path-based labeling can be added later once the label set stabilizes.
