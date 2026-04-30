# Security Policy

SpecRail is currently an MVP for spec-driven coding-agent orchestration. It can interact with local workspaces, provider CLIs, run logs, Telegram webhooks, and future integration credentials, so security reports should be handled carefully even before production authentication is implemented.

## Supported scope

Please treat the following as security-sensitive:

- exposure of provider credentials, API keys, OAuth tokens, bot tokens, or webhook secrets
- accidental disclosure of local file paths, workspace contents, run logs, transcripts, or attachment metadata
- ways to trigger unintended command execution, resume/cancel the wrong run, or bypass run/track validation
- API, ACP, terminal, or Telegram behavior that leaks data across tracks, sessions, chats, or users
- vulnerabilities in file-backed persistence, artifact materialization, or path handling
- GitHub/OpenSpec integration behavior that could publish private run details to the wrong issue or pull request

## Reporting privately

Do not open a public GitHub issue for security-sensitive reports.

Instead, contact the maintainers privately using the repository owner's preferred private channel. If you do not already have a private channel, open a minimal public issue that asks for a private disclosure path without including exploit details, secrets, logs, or reproduction payloads.

## What to include

When reporting privately, include as much of the following as is safe to share:

- affected surface: API, core service, adapter, ACP server, terminal client, Telegram adapter, GitHub/OpenSpec integration, CI, or docs
- affected commit, branch, release, or PR
- minimal reproduction steps
- expected vs actual behavior
- whether credentials, local paths, run logs, transcripts, or attachment metadata were exposed
- suggested mitigation, if known

Please redact secrets and personal data from logs before sharing them.

## Public issues

Use public GitHub issues for normal bugs and feature requests only. If you are unsure whether something is security-sensitive, treat it as private first.

## Current MVP limitations

The current MVP does not yet include production authentication, authorization, multi-user access control, or database-backed persistence. Reports about those missing features are useful as product/security requirements, but they are expected limitations unless they expose a concrete unintended behavior in the implemented surfaces.
