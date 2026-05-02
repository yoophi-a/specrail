import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { Execution } from "../../domain/types.js";
import { planExecutionWorkspaceCleanup } from "../execution-workspace-cleanup-planner.js";

const baseExecution: Execution = {
  id: "run-cleanup-a",
  trackId: "track-cleanup",
  backend: "codex",
  profile: "default",
  workspacePath: path.join("/tmp/specrail-workspaces", "run-cleanup-a"),
  branchName: "specrail/run-cleanup-a",
  status: "completed",
  createdAt: "2026-05-02T13:00:00.000Z",
  startedAt: "2026-05-02T13:00:00.000Z",
  finishedAt: "2026-05-02T13:05:00.000Z",
};

test("planExecutionWorkspaceCleanup previews directory cleanup", () => {
  const plan = planExecutionWorkspaceCleanup({
    execution: baseExecution,
    workspaceRoot: "/tmp/specrail-workspaces",
    mode: "directory",
  });

  assert.equal(plan.eligible, true);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.refusalReasons, []);
  assert.deepEqual(plan.operations, [
    {
      kind: "remove_directory",
      path: path.resolve("/tmp/specrail-workspaces/run-cleanup-a"),
    },
  ]);
});

test("planExecutionWorkspaceCleanup previews git worktree cleanup", () => {
  const plan = planExecutionWorkspaceCleanup({
    execution: baseExecution,
    workspaceRoot: "/tmp/specrail-workspaces",
    mode: "git_worktree",
    localRepoPath: "/tmp/specrail-repo",
  });

  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.operations, [
    {
      kind: "git_worktree_remove",
      cwd: "/tmp/specrail-repo",
      command: "git",
      args: ["worktree", "remove", path.resolve("/tmp/specrail-workspaces/run-cleanup-a")],
    },
    {
      kind: "git_branch_delete",
      cwd: "/tmp/specrail-repo",
      command: "git",
      args: ["branch", "-D", "specrail/run-cleanup-a"],
    },
  ]);
});

test("planExecutionWorkspaceCleanup refuses active executions", () => {
  const plan = planExecutionWorkspaceCleanup({
    execution: { ...baseExecution, status: "running" },
    workspaceRoot: "/tmp/specrail-workspaces",
    mode: "directory",
  });

  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.refusalReasons, ["Execution status running is not eligible for workspace cleanup"]);
});

test("planExecutionWorkspaceCleanup refuses non-owned paths and branches", () => {
  const plan = planExecutionWorkspaceCleanup({
    execution: {
      ...baseExecution,
      workspacePath: "/tmp/other/run-cleanup-a",
      branchName: "feature/not-owned",
    },
    workspaceRoot: "/tmp/specrail-workspaces",
    mode: "git_worktree",
  });

  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.refusalReasons, [
    "Execution workspace path is outside workspace root: /tmp/other/run-cleanup-a",
    "Execution branch is not owned by SpecRail for this run: feature/not-owned",
    "Git worktree cleanup planning requires localRepoPath",
  ]);
});
