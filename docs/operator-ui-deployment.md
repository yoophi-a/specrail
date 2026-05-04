# Hosted Operator UI Deployment

SpecRail serves a hosted operator UI at `GET /operator`. The UI is a thin frontend over the existing SpecRail HTTP/SSE API: it does not own canonical run state, artifacts, or GitHub history. Deploy it as an authenticated operational surface, not as a public website.

## Recommended deployment shape

Put the SpecRail API behind a reverse proxy that provides TLS and authentication before traffic reaches the app:

```text
operator browser
  -> HTTPS reverse proxy / identity-aware proxy
  -> SpecRail API server
       - GET /operator
       - /projects
       - /tracks
       - /runs
       - /approval-requests
```

Use the authenticated public base URL as `SPECRAIL_OPERATOR_BASE_URL` for GitHub terminal comments. For example:

```sh
SPECRAIL_OPERATOR_BASE_URL=https://specrail.example.com
```

When this value is configured, GitHub terminal outcome comments can include links like:

```text
Operator: https://specrail.example.com/operator?runId=run-123
```

The linked page loads run details through the same protected API routes. Do not point `SPECRAIL_OPERATOR_BASE_URL` at an unauthenticated or internal-only URL that GitHub users cannot safely open.

## Auth and routing requirements

Protect at least these routes as one operator surface:

- `GET /operator`
- `GET /projects`, `POST /projects`, `PATCH /projects/:projectId`
- `GET /tracks`, `POST /tracks`, `GET/PATCH /tracks/:trackId`
- `POST /tracks/:trackId/planning-sessions`
- `POST /planning-sessions/:planningSessionId/messages`
- `GET/POST /tracks/:trackId/artifacts/:artifact`
- `GET /runs`, `POST /runs`, `GET /runs/:runId`
- `POST /runs/:runId/resume`, `POST /runs/:runId/cancel`
- `GET /runs/:runId/events`, `GET /runs/:runId/events/stream`
- `GET /runs/:runId/report.md`
- `GET/POST /runs/:runId/workspace-cleanup/*`
- `POST /approval-requests/:approvalRequestId/:decision`

The UI uses browser `fetch` plus `EventSource`, so the proxy must allow normal HTTP methods and SSE streaming for `GET /runs/:runId/events/stream`.

## Security checklist

- Require HTTPS for the operator URL.
- Require authentication before `/operator` and every API route the UI calls.
- Prefer an identity-aware proxy, SSO gateway, VPN, or private network in front of the API.
- Limit operator access to trusted maintainers; the UI can resume/cancel runs, decide approvals, and apply workspace cleanup after confirmation.
- Do not expose provider credentials, GitHub App private keys, tokens, raw webhook bodies, or execution transcripts in proxy logs.
- Treat Markdown report links as operational links. Reports are derived read-only exports, but they can still contain run summaries and metadata.
- Keep GitHub as a thin entrypoint. GitHub comments may link to the operator UI, but SpecRail remains the canonical state and artifact source.
- If the operator URL is not safely reachable by intended operators, leave `SPECRAIL_OPERATOR_BASE_URL` unset; GitHub comments will still include the read-only report URL when available.

## Related docs

- [GitHub App setup](./github-app-setup.md)
- [MVP architecture](./architecture/mvp-architecture.md)
- [GitHub entrypoint architecture slice](./architecture/github-entrypoint-slice.md)
