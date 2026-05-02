import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DirectoryExecutionWorkspaceManager,
  GitWorktreeExecutionWorkspaceManager,
  createExecutionWorkspaceManager,
  type GitCommandRunner,
} from "../execution-workspace-manager.js";

test("DirectoryExecutionWorkspaceManager allocates stable workspace and branch metadata", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-workspace-manager-"));
  const workspaceRoot = path.join(rootDir, "workspaces");
  const manager = new DirectoryExecutionWorkspaceManager();

  const workspace = await manager.allocate({ executionId: "run-workspace-a", workspaceRoot });

  assert.equal(workspace.workspacePath, path.join(workspaceRoot, "run-workspace-a"));
  assert.equal(workspace.branchName, "specrail/run-workspace-a");
  assert.equal(workspace.mode, "directory");
  assert.equal((await stat(workspace.workspacePath)).isDirectory(), true);
});

test("createExecutionWorkspaceManager selects directory and git worktree managers", () => {
  assert.ok(createExecutionWorkspaceManager("directory") instanceof DirectoryExecutionWorkspaceManager);
  assert.ok(createExecutionWorkspaceManager("git_worktree") instanceof GitWorktreeExecutionWorkspaceManager);
});

test("GitWorktreeExecutionWorkspaceManager plans git worktree allocation commands", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-worktree-manager-"));
  const workspaceRoot = path.join(rootDir, "workspaces");
  const localRepoPath = path.join(rootDir, "repo");
  const commands: Array<{ cwd: string; command: string; args: string[] }> = [];
  const gitRunner: GitCommandRunner = {
    async run(input) {
      commands.push(input);
    },
  };
  const manager = new GitWorktreeExecutionWorkspaceManager({ gitRunner });

  const workspace = await manager.allocate({ executionId: "run-worktree-a", workspaceRoot, localRepoPath });

  assert.deepEqual(workspace, {
    workspacePath: path.join(workspaceRoot, "run-worktree-a"),
    branchName: "specrail/run-worktree-a",
    mode: "git_worktree",
  });
  assert.deepEqual(commands, [
    {
      cwd: localRepoPath,
      command: "git",
      args: ["worktree", "add", "-b", "specrail/run-worktree-a", path.join(workspaceRoot, "run-worktree-a")],
    },
  ]);
});

test("GitWorktreeExecutionWorkspaceManager rejects missing repo paths and existing workspaces", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-worktree-manager-"));
  const workspaceRoot = path.join(rootDir, "workspaces");
  const manager = new GitWorktreeExecutionWorkspaceManager({
    gitRunner: {
      async run() {
        throw new Error("git should not be called");
      },
    },
  });

  await assert.rejects(
    () => manager.allocate({ executionId: "run-missing-repo", workspaceRoot }),
    /requires localRepoPath/,
  );

  await mkdir(path.join(workspaceRoot, "run-collision"), { recursive: true });
  await assert.rejects(
    () => manager.allocate({ executionId: "run-collision", workspaceRoot, localRepoPath: rootDir }),
    new RegExp(`Execution workspace already exists: ${escapeRegExp(path.join(workspaceRoot, "run-collision"))}`),
  );
});

test("GitWorktreeExecutionWorkspaceManager maps git runner failures", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-worktree-manager-"));
  const manager = new GitWorktreeExecutionWorkspaceManager({
    gitRunner: {
      async run() {
        throw new Error("fatal: a branch named 'specrail/run-fail' already exists");
      },
    },
  });

  await assert.rejects(
    () =>
      manager.allocate({
        executionId: "run-fail",
        workspaceRoot: path.join(rootDir, "workspaces"),
        localRepoPath: path.join(rootDir, "repo"),
      }),
    /Failed to allocate git worktree for execution run-fail: fatal: a branch named 'specrail\/run-fail' already exists/,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
