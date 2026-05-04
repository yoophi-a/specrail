# GitHub Command Troubleshooting

This guide helps operators interpret GitHub `/specrail` command diagnostics and metrics. GitHub remains a thin entrypoint: command handling should be debugged by following the SpecRail webhook response, safe diagnostic code, coarse metric reason, and the canonical SpecRail API state.

## Signals to check

- **Webhook HTTP response** from the GitHub app.
- **Safe diagnostic log** emitted as `GitHub /specrail command diagnostic` for denied commands.
- **Command outcome metric** emitted through the injected GitHub command metrics sink.
- **SpecRail API state** for projects, tracks, bindings, runs, and run events.
- **GitHub terminal relay queue/logs** only when terminal comment posting is enabled.

Do not debug by copying secrets or raw payloads into logs. Diagnostics intentionally preserve opaque repository names, issue numbers, sender logins, URLs, hashes, and file paths, but avoid token/private-key/raw-webhook-body and membership-sensitive details.

## Outcome reference

| Signal | HTTP response | Likely cause | Safe next checks |
| --- | --- | --- | --- |
| `accepted` metric | `202 { accepted: true, outcome }` | Command accepted and SpecRail run orchestration started. | Check `outcome.runId`, report URL, operator URL, and run events in SpecRail. |
| `unsupported_repository` diagnostic + metric | `202 { accepted: false, reason: "unsupported_repository" }` | Repository is not mapped to a project when repository allowlisting is configured. | Check `SPECRAIL_GITHUB_REPOSITORY_PROJECTS`, `SPECRAIL_GITHUB_PROJECT_ID`, and repository `full_name`. |
| `unauthorized_actor` diagnostic + metric | `202 { accepted: false, reason: "unauthorized_actor" }` | Sender did not pass configured actor/org/team allowlists. | Check `GITHUB_ALLOWED_ACTORS`, `GITHUB_ALLOWED_ORGS`, `GITHUB_ALLOWED_TEAMS`, and the sender login. Do not log private membership details. |
| `github_authorization_failed` diagnostic + metric | `502 { error: "github_authorization_failed" }` | GitHub org/team membership lookup failed unexpectedly. | Check GitHub API reachability, token provider configuration, app installation permissions, and sanitized error message. |
| `specrail_request_failed` metric | `502 { error: "specrail_request_failed" }` | SpecRail API request failed while finding/creating bindings, tracks, or runs. | Check `SPECRAIL_API_BASE_URL`, API health, project id, and server logs for the corresponding request path/status. |
| `github_relay_enqueue_failed` metric | `502 { error: "github_relay_enqueue_failed" }` | Terminal outcome relay job could not be queued after run creation. | Check `GITHUB_FOLLOW_TERMINAL_EVENTS`, `GITHUB_RELAY_QUEUE_PATH`, queue file permissions, and disk availability. |

Webhook-level rejections such as invalid signatures, unsupported events, unsupported actions, unsupported commands, bad JSON, and missing context are not command authorization diagnostics. Validate webhook delivery settings before investigating SpecRail orchestration.

## Common flows

### Command is ignored with `unsupported_repository`

1. Confirm the GitHub payload repository `full_name` matches the configured key exactly.
2. If `SPECRAIL_GITHUB_REPOSITORY_PROJECTS` is set, ensure it contains `owner/repo=project-id` for this repository.
3. If the repository should use the default project, confirm `SPECRAIL_GITHUB_PROJECT_ID` or `SPECRAIL_PROJECT_ID` is set and repository allowlisting is not unintentionally excluding it.

### Command is denied with `unauthorized_actor`

1. Confirm the sender login is expected to run SpecRail.
2. Check static actor allowlist first: `GITHUB_ALLOWED_ACTORS`.
3. If org/team auth is used, check `GITHUB_ALLOWED_ORGS` and `GITHUB_ALLOWED_TEAMS` configuration.
4. Verify the GitHub App or token has permission to read the required organization/team membership.
5. Keep logs coarse. Do not expose private org/team membership details in comments or public logs.

### Authorization lookup returns `github_authorization_failed`

1. Check GitHub API base URL and network reachability.
2. Check GitHub token provider setup: static token, installation token, or GitHub App private key/JWT flow.
3. Check whether the app installation can access the target org/team membership endpoints.
4. Use the sanitized error message for routing the issue; do not dump request headers, tokens, or raw API responses containing sensitive detail.

### SpecRail request fails

1. Confirm the GitHub app can reach `SPECRAIL_API_BASE_URL`.
2. Check that the resolved project id exists.
3. Inspect SpecRail API logs for the same request path and status.
4. Verify canonical state in SpecRail APIs instead of inferring state from GitHub comments.

### Terminal comment relay does not post

1. Confirm `GITHUB_FOLLOW_TERMINAL_EVENTS=true`.
2. If `GITHUB_RELAY_QUEUE_PATH` is configured, check the durable queue file exists, is writable by the app, and is processed by `processGitHubRelayQueue`.
3. Confirm the run reached a terminal state: `completed`, `failed`, or `cancelled`.
4. Confirm GitHub issue comment credentials are configured and can post to the repository.
5. Non-terminal statuses are intentionally no-ops.

## Safe diagnostics policy

Allowed in diagnostics:

- Diagnostic code.
- Repository `full_name`.
- Issue or PR number.
- Sender login.
- Sanitized error message.
- Opaque ids, URLs, hashes, and file paths that are already operational identifiers.

Do not log or post:

- GitHub tokens, installation tokens, App private keys, JWTs, webhook secrets, or signatures.
- Raw webhook bodies or request headers.
- Full GitHub membership API responses or private membership details.
- Execution transcripts beyond the existing SpecRail event/report access policy.

## Related docs

- [GitHub App setup](./github-app-setup.md)
- [Hosted Operator UI deployment](./operator-ui-deployment.md)
- [GitHub entrypoint architecture slice](./architecture/github-entrypoint-slice.md)
