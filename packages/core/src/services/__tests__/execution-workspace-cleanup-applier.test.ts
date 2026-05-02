import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionWorkspaceCleanupApplier } from "../execution-workspace-cleanup-applier.js";
import type { ExecutionWorkspaceCleanupPlan } from "../execution-workspace-cleanup-planner.js";

const directoryPlan: ExecutionWorkspaceCleanupPlan = {
  executionId: "run-cleanup-a",
  eligible: true,
  dryRun: true,
  workspacePath: "/tmp/specrail-workspaces/run-cleanup-a",
  branchName: "specrail/run-cleanup-a",
  mode: "directory",
  operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
  refusalReasons: [],
};

const gitWorktreePlan: ExecutionWorkspaceCleanupPlan = {
  executionId: "run-cleanup-b",
  eligible: true,
  dryRun: true,
  workspacePath: "/tmp/specrail-workspaces/run-cleanup-b",
  branchName: "specrail/run-cleanup-b",
  mode: "git_worktree",
  operations: [
    {
      kind: "git_worktree_remove",
      cwd: "/tmp/specrail-repo",
      command: "git",
      args: ["worktree", "remove", "/tmp/specrail-workspaces/run-cleanup-b"],
    },
    {
      kind: "git_branch_delete",
      cwd: "/tmp/specrail-repo",
      command: "git",
      args: ["branch", "-D", "specrail/run-cleanup-b"],
    },
  ],
  refusalReasons: [],
};

test("ExecutionWorkspaceCleanupApplier refuses missing confirmation", async () => {
  const applier = new ExecutionWorkspaceCleanupApplier();

  const result = await applier.apply({ plan: directoryPlan, confirm: false });

  assert.equal(result.status, "refused");
  assert.equal(result.applied, false);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.refusalReasons, ["Workspace cleanup apply requires explicit confirmation"]);
});

test("ExecutionWorkspaceCleanupApplier refuses ineligible plans", async () => {
  const applier = new ExecutionWorkspaceCleanupApplier();

  const result = await applier.apply({
    plan: {
      ...directoryPlan,
      eligible: false,
      operations: [],
      refusalReasons: ["Execution status running is not eligible for workspace cleanup"],
    },
    confirm: true,
  });

  assert.equal(result.status, "refused");
  assert.deepEqual(result.refusalReasons, [
    "Execution status running is not eligible for workspace cleanup",
    "Workspace cleanup plan has no operations to apply",
  ]);
});

test("ExecutionWorkspaceCleanupApplier applies directory cleanup through injected runner", async () => {
  const removedPaths: string[] = [];
  const applier = new ExecutionWorkspaceCleanupApplier({
    fileSystemRunner: {
      async removeDirectory(path) {
        removedPaths.push(path);
      },
    },
  });

  const result = await applier.apply({ plan: directoryPlan, confirm: true });

  assert.equal(result.status, "applied");
  assert.equal(result.applied, true);
  assert.deepEqual(removedPaths, ["/tmp/specrail-workspaces/run-cleanup-a"]);
  assert.deepEqual(result.operations, [{ operation: directoryPlan.operations[0], status: "applied" }]);
});

test("ExecutionWorkspaceCleanupApplier applies git cleanup operations in order", async () => {
  const commands: Array<{ cwd: string; command: string; args: string[] }> = [];
  const applier = new ExecutionWorkspaceCleanupApplier({
    gitRunner: {
      async run(input) {
        commands.push(input);
      },
    },
  });

  const result = await applier.apply({ plan: gitWorktreePlan, confirm: true });

  assert.equal(result.status, "applied");
  assert.deepEqual(commands, [
    { cwd: "/tmp/specrail-repo", command: "git", args: ["worktree", "remove", "/tmp/specrail-workspaces/run-cleanup-b"] },
    { cwd: "/tmp/specrail-repo", command: "git", args: ["branch", "-D", "specrail/run-cleanup-b"] },
  ]);
});

test("ExecutionWorkspaceCleanupApplier returns partial failure details without retrying remaining operations", async () => {
  const commands: Array<{ cwd: string; command: string; args: string[] }> = [];
  const applier = new ExecutionWorkspaceCleanupApplier({
    gitRunner: {
      async run(input) {
        commands.push(input);
        throw new Error("fatal: worktree contains modified files");
      },
    },
  });

  const result = await applier.apply({ plan: gitWorktreePlan, confirm: true });

  assert.equal(result.status, "failed");
  assert.equal(result.applied, false);
  assert.equal(commands.length, 1);
  assert.deepEqual(result.operations, [
    {
      operation: gitWorktreePlan.operations[0],
      status: "failed",
      error: "fatal: worktree contains modified files",
    },
  ]);
});
