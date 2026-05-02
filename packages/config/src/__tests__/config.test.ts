import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../index.js";

test("loadConfig returns execution defaults", () => {
  assert.deepEqual(loadConfig({}), {
    port: 4000,
    dataDir: ".specrail-data",
    repoArtifactDir: ".specrail",
    executionBackend: "codex",
    executionProfile: "default",
    executionWorkspaceMode: "directory",
  });
});

test("loadConfig reads execution workspace mode", () => {
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "git_worktree" }).executionWorkspaceMode, "git_worktree");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "directory" }).executionWorkspaceMode, "directory");
});

test("loadConfig rejects unsupported execution workspace modes", () => {
  assert.throws(
    () => loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "worktree" }),
    /Unsupported SPECRAIL_EXECUTION_WORKSPACE_MODE: worktree/,
  );
});
