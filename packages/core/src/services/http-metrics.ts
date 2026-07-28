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
