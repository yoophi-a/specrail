# GitHub Webhook Docker Compose Example

This is a deployment template for running the SpecRail API and GitHub webhook app with Docker Compose. It is not a complete secure deployment by itself: add TLS, authentication, network policy, image publishing, and secret management appropriate for your environment.

## Compose template

```yaml
services:
  specrail-api:
    image: ghcr.io/your-org/specrail-api:latest
    restart: unless-stopped
    env_file:
      - ./specrail-api.env
    environment:
      SPECRAIL_PORT: "4000"
      SPECRAIL_DATA_DIR: /var/lib/specrail/state
      SPECRAIL_REPO_ARTIFACT_DIR: /var/lib/specrail/repo-visible
    volumes:
      - specrail-state:/var/lib/specrail
    expose:
      - "4000"

  specrail-github:
    image: ghcr.io/your-org/specrail-github:latest
    restart: unless-stopped
    depends_on:
      - specrail-api
    env_file:
      - ./specrail-github.env
    environment:
      GITHUB_APP_PORT: "4200"
      GITHUB_WEBHOOK_PATH: /github/webhook
      SPECRAIL_API_BASE_URL: http://specrail-api:4000
      GITHUB_FOLLOW_TERMINAL_EVENTS: "true"
      GITHUB_RELAY_QUEUE_PATH: /var/lib/specrail-github/github-relay-queue.json
    volumes:
      - specrail-github-relay:/var/lib/specrail-github
    expose:
      - "4200"

  reverse-proxy:
    image: nginx:1.27-alpine
    restart: unless-stopped
    depends_on:
      - specrail-api
      - specrail-github
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certs:/etc/nginx/certs:ro
```

```yaml
volumes:
  specrail-state:
  specrail-github-relay:
```

## Environment files

Keep secrets out of the compose file. Use env files, Docker secrets, or your orchestrator's secret manager.

`specrail-github.env` shape:

```sh
GITHUB_WEBHOOK_SECRET=replace-with-secret-manager-value
SPECRAIL_GITHUB_PROJECT_ID=project-default
SPECRAIL_GITHUB_REPOSITORY_PROJECTS=owner/repo=project-default
GITHUB_ALLOWED_ACTORS=maintainer-login
GITHUB_ALLOWED_ORGS=your-org
GITHUB_ALLOWED_TEAMS=your-org/platform-team

# Pick one supported GitHub credential path.
GITHUB_TOKEN=replace-with-secret-manager-value
# or:
# GITHUB_INSTALLATION_TOKEN=replace-with-secret-manager-value
# or GitHub App flow:
# GITHUB_APP_ID=123456
# GITHUB_INSTALLATION_ID=987654
# GITHUB_PRIVATE_KEY=replace-with-secret-manager-value

# Optional authenticated operator URL shown in terminal outcome comments.
SPECRAIL_OPERATOR_BASE_URL=https://specrail.example.com
```

`specrail-api.env` should contain the API's deployment-specific runtime configuration. Do not put provider credentials or execution transcripts into compose labels or public logs.

## Routing notes

Route the public webhook path to `specrail-github:4200`:

```text
/github/webhook -> specrail-github:4200
```

Route authenticated operator/API traffic to `specrail-api:4000`:

```text
/operator -> specrail-api:4000
/projects, /tracks, /runs, /planning-sessions, /approval-requests -> specrail-api:4000
```

Use the reverse-proxy guidance in [Hosted Operator UI deployment](./operator-ui-deployment.md) for TLS, auth, SSE buffering, and trusted identity headers. Do not put the operator auth challenge in front of GitHub webhook delivery; webhook authenticity is handled by GitHub signature verification in the GitHub app.

## Durable relay queue behavior

The `specrail-github-relay` volume stores `GITHUB_RELAY_QUEUE_PATH`. Keep this storage persistent so queued terminal outcome comments survive container restarts.

When `GITHUB_FOLLOW_TERMINAL_EVENTS=true`, `GITHUB_RELAY_QUEUE_PATH` is set, and GitHub comment credentials are configured, the GitHub app polls the queue every 5 seconds. Jobs remain queued/retryable until the linked run reaches `completed`, `failed`, or `cancelled`, at which point the app posts one terminal outcome comment.

## Related docs

- [GitHub App setup](./github-app-setup.md)
- [GitHub webhook production operations](./github-production-ops.md)
- [Hosted Operator UI deployment](./operator-ui-deployment.md)
