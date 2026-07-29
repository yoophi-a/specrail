import assert from "node:assert/strict";
import test from "node:test";

import {
  escapePrometheusLabelValue,
  formatPrometheusLabels,
  formatPrometheusNumber,
  incrementPrometheusCounter,
  renderPrometheusCounter,
  renderPrometheusGauge,
  setPrometheusGauge,
  stablePrometheusLabelKey,
  type PrometheusMetricMap,
} from "../prometheus-metrics.js";

test("Prometheus helpers increment counters and render sorted escaped samples", () => {
  const metrics: PrometheusMetricMap = new Map();

  incrementPrometheusCounter(metrics, { service: "specrail-api", route: "/runs", reason: "ok" });
  incrementPrometheusCounter(metrics, { reason: "ok", route: "/runs", service: "specrail-api" });
  incrementPrometheusCounter(metrics, { service: "specrail-api", route: "/quoted", reason: 'a"b\\c\n' });

  const rendered = renderPrometheusCounter("specrail_test_total", "Total test samples.", metrics);

  assert.equal(
    rendered,
    [
      "# HELP specrail_test_total Total test samples.",
      "# TYPE specrail_test_total counter",
      'specrail_test_total{reason="a\\"b\\\\c\\n",route="/quoted",service="specrail-api"} 1',
      'specrail_test_total{reason="ok",route="/runs",service="specrail-api"} 2',
    ].join("\n"),
  );
});

test("Prometheus helpers set gauges, format labels, and collapse non-finite numbers", () => {
  const metrics: PrometheusMetricMap = new Map();

  setPrometheusGauge(metrics, { state: "running", service: "specrail-github" }, 2);
  setPrometheusGauge(metrics, { service: "specrail-github", state: "running" }, 3);
  setPrometheusGauge(metrics, { state: "failed", service: "specrail-github" }, Number.NaN);

  assert.equal(stablePrometheusLabelKey({ b: "2", a: "1" }), "a=1\nb=2");
  assert.equal(formatPrometheusLabels({ b: "2", a: "1" }), '{a="1",b="2"}');
  assert.equal(escapePrometheusLabelValue('a"b\\c\n'), 'a\\"b\\\\c\\n');
  assert.equal(formatPrometheusNumber(Number.POSITIVE_INFINITY), "0");

  const rendered = renderPrometheusGauge("specrail_queue_depth", "Current queue depth.", metrics);

  assert.equal(
    rendered,
    [
      "# HELP specrail_queue_depth Current queue depth.",
      "# TYPE specrail_queue_depth gauge",
      'specrail_queue_depth{service="specrail-github",state="failed"} 0',
      'specrail_queue_depth{service="specrail-github",state="running"} 3',
    ].join("\n"),
  );
});
