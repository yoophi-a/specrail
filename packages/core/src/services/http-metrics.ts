import type { ServerResponse } from "node:http";

export type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";

export interface HttpRequestMetric {
  service: string;
  route: string;
  method: string;
  statusClass: HttpStatusClass;
  durationSeconds: number;
}

export interface HttpRequestMetricsSink {
  observe(input: HttpRequestMetric): void;
}

export interface PrometheusMetricsExporter {
  renderPrometheusMetrics(): string;
}

export class InMemoryHttpMetricsCollector implements HttpRequestMetricsSink, PrometheusMetricsExporter {
  private readonly requestCounts = new Map<string, { labels: PrometheusLabels; value: number }>();
  private readonly durationHistograms = new Map<string, { labels: PrometheusLabels; buckets: number[]; count: number; sum: number }>();

  constructor(private readonly bucketBounds: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {}

  observe(input: HttpRequestMetric): void {
    const requestLabels: PrometheusLabels = {
      service: input.service,
      route: input.route,
      method: input.method,
      status_class: input.statusClass,
    };
    const requestKey = stableLabelKey(requestLabels);
    const requestCount = this.requestCounts.get(requestKey);
    if (requestCount) {
      requestCount.value += 1;
    } else {
      this.requestCounts.set(requestKey, { labels: requestLabels, value: 1 });
    }

    const durationLabels: PrometheusLabels = {
      service: input.service,
      route: input.route,
      method: input.method,
    };
    const durationKey = stableLabelKey(durationLabels);
    const histogram = this.durationHistograms.get(durationKey);
    if (histogram) {
      histogram.count += 1;
      histogram.sum += input.durationSeconds;
      for (const [index, bound] of this.bucketBounds.entries()) {
        if (input.durationSeconds <= bound) {
          histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
        }
      }
    } else {
      this.durationHistograms.set(durationKey, {
        labels: durationLabels,
        buckets: this.bucketBounds.map((bound) => (input.durationSeconds <= bound ? 1 : 0)),
        count: 1,
        sum: input.durationSeconds,
      });
    }
  }

  renderPrometheusMetrics(): string {
    const lines = [
      "# HELP specrail_http_requests_total Total HTTP requests handled by SpecRail services.",
      "# TYPE specrail_http_requests_total counter",
    ];

    for (const metric of sortMetrics(this.requestCounts.values())) {
      lines.push(`specrail_http_requests_total${formatPrometheusLabels(metric.labels)} ${metric.value}`);
    }

    lines.push(
      "# HELP specrail_http_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE specrail_http_request_duration_seconds histogram",
    );

    for (const metric of sortMetrics(this.durationHistograms.values())) {
      for (const [index, bound] of this.bucketBounds.entries()) {
        lines.push(`specrail_http_request_duration_seconds_bucket${formatPrometheusLabels({ ...metric.labels, le: String(bound) })} ${metric.buckets[index] ?? 0}`);
      }
      lines.push(`specrail_http_request_duration_seconds_bucket${formatPrometheusLabels({ ...metric.labels, le: "+Inf" })} ${metric.count}`);
      lines.push(`specrail_http_request_duration_seconds_count${formatPrometheusLabels(metric.labels)} ${metric.count}`);
      lines.push(`specrail_http_request_duration_seconds_sum${formatPrometheusLabels(metric.labels)} ${formatMetricNumber(metric.sum)}`);
    }

    return `${lines.join("\n")}\n`;
  }
}

export function normalizeHttpMethod(method: string | undefined): string {
  const normalized = method?.trim().toUpperCase();
  return normalized || "UNKNOWN";
}

export function classifyHttpStatus(statusCode: number): HttpStatusClass {
  if (statusCode >= 100 && statusCode < 200) {
    return "1xx";
  }
  if (statusCode >= 200 && statusCode < 300) {
    return "2xx";
  }
  if (statusCode >= 300 && statusCode < 400) {
    return "3xx";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "4xx";
  }
  if (statusCode >= 500 && statusCode < 600) {
    return "5xx";
  }
  return "unknown";
}

export function resolveHttpRouteLabel(pathname: string, routeTemplates: string[]): string {
  const normalizedPathname = normalizePathname(pathname);
  for (const routeTemplate of routeTemplates) {
    if (matchesRouteTemplate(normalizedPathname, normalizePathname(routeTemplate))) {
      return normalizePathname(routeTemplate);
    }
  }
  return "unknown";
}

export function observeHttpRequestMetrics(input: {
  response: ServerResponse;
  sink?: HttpRequestMetricsSink;
  service: string;
  route: string;
  method: string | undefined;
  now?: () => bigint;
}): void {
  if (!input.sink) {
    return;
  }

  const now = input.now ?? process.hrtime.bigint;
  const startedAt = now();
  let observed = false;
  const observe = () => {
    if (observed) {
      return;
    }
    observed = true;
    const elapsedNanoseconds = Number(now() - startedAt);
    input.sink?.observe({
      service: input.service,
      route: input.route,
      method: normalizeHttpMethod(input.method),
      statusClass: classifyHttpStatus(input.response.statusCode),
      durationSeconds: Math.max(0, elapsedNanoseconds / 1_000_000_000),
    });
  };

  input.response.once("finish", observe);
  input.response.once("close", observe);
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim().split("?")[0]?.split("#")[0] ?? "";
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, "") || "/";
}

function matchesRouteTemplate(pathname: string, routeTemplate: string): boolean {
  const pathnameSegments = splitPath(pathname);
  const routeSegments = splitPath(routeTemplate);
  if (pathnameSegments.length !== routeSegments.length) {
    return false;
  }
  return routeSegments.every((routeSegment, index) => routeSegment.startsWith(":") || routeSegment === pathnameSegments[index]);
}

function splitPath(pathname: string): string[] {
  return pathname === "/" ? [] : pathname.slice(1).split("/");
}

type PrometheusLabels = Record<string, string>;

function stableLabelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function sortMetrics<T extends { labels: Record<string, string> }>(metrics: Iterable<T>): T[] {
  return [...metrics].sort((left, right) => stableLabelKey(left.labels).localeCompare(stableLabelKey(right.labels)));
}

function formatPrometheusLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapePrometheusLabelValue(value)}"`);
  return entries.length > 0 ? `{${entries.join(",")}}` : "";
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
}

function formatMetricNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
