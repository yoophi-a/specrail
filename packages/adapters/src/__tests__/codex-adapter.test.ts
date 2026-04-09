import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexSpawnCommand,
  CodexAdapterStub,
  readCodexSessionMetadata,
} from "../index.js";

test("buildCodexSpawnCommand creates a deterministic codex exec invocation", () => {
  assert.deepEqual(
    buildCodexSpawnCommand({
      executionId: "run-1",
      prompt: "Implement the endpoint",
      workspacePath: "/tmp/specrail/run-1",
      profile: "default",
    }),
    {
      command: "codex",
      args: ["exec", "--profile", "default", "Implement the endpoint"],
      cwd: "/tmp/specrail/run-1",
    },
  );
});

test("CodexAdapterStub persists spawn metadata and supports resume/cancel lifecycle", async () => {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-codex-sessions-"));
  const spawnedCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const timestamps = [
    "2026-04-09T00:00:00.000Z",
    "2026-04-09T00:05:00.000Z",
    "2026-04-09T00:10:00.000Z",
  ];

  const adapter = new CodexAdapterStub({
    sessionsDir,
    now: () => timestamps.shift() ?? "2026-04-09T00:10:00.000Z",
    spawnProcess: (command, args, cwd) => {
      spawnedCalls.push({ command, args, cwd });
      return { pid: 4242 };
    },
  });

  const spawnResult = await adapter.spawn({
    executionId: "run-1",
    prompt: "Implement the endpoint",
    workspacePath: "/tmp/specrail/run-1",
    profile: "default",
  });

  assert.equal(spawnResult.sessionRef, "run-1-codex");
  assert.deepEqual(spawnedCalls, [
    {
      command: "codex",
      args: ["exec", "--profile", "default", "Implement the endpoint"],
      cwd: "/tmp/specrail/run-1",
    },
  ]);

  assert.deepEqual(await readCodexSessionMetadata(sessionsDir, spawnResult.sessionRef), {
    executionId: "run-1",
    sessionRef: "run-1-codex",
    backend: "codex",
    profile: "default",
    workspacePath: "/tmp/specrail/run-1",
    command: {
      command: "codex",
      args: ["exec", "--profile", "default", "Implement the endpoint"],
      cwd: "/tmp/specrail/run-1",
    },
    pid: 4242,
    status: "spawned",
    prompt: "Implement the endpoint",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  });

  await adapter.resume({ sessionRef: spawnResult.sessionRef, prompt: "Continue with tests" });
  await adapter.cancel(spawnResult.sessionRef);

  assert.deepEqual(await readCodexSessionMetadata(sessionsDir, spawnResult.sessionRef), {
    executionId: "run-1",
    sessionRef: "run-1-codex",
    backend: "codex",
    profile: "default",
    workspacePath: "/tmp/specrail/run-1",
    command: {
      command: "codex",
      args: ["exec", "--profile", "default", "Implement the endpoint"],
      cwd: "/tmp/specrail/run-1",
    },
    pid: 4242,
    status: "cancelled",
    prompt: "Continue with tests",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:10:00.000Z",
    resumedAt: "2026-04-09T00:05:00.000Z",
    cancelledAt: "2026-04-09T00:10:00.000Z",
  });
});

test("CodexAdapterStub normalizes lifecycle events into shared execution events", () => {
  const adapter = new CodexAdapterStub({ sessionsDir: "/tmp/specrail-codex" });

  assert.deepEqual(
    adapter.normalize({
      kind: "spawned",
      executionId: "run-1",
      sessionRef: "run-1-codex",
      timestamp: "2026-04-09T00:00:00.000Z",
      command: {
        command: "codex",
        args: ["exec"],
        cwd: "/tmp/specrail/run-1",
      },
    }),
    {
      id: "run-1:spawned:2026-04-09T00:00:00.000Z",
      executionId: "run-1",
      type: "shell_command",
      timestamp: "2026-04-09T00:00:00.000Z",
      source: "codex",
      summary: "Spawned Codex session run-1-codex",
      payload: {
        sessionRef: "run-1-codex",
        command: {
          command: "codex",
          args: ["exec"],
          cwd: "/tmp/specrail/run-1",
        },
      },
    },
  );

  assert.deepEqual(
    adapter.normalize({
      kind: "resumed",
      executionId: "run-1",
      sessionRef: "run-1-codex",
      timestamp: "2026-04-09T00:05:00.000Z",
    }),
    {
      id: "run-1:resumed:2026-04-09T00:05:00.000Z",
      executionId: "run-1",
      type: "task_status_changed",
      timestamp: "2026-04-09T00:05:00.000Z",
      source: "codex",
      summary: "Resumed Codex session run-1-codex",
      payload: {
        sessionRef: "run-1-codex",
        status: "resumed",
      },
    },
  );

  assert.equal(adapter.normalize({ foo: "bar" }), null);
});
