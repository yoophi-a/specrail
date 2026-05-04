import assert from "node:assert/strict";
import test from "node:test";

import { renderCompletedRunReport } from "../completed-run-report.js";
import type { Execution, ExecutionEvent, Project, Track } from "../../domain/types.js";

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

  assert.match(report, /^# Run Report — run-a/);
  assert.match(report, /- Project: SpecRail \(project-a\)/);
  assert.match(report, /- Track: Report \| export \(track-a\)/);
  assert.match(report, /Ship \| verify\nthen report/);
  assert.match(report, /- Planning session: planning-a/);
  assert.match(report, /- Spec revision: spec-r1/);
  assert.match(report, /\| 2026-05-04T00:01:00.000Z \| task_status_changed \| codex \| Run started \|/);
  assert.match(report, /\| 2026-05-04T00:02:00.000Z \| test_result \| vitest\\\|node \| Tests passed<br>118 ok \|/);
  assert.match(report, /- 2026-05-04T00:02:00.000Z — test_result — Tests passed/);
  assert.match(report, /Generated from `state\/events\/run-a\.jsonl` at 2026-05-04T00:04:00.000Z\./);
  assert.match(report, /does not mutate `spec.md`, `plan.md`, or `tasks.md`/);
});
