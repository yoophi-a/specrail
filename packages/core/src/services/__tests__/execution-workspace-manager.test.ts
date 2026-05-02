import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DirectoryExecutionWorkspaceManager } from "../execution-workspace-manager.js";

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
