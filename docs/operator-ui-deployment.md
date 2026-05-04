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

## Example nginx reverse-proxy template

This template shows the route shape for an nginx deployment. Treat it as a starting point: plug in your own TLS certificates, upstream address, and authentication integration. Authentication must happen before traffic reaches the SpecRail API.

```nginx
upstream specrail_api {
  server 127.0.0.1:4000;
  keepalive 32;
}

server {
  listen 443 ssl http2;
  server_name specrail.example.com;

  ssl_certificate /etc/letsencrypt/live/specrail.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/specrail.example.com/privkey.pem;

  # Replace this with your real auth layer, for example auth_request,
  # oauth2-proxy, SSO gateway headers from a trusted internal proxy, or VPN-only access.
  auth_request /_auth;

  # Never expose this endpoint directly to the internet. It is a placeholder
  # for an identity-aware proxy or internal auth service.
  location = /_auth {
    internal;
    proxy_pass http://127.0.0.1:4180/oauth2/auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
  }

  # Hosted operator shell.
  location = /operator {
    proxy_pass http://specrail_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # SSE stream used by the operator UI. Disable buffering so EventSource
  # receives run events as they are emitted.
  location ~ ^/runs/[^/]+/events/stream$ {
    proxy_pass http://specrail_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    add_header X-Accel-Buffering no;
  }

  # API routes used by the operator UI. Keep these behind the same auth
  # boundary as /operator so the browser can fetch run details and actions.
  location ~ ^/(projects|tracks|runs|planning-sessions|approval-requests)(/|$) {
    proxy_pass http://specrail_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # Optional: keep GitHub webhooks on a separate route with signature
  # verification in the app. Do not put the operator auth challenge in front
  # of GitHub's webhook delivery endpoint.
  location = /github/webhook {
    proxy_pass http://specrail_api;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

If your auth layer forwards identity headers such as `X-Forwarded-User` or `X-Auth-Request-Email`, only trust them from the private proxy boundary. Do not let clients set those headers directly.

Set `SPECRAIL_OPERATOR_BASE_URL=https://specrail.example.com` only after the authenticated route is reachable by intended operators and the SSE route streams correctly through the proxy.

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
