# Production Metrics Contract

SpecRail currently exposes production signals through logs, health checks, run events, and injectable metrics sinks. This contract defines the metric families and safety rules future `/metrics`, OpenTelemetry, StatsD, or hosted exporter integrations should preserve.

## Goals

- Keep metrics low-cardinality and safe for shared observability systems.
- Use the same metric names and labels across API, GitHub, Telegram, and future adapters.
- Treat metrics as operational counters/gauges, not a copy of SpecRail state, provider payloads, execution transcripts, or audit logs.
- Keep `GET /healthz` separate from metrics. Health checks answer liveness/readiness; metrics explain volume, latency, outcomes, and queue depth.

## Naming

Use the `specrail_` prefix for all service-owned metrics:

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `specrail_http_requests_total` | counter | `service`, `route`, `method`, `status_class` | API and webhook HTTP servers |
| `specrail_http_request_duration_seconds` | histogram | `service`, `route`, `method` | API and webhook HTTP servers |
| `specrail_runs_started_total` | counter | `service`, `project_id_present`, `backend` | API service |
| `specrail_run_events_total` | counter | `service`, `event_type`, `status` | API service |
| `specrail_runtime_approval_requests_total` | counter | `service`, `decision`, `provider` | API service |
| `specrail_github_commands_total` | counter | `service`, `reason` | GitHub webhook app |
| `specrail_github_relay_jobs_total` | counter | `service`, `backend`, `outcome` | GitHub relay queue worker |
| `specrail_github_relay_queue_depth` | gauge | `service`, `backend`, `state` | GitHub relay queue backend |
| `specrail_telegram_updates_total` | counter | `service`, `outcome` | Telegram adapter |

Use `_seconds` for durations and `_total` for counters. Prefer one stable metric with bounded labels over many service-specific names.

## Required Labels

Every metric should include:

- `service`: one of `specrail-api`, `specrail-github`, `specrail-telegram`, or another stable service id.

Labels must stay low-cardinality. Do not use:

- repository names
- issue numbers
- run ids
- track ids
- project ids
- usernames
- paths
- provider session ids
- prompt text or summaries

When a dimension is useful but high-cardinality, collapse it into a bounded label such as `project_id_present=true|false`, `status_class=2xx|4xx|5xx`, or `outcome=accepted|rejected|failed`.

## Existing GitHub Command Metric

The GitHub webhook app already exposes an injectable command outcome metrics sink with these reasons:

- `accepted`
- `unsupported_repository`
- `unauthorized_actor`
- `github_authorization_failed`
- `specrail_request_failed`
- `github_relay_enqueue_failed`

Exporter integrations should map that sink to:

```text
specrail_github_commands_total{service="specrail-github",reason="<reason>"}
```

Keep the existing safe diagnostic logs for operational identifiers. Do not add repository, issue, sender, team, or organization labels to the metric.

## Existing Telegram Update Metrics

The Telegram adapter exposes an injectable update outcome metrics sink and exports the same counters through the opt-in Telegram Prometheus collector. The supported outcomes are:

- `accepted`
- `ignored`
- `failed`

Exporter integrations and the built-in opt-in `/metrics` endpoint should map that sink to:

```text
specrail_telegram_updates_total{service="specrail-telegram",outcome="<outcome>"}
```

Keep the sink at webhook-update granularity. Do not add chat ids, user ids, thread ids, track ids, run ids, attachment ids, prompt text, captions, or Telegram file ids as metric labels.

## Existing GitHub Relay Metrics

The GitHub webhook app exports durable terminal relay queue metrics through the opt-in Prometheus collector:

- `specrail_github_relay_jobs_total{service="specrail-github",backend="<backend>",outcome="<outcome>"}`
- `specrail_github_relay_queue_depth{service="specrail-github",backend="<backend>",state="<state>"}`

Allowed backend labels are `none`, `directory`, `json-file`, and `postgres`. Allowed job outcomes are `completed`, `retry`, and `failed`. Queue depth states mirror the durable queue lifecycle: `pending`, `running`, `completed`, and `failed`.

Do not add repository names, issue numbers, run ids, report URLs, operator URLs, or queue storage paths to relay metrics.

## Existing API Domain Metrics

The API service exports low-cardinality domain counters through the opt-in Prometheus collector:

- `specrail_runs_started_total{service="specrail-api",project_id_present="<true|false>",backend="<backend>"}`
- `specrail_run_events_total{service="specrail-api",event_type="<event_type>",status="<status>"}`
- `specrail_runtime_approval_requests_total{service="specrail-api",decision="<approved|rejected>",provider="<provider>"}`

Run start metrics are recorded only after the service successfully creates the run. Run event metrics are recorded when execution events are persisted through the API service event store. Runtime approval metrics are recorded after the approval decision is accepted and persisted.

Keep API metrics aggregate-only. Do not add project ids, track ids, run ids, approval request ids, planning ids, prompts, workspace paths, session refs, or callback error details as metric labels.

## HTTP Route Labels

Route labels should use normalized route templates instead of raw URLs:

- `/healthz`
- `/metrics`
- `/operator`
- `/projects`
- `/tracks`
- `/runs`
- `/runs/:runId/events`
- `/runs/:runId/events/stream`
- `/github/webhook`
- `/telegram/webhook`

Unknown paths can be collapsed to `route="unknown"`.

## Safety Rules

Metrics must never include:

- provider tokens, installation tokens, private keys, JWTs, webhook secrets, signatures, or bot tokens
- raw webhook bodies, request headers, prompts, captions, transcripts, or provider payloads
- GitHub membership API responses or private membership detail
- local filesystem paths, repo URLs, branch names, or workspace directories
- run ids, track ids, planning session ids, provider session ids, or attachment ids

Use logs and SpecRail APIs for trace-level investigation. Metrics are for aggregate service health and operational trends.

## Exporter Shape

Future implementations can choose one of these shapes:

1. Prometheus-style `GET /metrics` per service, protected by network policy or scrape authentication.
2. OpenTelemetry counters/histograms exported out-of-process.
3. Injected service-specific metrics sinks for tests and custom deployments.

Whichever shape is chosen, the in-process test surface should remain injectable so tests can assert metric increments without running a metrics server.

## Deployment Notes

- Do not expose metrics publicly with operator or webhook routes.
- `GET /metrics` is disabled by default. Set `SPECRAIL_METRICS_ENABLED=true` on a service process to attach the in-memory Prometheus exporter for that service.
- Keep scrape access inside the cluster, private network, or authenticated monitoring plane.
- Scrape `/healthz` separately from `/metrics`.
- Use alerting on aggregate rates and queue depth, not individual operational ids.

## Open Implementation Work

- Add exporter adapters beyond the built-in opt-in Prometheus endpoint if production deployments need OpenTelemetry or StatsD.
