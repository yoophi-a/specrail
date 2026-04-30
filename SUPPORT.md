# Support

SpecRail is currently an MVP for spec-driven coding-agent orchestration. This support policy explains where to route questions, bugs, feature requests, and sensitive reports.

## Supported surfaces

Use this repository for support around:

- HTTP API and SSE behavior
- track, planning, artifact, run, and event state
- file-backed persistence and local artifact materialization
- Codex and Claude Code execution adapters
- ACP server edge adapter behavior
- terminal client operation
- Telegram adapter operation
- GitHub/OpenSpec integration design notes
- repository validation, CI, and contributor workflow

## Public issues

Open a public GitHub issue for reproducible bugs, feature requests, documentation gaps, and non-sensitive operator questions.

Include the following when safe:

- affected surface
- expected and actual behavior
- reproduction steps
- relevant command and validation output
- Node and pnpm versions
- whether the issue involves API, ACP, terminal, Telegram, adapter, docs, or CI behavior

Do not include real provider credentials, bot tokens, private transcripts, run logs, local workspace contents, or sensitive file paths.

## Security-sensitive reports

Do not open a public issue when the report involves:

- credential, API key, bot token, OAuth token, or webhook secret exposure
- private transcript, run log, local file path, or workspace data disclosure
- unintended command execution
- bypassing validation or run/track isolation
- leaking data across sessions, chats, tracks, users, or providers

Use a private disclosure path instead. If you do not have one, open a minimal public issue asking for a private security contact without including exploit details or secrets.

## Operational questions

For local operation issues, first gather:

- command that failed
- sanitized error message
- selected environment variable names and non-secret values
- whether the API server is reachable
- whether the data/artifact directory is the expected one
- whether the problem reproduces after restarting the relevant app

Keep sanitized diagnostic context short and focused.

## Current MVP expectations

The MVP does not yet provide production authentication, authorization, multi-user access control, database-backed persistence, or release automation. Questions about those areas are welcome as feature requests or roadmap discussion unless they expose a concrete unintended behavior in an implemented surface.
