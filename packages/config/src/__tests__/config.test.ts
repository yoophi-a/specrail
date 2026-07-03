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
    executionWorkspaceRoot: ".specrail-data/workspaces",
  });
});

test("loadConfig normalizes optional API environment values", () => {
  assert.deepEqual(
    loadConfig({
      SPECRAIL_DATA_DIR: "  /var/lib/specrail  ",
      SPECRAIL_REPO_ARTIFACT_DIR: "  /var/lib/specrail/repo-visible  ",
      SPECRAIL_EXECUTION_BACKEND: "  Claude-Code  ",
      SPECRAIL_EXECUTION_PROFILE: "  production  ",
      SPECRAIL_EXECUTION_WORKSPACE_MODE: "  git_worktree  ",
      SPECRAIL_EXECUTION_WORKSPACE_ROOT: "  /var/lib/specrail/workspaces  ",
    }),
    {
      port: 4000,
      dataDir: "/var/lib/specrail",
      repoArtifactDir: "/var/lib/specrail/repo-visible",
      executionBackend: "claude_code",
      executionProfile: "production",
      executionWorkspaceMode: "git_worktree",
      executionWorkspaceRoot: "/var/lib/specrail/workspaces",
    },
  );
});

test("loadConfig falls back for blank API environment values", () => {
  assert.deepEqual(
    loadConfig({
      SPECRAIL_DATA_DIR: " ",
      SPECRAIL_REPO_ARTIFACT_DIR: "",
      SPECRAIL_EXECUTION_BACKEND: " ",
      SPECRAIL_EXECUTION_PROFILE: "",
      SPECRAIL_EXECUTION_WORKSPACE_MODE: " ",
      SPECRAIL_EXECUTION_WORKSPACE_ROOT: "",
    }),
    {
      port: 4000,
      dataDir: ".specrail-data",
      repoArtifactDir: ".specrail",
      executionBackend: "codex",
      executionProfile: "default",
      executionWorkspaceMode: "directory",
      executionWorkspaceRoot: ".specrail-data/workspaces",
    },
  );
  assert.equal(
    loadConfig({ SPECRAIL_DATA_DIR: "/var/lib/specrail", SPECRAIL_EXECUTION_WORKSPACE_ROOT: " " }).executionWorkspaceRoot,
    "/var/lib/specrail/workspaces",
  );
});

test("loadConfig validates API port environment values", () => {
  assert.equal(loadConfig({ SPECRAIL_PORT: "0" }).port, 0);
  assert.equal(loadConfig({ SPECRAIL_PORT: " 65535 " }).port, 65535);
  assert.equal(loadConfig({ SPECRAIL_PORT: " " }).port, 4000);

  assert.throws(() => loadConfig({ SPECRAIL_PORT: "abc" }), /invalid SPECRAIL_PORT: abc/u);
  assert.throws(() => loadConfig({ SPECRAIL_PORT: "4000.5" }), /invalid SPECRAIL_PORT: 4000.5/u);
  assert.throws(() => loadConfig({ SPECRAIL_PORT: "65536" }), /invalid SPECRAIL_PORT: 65536/u);
});

test("loadConfig reads execution workspace mode", () => {
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "git_worktree" }).executionWorkspaceMode, "git_worktree");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "git-worktree" }).executionWorkspaceMode, "git_worktree");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: " GIT_WORKTREE " }).executionWorkspaceMode, "git_worktree");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "directory" }).executionWorkspaceMode, "directory");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: " Directory " }).executionWorkspaceMode, "directory");
});

test("loadConfig reads supported execution backends", () => {
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_BACKEND: "codex" }).executionBackend, "codex");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_BACKEND: "claude_code" }).executionBackend, "claude_code");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_BACKEND: "claude-code" }).executionBackend, "claude_code");
  assert.equal(loadConfig({ SPECRAIL_EXECUTION_BACKEND: " " }).executionBackend, "codex");
});

test("loadConfig rejects unsupported execution backends", () => {
  assert.throws(
    () => loadConfig({ SPECRAIL_EXECUTION_BACKEND: "opencode" }),
    /Unsupported SPECRAIL_EXECUTION_BACKEND: opencode/,
  );
});

test("loadConfig rejects unsupported execution workspace modes", () => {
  assert.throws(
    () => loadConfig({ SPECRAIL_EXECUTION_WORKSPACE_MODE: "worktree" }),
    /Unsupported SPECRAIL_EXECUTION_WORKSPACE_MODE: worktree/,
  );
});
