import assert from "node:assert/strict";
import test from "node:test";

import { classifyHttpStatus, InMemoryHttpMetricsCollector, normalizeHttpMethod, resolveHttpRouteLabel } from "../http-metrics.js";

test("HTTP metrics helpers normalize safe method, status, and route labels", () => {
  assert.equal(normalizeHttpMethod(" post "), "POST");
  assert.equal(normalizeHttpMethod(undefined), "UNKNOWN");

  assert.equal(classifyHttpStatus(101), "1xx");
  assert.equal(classifyHttpStatus(204), "2xx");
  assert.equal(classifyHttpStatus(302), "3xx");
  assert.equal(classifyHttpStatus(404), "4xx");
  assert.equal(classifyHttpStatus(502), "5xx");
  assert.equal(classifyHttpStatus(700), "unknown");

  assert.equal(resolveHttpRouteLabel("/runs/run-123/events?ignored=true", ["/runs/:runId/events"]), "/runs/:runId/events");
  assert.equal(resolveHttpRouteLabel("/runs/run-123/events", ["/runs/:runId/events"]), "/runs/:runId/events");
  assert.equal(resolveHttpRouteLabel("/runs/run-123/events/", ["/runs/:runId/events"]), "/runs/:runId/events");
  assert.equal(resolveHttpRouteLabel("/runs/run-123/events/stream", ["/runs/:runId/events", "/runs/:runId/events/stream"]), "/runs/:runId/events/stream");
  assert.equal(resolveHttpRouteLabel("/unexpected/run-123", ["/runs/:runId/events"]), "unknown");
});

test("InMemoryHttpMetricsCollector renders Prometheus counters and histograms", () => {
  const collector = new InMemoryHttpMetricsCollector([0.1, 1]);

  collector.observe({
    service: "specrail-api",
    route: "/runs/:runId/events",
    method: "GET",
    statusClass: "2xx",
    durationSeconds: 0.05,
  });
  collector.observe({
    service: "specrail-api",
    route: "/runs/:runId/events",
    method: "GET",
    statusClass: "5xx",
    durationSeconds: 2,
  });
  collector.observe({
    service: 'specrail-"quoted"',
    route: "/metrics",
    method: "GET",
    statusClass: "2xx",
    durationSeconds: 0,
  });

  const rendered = collector.renderPrometheusMetrics();

  assert.match(rendered, /# TYPE specrail_http_requests_total counter/u);
  assert.match(
    rendered,
    /specrail_http_requests_total\{method="GET",route="\/runs\/:runId\/events",service="specrail-api",status_class="2xx"\} 1/u,
  );
  assert.match(
    rendered,
    /specrail_http_request_duration_seconds_bucket\{le="0.1",method="GET",route="\/runs\/:runId\/events",service="specrail-api"\} 1/u,
  );
  assert.match(
    rendered,
    /specrail_http_request_duration_seconds_bucket\{le="\+Inf",method="GET",route="\/runs\/:runId\/events",service="specrail-api"\} 2/u,
  );
  assert.match(
    rendered,
    /specrail_http_request_duration_seconds_count\{method="GET",route="\/runs\/:runId\/events",service="specrail-api"\} 2/u,
  );
  assert.match(rendered, /service="specrail-\\"quoted\\""/u);
});
