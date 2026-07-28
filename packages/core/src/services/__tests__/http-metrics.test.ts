import assert from "node:assert/strict";
import test from "node:test";

import { classifyHttpStatus, normalizeHttpMethod, resolveHttpRouteLabel } from "../http-metrics.js";

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
