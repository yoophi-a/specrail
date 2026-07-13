import assert from "node:assert/strict";
import test from "node:test";

import { renderCompletedRunReport } from "../completed-run-report.js";
import type { Execution, ExecutionEvent, Project, Track } from "../../domain/types.js";

function formatReportSnapshot(report: string): string {
  const compact = report.replace(/\s+/gu, " ").trim();
  return compact.length > 2_000 ? `${compact.slice(0, 2_000)}...<truncated>` : compact;
}

function assertReportMatchesAll(report: string, patterns: RegExp[], label: string): void {
  const missingPatterns = patterns.filter((pattern) => !pattern.test(report));
  assert.deepEqual(
    missingPatterns,
    [],
    `${label} missing expected report pattern(s): ${missingPatterns.map(String).join(", ")}\nReport snapshot:\n${formatReportSnapshot(report)}`,
  );
}

test("renderCompletedRunReport renders metadata, escaped timeline, highlights, and source footer", () => {
  const project: Project = {
    id: "project-a",
    name: "SpecRail",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
  const track: Track = {
    id: "track-a",
    projectId: project.id,
    title: "Report | export",
    description: "Render reports",
    status: "review",
    specStatus: "approved",
    planStatus: "approved",
    priority: "medium",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
  const run: Execution = {
    id: "run-a",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: "/tmp/run-a",
    branchName: "specrail/run-a",
    sessionRef: "session-a",
    command: { command: "codex", args: ["exec"], cwd: "/tmp/run-a", prompt: "Ship | verify\nthen report" },
    summary: { eventCount: 2, lastEventSummary: "Tests passed", lastEventAt: "2026-05-04T00:02:00.000Z" },
    status: "completed",
    createdAt: "2026-05-04T00:00:00.000Z",
    startedAt: "2026-05-04T00:01:00.000Z",
    finishedAt: "2026-05-04T00:03:00.000Z",
    planningSessionId: "planning-a",
    specRevisionId: "spec-r1",
  };
  const events: ExecutionEvent[] = [
    {
      id: "event-2",
      executionId: run.id,
      type: "test_result",
      timestamp: "2026-05-04T00:02:00.000Z",
      source: "vitest|node",
      summary: "Tests passed\n118 ok",
    },
    {
      id: "event-1",
      executionId: run.id,
      type: "task_status_changed",
      timestamp: "2026-05-04T00:01:00.000Z",
      source: "codex",
      summary: "Run started",
    },
  ];

  const report = renderCompletedRunReport({ project, track, run, events, generatedAt: "2026-05-04T00:04:00.000Z" });

  assertReportMatchesAll(
    report,
    [
      /^# Run Report — run-a/,
      /- Project: SpecRail \(project-a\)/,
      /- Track: Report \| export \(track-a\)/,
      /Ship \| verify\nthen report/,
      /- Planning session: planning-a/,
      /- Spec revision: spec-r1/,
      /\| 2026-05-04T00:01:00.000Z \| task_status_changed \| codex \| Run started \|/,
      /\| 2026-05-04T00:02:00.000Z \| test_result \| vitest\\\|node \| Tests passed<br>118 ok \|/,
      /- 2026-05-04T00:02:00.000Z — test_result — Tests passed/,
      /Generated from `state\/events\/run-a\.jsonl` at 2026-05-04T00:04:00.000Z\./,
      /does not mutate `spec.md`, `plan.md`, or `tasks.md`/,
    ],
    "completed run report",
  );
});
