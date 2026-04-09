import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexSpawnCommand,
  CodexAdapter,
  readCodexSessionEvents,
  readCodexSessionMetadata,
} from "../index.js";

class FakeStream extends EventEmitter {
  emitData(value: string): void {
    this.emit("data", Buffer.from(value, "utf8"));
  }
}

class FakeChildProcess extends EventEmitter {
  pid?: number;
  stdout = new FakeStream();
  stderr = new FakeStream();
  killCalls: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("buildCodexSpawnCommand creates a deterministic codex exec invocation", () => {
  const command = buildCodexSpawnCommand({
    executionId: "run-1",
    prompt: "Implement the endpoint",
    workspacePath: "/tmp/specrail/run-1",
    profile: "default",
  });

  assert.equal(command.command, "codex");
  assert.equal(command.cwd, "/tmp/specrail/run-1");
  assert.deepEqual(command.args.slice(0, 6), [
    "exec",
    "--json",
    "--output-last-message",
    command.args[3],
    "--skip-git-repo-check",
    "--profile",
  ]);
  assert.equal(command.args[6], "default");
  assert.equal(command.args[7], "Implement the endpoint");
  assert.match(command.args[3] ?? "", /run-1-codex\.last-message\.txt$/);
});

test("CodexAdapter persists process metadata, parses session id, records runtime events, and fans them out", async () => {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-codex-sessions-"));
  const child = new FakeChildProcess(4242);
  const spawnedCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const forwardedEvents: Array<{ id: string; summary: string }> = [];
  const timestamps = [
    "2026-04-09T00:00:00.000Z",
    "2026-04-09T00:00:01.000Z",
    "2026-04-09T00:00:02.000Z",
    "2026-04-09T00:00:03.000Z",
    "2026-04-09T00:00:04.000Z",
  ];

  const adapter = new CodexAdapter({
    sessionsDir,
    now: () => timestamps.shift() ?? "2026-04-09T00:00:05.000Z",
    spawnProcess: (command, args, cwd) => {
      spawnedCalls.push({ command, args, cwd });
      return child;
    },
    onEvent: (event) => {
      forwardedEvents.push({ id: event.id, summary: event.summary });
    },
  });

  const spawnResult = await adapter.spawn({
    executionId: "run-1",
    prompt: "Implement the endpoint",
    workspacePath: "/tmp/specrail/run-1",
    profile: "default",
  });

  assert.equal(spawnResult.sessionRef, "run-1-codex");
  assert.equal(spawnResult.metadata.status, "running");
  assert.equal(spawnedCalls[0]?.command, "codex");
  assert.deepEqual(spawnResult.events.map((event) => event.summary), [
    "Run started",
    "Spawned Codex session run-1-codex",
  ]);

  child.stdout.emitData('{"session_id":"codex-session-123","type":"session.started"}\n');
  child.stdout.emitData('{"type":"agent_message"}\n');
  child.stderr.emitData("warning: something minor\n");
  child.emit("exit", 0, null);
  await flush();

  const persistedMetadata = await readCodexSessionMetadata(sessionsDir, spawnResult.sessionRef);
  assert.equal(persistedMetadata.executionId, "run-1");
  assert.equal(persistedMetadata.sessionRef, "run-1-codex");
  assert.equal(persistedMetadata.backend, "codex");
  assert.equal(persistedMetadata.profile, "default");
  assert.equal(persistedMetadata.workspacePath, "/tmp/specrail/run-1");
  assert.deepEqual(persistedMetadata.command, {
    command: "codex",
    args: spawnedCalls[0]?.args ?? [],
    cwd: "/tmp/specrail/run-1",
  });
  assert.equal(persistedMetadata.pid, 4242);
  assert.equal(persistedMetadata.codexSessionId, "codex-session-123");
  assert.equal(persistedMetadata.status, "completed");
  assert.equal(persistedMetadata.prompt, "Implement the endpoint");
  assert.equal(persistedMetadata.createdAt, "2026-04-09T00:00:00.000Z");
  assert.equal(persistedMetadata.startedAt, "2026-04-09T00:00:00.000Z");
  assert.equal(persistedMetadata.exitCode, 0);
  assert.ok(persistedMetadata.updatedAt);
  assert.ok(persistedMetadata.finishedAt);

  const runtimeEvents = await readCodexSessionEvents(sessionsDir, spawnResult.sessionRef);
  assert.deepEqual(runtimeEvents.map((event) => event.summary), [
    "STDOUT run-1-codex",
    "STDOUT run-1-codex",
    "STDERR run-1-codex",
    "Completed Codex session run-1-codex",
  ]);
  assert.deepEqual(forwardedEvents, runtimeEvents.map((event) => ({ id: event.id, summary: event.summary })));
});

test("CodexAdapter resume prefers discovered Codex session id and cancel marks the session cancelled", async () => {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-codex-sessions-"));
  const spawnChild = new FakeChildProcess(1111);
  const resumeChild = new FakeChildProcess(2222);
  const children = [spawnChild, resumeChild];
  const spawnedCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const timestamps = [
    "2026-04-09T00:00:00.000Z",
    "2026-04-09T00:00:01.000Z",
    "2026-04-09T00:00:02.000Z",
  ];

  const adapter = new CodexAdapter({
    sessionsDir,
    now: () => timestamps.shift() ?? "2026-04-09T00:00:03.000Z",
    spawnProcess: (command, args, cwd) => {
      spawnedCalls.push({ command, args, cwd });
      const next = children.shift();
      if (!next) {
        throw new Error("unexpected spawn");
      }
      return next;
    },
  });

  const spawnResult = await adapter.spawn({
    executionId: "run-2",
    prompt: "Initial prompt",
    workspacePath: "/tmp/specrail/run-2",
    profile: "default",
  });

  spawnChild.stdout.emitData('{"session_id":"codex-real-session","type":"session.started"}\n');
  await flush();

  const resumeResult = await adapter.resume({
    sessionRef: spawnResult.sessionRef,
    prompt: "Continue with tests",
  });

  assert.equal(resumeResult.command.resumeSessionRef, "codex-real-session");
  assert.deepEqual(spawnedCalls[1]?.args.slice(0, 7), [
    "exec",
    "resume",
    "--json",
    "--output-last-message",
    spawnedCalls[1]?.args[4],
    "--skip-git-repo-check",
    "codex-real-session",
  ]);

  const originalKill = process.kill;
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push({ pid, signal });
    return true;
  }) as typeof process.kill;

