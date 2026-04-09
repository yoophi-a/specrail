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

  assert.match(rendered, /# Spec — Track API bootstrap/);
  assert.match(rendered, /## Goals\n- Define the format\n- Keep it readable/);
  assert.match(rendered, /## Acceptance criteria\n- Track creation generates spec.md/);
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

  assert.match(rendered, /Approval status: draft/);
  assert.match(rendered, /1\. \*\*Define types\*\* — Add shared interfaces/);
  assert.match(rendered, /2\. \*\*Render markdown\*\* — Generate stable files/);
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

  assert.match(rendered, /- \[ \] Persist session metadata \(id=task-1, status=in_progress, priority=high, owner=specrail\)/);
  assert.match(rendered, /notes: write run.json \| capture process info/);
  assert.match(rendered, /- \[x\] Close the loop \(id=task-2, status=done, priority=medium\)/);
});
