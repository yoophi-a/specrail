import assert from "node:assert/strict";
import test from "node:test";

import { CodexAdapterStub } from "../providers/codex-adapter.stub.js";

test("CodexAdapterStub spawn returns inspectable command metadata and events", async () => {
  const adapter = new CodexAdapterStub({
    now: () => "2026-04-09T04:00:00.000Z",
    environment: { OPENAI_API_KEY: "redacted" },
  });

  const launch = await adapter.spawn({
    executionId: "run-1",
    prompt: "Implement issue #4",
    workspacePath: "/tmp/specrail/run-1",
    profile: "default",
  });

  assert.equal(launch.sessionRef, "run-1:spawn");
  assert.deepEqual(launch.command, {
    command: "codex",
    args: ["exec", "--full-auto", "--sandbox", "workspace-write", "--profile", "default", "Implement issue #4"],
    cwd: "/tmp/specrail/run-1",
    prompt: "Implement issue #4",
    resumeSessionRef: undefined,
    environment: { OPENAI_API_KEY: "redacted" },
  });
  assert.equal(launch.events[0]?.type, "task_status_changed");
  assert.equal(launch.events[1]?.type, "shell_command");
});

test("CodexAdapterStub resume adds resume metadata to the command contract", async () => {
  const adapter = new CodexAdapterStub({ now: () => "2026-04-09T04:00:00.000Z" });

  const launch = await adapter.resume({
    executionId: "run-2",
    sessionRef: "session-abc",
    prompt: "Continue from failure",
    workspacePath: "/tmp/specrail/run-2",
    profile: "debug",
  });

  assert.equal(launch.sessionRef, "session-abc");
  assert.deepEqual(launch.command?.args, [
    "exec",
    "--full-auto",
    "--sandbox",
    "workspace-write",
    "--profile",
    "debug",
    "resume",
    "session-abc",
    "Continue from failure",
  ]);
  assert.equal(launch.command?.resumeSessionRef, "session-abc");
});

test("CodexAdapterStub cancel and normalize map lifecycle and shell events", async () => {
  const adapter = new CodexAdapterStub({ now: () => "2026-04-09T04:00:00.000Z" });

  const cancelEvent = await adapter.cancel({
    executionId: "run-3",
    sessionRef: "session-cancel",
    workspacePath: "/tmp/specrail/run-3",
    profile: "default",
  });

  assert.equal(cancelEvent.type, "task_status_changed");
  assert.match(cancelEvent.summary, /Cancellation requested/);

  const normalizedShell = adapter.normalize({
    executionId: "run-3",
    type: "shell.command",
    timestamp: "2026-04-09T04:01:00.000Z",
    summary: "Spawn command prepared",
    command: "codex",
    args: ["exec", "hello"],
  });

  assert.deepEqual(normalizedShell, {
    id: "run-3:shell.command",
    executionId: "run-3",
    type: "shell_command",
    timestamp: "2026-04-09T04:01:00.000Z",
    source: "codex",
    summary: "Spawn command prepared",
    payload: {
      command: "codex",
      args: ["exec", "hello"],
    },
  });

  const normalizedLifecycle = adapter.normalize({
    executionId: "run-3",
    type: "session.started",
    timestamp: "2026-04-09T04:01:00.000Z",
    summary: "Run started",
  });

  assert.equal(normalizedLifecycle?.type, "task_status_changed");
  assert.equal(adapter.normalize({ nope: true }), null);
});