  try {
    const cancellationEvent = await adapter.cancel(spawnResult.sessionRef);
    assert.equal(cancellationEvent.summary, "Cancelled Codex session run-2-codex");
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(killCalls, [{ pid: 2222, signal: "SIGTERM" }]);
  assert.equal((await readCodexSessionMetadata(sessionsDir, spawnResult.sessionRef)).status, "cancelled");
});

test("CodexAdapter normalizes lifecycle and stream events into shared execution events", () => {
  const adapter = new CodexAdapter({ sessionsDir: "/tmp/specrail-codex" });

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
      kind: "stdout",
      executionId: "run-1",
      sessionRef: "run-1-codex",
      timestamp: "2026-04-09T00:00:01.000Z",
      text: "hello",
    }),
    {
      id: "run-1:stdout:2026-04-09T00:00:01.000Z",
      executionId: "run-1",
      type: "message",
      timestamp: "2026-04-09T00:00:01.000Z",
      source: "codex",
      summary: "STDOUT run-1-codex",
      payload: {
        sessionRef: "run-1-codex",
        stream: "stdout",
        text: "hello",
      },
    },
  );

  assert.deepEqual(
    adapter.normalize({
      kind: "failed",
      executionId: "run-1",
      sessionRef: "run-1-codex",
      timestamp: "2026-04-09T00:00:02.000Z",
      exitCode: 1,
      signal: null,
    }),
    {
      id: "run-1:failed:2026-04-09T00:00:02.000Z",
      executionId: "run-1",
      type: "task_status_changed",
      timestamp: "2026-04-09T00:00:02.000Z",
      source: "codex",
      summary: "Failed Codex session run-1-codex",
      payload: {
        sessionRef: "run-1-codex",
        status: "failed",
        exitCode: 1,
        signal: null,
      },
    },
  );

  assert.equal(adapter.normalize({ foo: "bar" }), null);
});
