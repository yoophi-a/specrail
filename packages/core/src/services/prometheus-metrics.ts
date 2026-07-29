export type PrometheusLabels = Record<string, string>;

export interface PrometheusMetricSample {
  labels: PrometheusLabels;
  value: number;
}

export type PrometheusMetricMap = Map<string, PrometheusMetricSample>;

export function incrementPrometheusCounter(metrics: PrometheusMetricMap, labels: PrometheusLabels): void {
  const key = stablePrometheusLabelKey(labels);
  const metric = metrics.get(key);
  if (metric) {
    metric.value += 1;
  } else {
    metrics.set(key, { labels, value: 1 });
  }
}

export function setPrometheusGauge(metrics: PrometheusMetricMap, labels: PrometheusLabels, value: number): void {
  metrics.set(stablePrometheusLabelKey(labels), { labels, value });
}

export function renderPrometheusCounter(name: string, help: string, metrics: PrometheusMetricMap): string {
  return renderPrometheusMetricSet({ name, help, type: "counter", metrics });
}

export function renderPrometheusGauge(name: string, help: string, metrics: PrometheusMetricMap): string {
  return renderPrometheusMetricSet({ name, help, type: "gauge", metrics });
}

export function renderPrometheusMetricSet(input: {
  name: string;
  help: string;
  type: "counter" | "gauge";
  metrics: PrometheusMetricMap;
}): string {
  const lines = [`# HELP ${input.name} ${input.help}`, `# TYPE ${input.name} ${input.type}`];
  for (const metric of sortPrometheusMetrics(input.metrics.values())) {
    lines.push(`${input.name}${formatPrometheusLabels(metric.labels)} ${formatPrometheusNumber(metric.value)}`);
  }
  return lines.join("\n");
}

export function sortPrometheusMetrics<T extends { labels: PrometheusLabels }>(metrics: Iterable<T>): T[] {
  return [...metrics].sort((left, right) => stablePrometheusLabelKey(left.labels).localeCompare(stablePrometheusLabelKey(right.labels)));
}

export function stablePrometheusLabelKey(labels: PrometheusLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function formatPrometheusLabels(labels: PrometheusLabels): string {
  const entries = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapePrometheusLabelValue(value)}"`);
  return entries.length > 0 ? `{${entries.join(",")}}` : "";
}

export function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
}

export function formatPrometheusNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
