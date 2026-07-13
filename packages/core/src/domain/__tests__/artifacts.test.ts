import test from "node:test";
import assert from "node:assert/strict";

import {
  renderPlanDocument,
  renderSpecDocument,
  renderTaskDocument,
  type PlanDocument,
  type SpecDocument,
  type TaskDocument,
} from "../artifacts.js";

function formatMarkdownSnapshot(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > 2_000 ? `${compact.slice(0, 2_000)}...<truncated>` : compact;
}

function assertMarkdownMatchesAll(value: string, patterns: RegExp[], label: string): void {
  const missingPatterns = patterns.filter((pattern) => !pattern.test(value));
  assert.deepEqual(
    missingPatterns,
    [],
    `${label} missing expected markdown pattern(s): ${missingPatterns.map(String).join(", ")}\nMarkdown snapshot:\n${formatMarkdownSnapshot(value)}`,
  );
}

test("renderSpecDocument outputs deterministic sections", () => {
  const spec: SpecDocument = {
    title: "Track API bootstrap",
    problem: "The service has no typed spec artifact yet.",
    goals: ["Define the format", "Keep it readable"],
    nonGoals: ["Database migrations"],
    constraints: ["Artifact-first MVP"],
    acceptanceCriteria: ["Track creation generates spec.md"],
  };

  const rendered = renderSpecDocument(spec);

  assertMarkdownMatchesAll(
    rendered,
    [
      /# Spec — Track API bootstrap/,
      /## Goals\n- Define the format\n- Keep it readable/,
      /## Acceptance criteria\n- Track creation generates spec.md/,
    ],
    "rendered spec document",
  );
});

test("renderPlanDocument includes approval status and ordered steps", () => {
  const plan: PlanDocument = {
    objective: "Ship a small track artifact contract",
    approvalStatus: "draft",
    steps: [
      { title: "Define types", detail: "Add shared interfaces" },
      { title: "Render markdown", detail: "Generate stable files" },
    ],
    risks: ["Format drift"],
    testStrategy: ["Node tests for rendered output"],
  };

  const rendered = renderPlanDocument(plan);

  assertMarkdownMatchesAll(
    rendered,
    [
      /Approval status: draft/,
      /1\. \*\*Define types\*\* — Add shared interfaces/,
      /2\. \*\*Render markdown\*\* — Generate stable files/,
    ],
    "rendered plan document",
  );
});

test("renderTaskDocument renders task metadata and notes", () => {
  const tasks: TaskDocument = {
    trackTitle: "Executor MVP",
    tasks: [
      {
        id: "task-1",
        title: "Persist session metadata",
        status: "in_progress",
        priority: "high",
        owner: "specrail",
        notes: ["write run.json", "capture process info"],
      },
      {
        id: "task-2",
        title: "Close the loop",
        status: "done",
        priority: "medium",
      },
    ],
  };

  const rendered = renderTaskDocument(tasks);

  assertMarkdownMatchesAll(
    rendered,
    [
      /- \[ \] Persist session metadata \(id=task-1, status=in_progress, priority=high, owner=specrail\)/,
      /notes: write run.json \| capture process info/,
      /- \[x\] Close the loop \(id=task-2, status=done, priority=medium\)/,
    ],
    "rendered task document",
  );
});
