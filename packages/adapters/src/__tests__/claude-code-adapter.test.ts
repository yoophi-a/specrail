import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeCodeSpawnCommand,
  ClaudeCodeAdapter,
  readClaudeCodeRawOutput,
  readClaudeCodeSessionEvents,
  readClaudeCodeSessionMetadata,
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

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("buildClaudeCodeSpawnCommand uses print stream-json mode and maps non-default profile to model", () => {
  const command = buildClaudeCodeSpawnCommand({
    executionId: "run-claude-1",
    prompt: "Implement the adapter",
    workspacePath: "/tmp/specrail/run-claude-1",
    profile: "claude-sonnet-4",
  });

  assert.equal(command.command, "claude");
  assert.equal(command.cwd, "/tmp/specrail/run-claude-1");
  assert.deepEqual(command.args.slice(0, 8), [
    "--permission-mode",
    "bypassPermissions",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    "claude-sonnet-4",
  ]);
  assert.ok(command.args.includes("--session-id"));
  assert.equal(command.args.at(-1), "Implement the adapter");
});

test("ClaudeCodeAdapter persists process metadata, structured runtime metadata, raw output, and normalized events", async () => {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-claude-sessions-"));
  const child = new FakeChildProcess(5151);
  const spawnedCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const forwardedEvents: Array<{ id: string; summary: string }> = [];
  const timestamps = [
    "2026-04-10T10:00:00.000Z",
    "2026-04-10T10:00:01.000Z",
    "2026-04-10T10:00:02.000Z",
    "2026-04-10T10:00:03.000Z",
    "2026-04-10T10:00:04.000Z",
    "2026-04-10T10:00:05.000Z",
    "2026-04-10T10:00:06.000Z",
  ];

  const adapter = new ClaudeCodeAdapter({
    sessionsDir,
    now: () => timestamps.shift() ?? "2026-04-10T10:00:07.000Z",
    spawnProcess: (command, args, cwd) => {
      spawnedCalls.push({ command, args, cwd });
      return child;
    },
    onEvent: (event) => {
      forwardedEvents.push({ id: event.id, summary: event.summary });
    },
  });

  const spawnResult = await adapter.spawn({
    executionId: "run-claude-1",
    prompt: "Implement the adapter",
    workspacePath: "/tmp/specrail/run-claude-1",
    profile: "default",
  });

  assert.equal(spawnResult.sessionRef, "run-claude-1-claude");
  assert.equal(spawnResult.metadata.status, "running");
  assert.equal(spawnedCalls[0]?.command, "claude");
  assert.deepEqual(spawnResult.events.map((event) => event.summary), [
    "Run started",
    "Spawned Claude Code session run-claude-1-claude",
  ]);

  child.stdout.emitData('{"type":"system","subtype":"init","session_id":"claude-session-123","model":"claude-sonnet-4","uuid":"init-uuid"}\n');
  child.stdout.emitData('{"type":"assistant","session_id":"claude-session-123","uuid":"message-uuid"}\n');
  child.stderr.emitData("warning: approval needed\n");
  child.emit("exit", 0, null);
  await flush();

  const metadata = await readClaudeCodeSessionMetadata(sessionsDir, spawnResult.sessionRef);
  assert.equal(metadata.executionId, "run-claude-1");
  assert.equal(metadata.sessionRef, "run-claude-1-claude");
  assert.equal(metadata.backend, "claude_code");
  assert.equal(metadata.profile, "default");
  assert.equal(metadata.workspacePath, "/tmp/specrail/run-claude-1");
  assert.deepEqual(metadata.command, {
    command: "claude",
    args: spawnedCalls[0]?.args ?? [],
    cwd: "/tmp/specrail/run-claude-1",
  });
  assert.equal(metadata.pid, 5151);
  assert.equal(metadata.providerSessionId, "claude-session-123");
  assert.equal(metadata.providerInvocationId, "message-uuid");
  assert.equal(metadata.resumeSessionRef, "claude-session-123");
  assert.deepEqual(metadata.providerMetadata, {
    model: "claude-sonnet-4",
    transcriptPath: path.join(sessionsDir, "run-claude-1-claude.claude-stream.jsonl"),
    workingDirectory: "/tmp/specrail/run-claude-1",
    lastEventType: "assistant",
  });
  assert.equal(metadata.status, "completed");
  assert.equal(metadata.exitCode, 0);
  assert.ok(metadata.finishedAt);

  const runtimeEvents = await readClaudeCodeSessionEvents(sessionsDir, spawnResult.sessionRef);
  assert.deepEqual(runtimeEvents.map((event) => event.summary), [
    "STDOUT run-claude-1-claude",
    "STDOUT run-claude-1-claude",
    "STDERR run-claude-1-claude",
    "Completed Claude Code session run-claude-1-claude",
  ]);
  assert.deepEqual(forwardedEvents, runtimeEvents.map((event) => ({ id: event.id, summary: event.summary })));

  const rawOutput = await readClaudeCodeRawOutput(sessionsDir, spawnResult.sessionRef);
  assert.match(rawOutput ?? "", /claude-session-123/);
  assert.match(rawOutput ?? "", /message-uuid/);
});

test("ClaudeCodeAdapter resume prefers persisted provider session id and cancel terminates the latest process", async () => {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-claude-sessions-"));
  const spawnChild = new FakeChildProcess(6101);
  const resumeChild = new FakeChildProcess(6102);
  const children = [spawnChild, resumeChild];
  const spawnedCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const timestamps = [
    "2026-04-10T11:00:00.000Z",
    "2026-04-10T11:00:01.000Z",
    "2026-04-10T11:00:02.000Z",
  ];

  const adapter = new ClaudeCodeAdapter({
    sessionsDir,
    now: () => timestamps.shift() ?? "2026-04-10T11:00:03.000Z",
    spawnProcess: (command, args, cwd) => {
      spawnedCalls.push({ command, args, cwd });
      const next = children.shift();
      if (!next) {
        throw new Error("unexpected spawn");
      }
      return next;
    },
    killProcess: (pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    },
  });

  const spawnResult = await adapter.spawn({
    executionId: "run-claude-2",
    prompt: "Initial prompt",
    workspacePath: "/tmp/specrail/run-claude-2",
    profile: "default",
  });

  spawnChild.stdout.emitData('{"type":"system","subtype":"init","session_id":"claude-session-real","uuid":"init-uuid"}\n');
  await flush();

  const resumeResult = await adapter.resume({
    sessionRef: spawnResult.sessionRef,
    prompt: "Continue with tests",
  });

  assert.equal(resumeResult.command.resumeSessionRef, "claude-session-real");
  assert.deepEqual(spawnedCalls[1]?.args.slice(0, 8), [
    "--permission-mode",
    "bypassPermissions",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--resume",
    "claude-session-real",
  ]);

  const cancellationEvent = await adapter.cancel(spawnResult.sessionRef);
  assert.equal(cancellationEvent.summary, "Cancelled Claude Code session run-claude-2-claude");
  assert.deepEqual(killCalls, [{ pid: 6102, signal: "SIGTERM" }]);
  assert.equal((await readClaudeCodeSessionMetadata(sessionsDir, spawnResult.sessionRef)).status, "cancelled");
});

test("ClaudeCodeAdapter records an explicit failure message when Claude exits non-zero", async () => {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-claude-sessions-"));
  const child = new FakeChildProcess(7201);
  const adapter = new ClaudeCodeAdapter({
    sessionsDir,
    now: (() => {
      const timestamps = [
        "2026-04-10T12:30:00.000Z",
        "2026-04-10T12:30:01.000Z",
        "2026-04-10T12:30:02.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-10T12:30:03.000Z";
    })(),
    spawnProcess: () => child,
  });

  const result = await adapter.spawn({
    executionId: "run-claude-4",
    prompt: "Do the thing",
    workspacePath: "/tmp/specrail/run-claude-4",
    profile: "default",
  });

  child.emit("exit", 17, null);
  await flush();

  const metadata = await readClaudeCodeSessionMetadata(sessionsDir, result.sessionRef);
  assert.equal(metadata.status, "failed");
  assert.equal(metadata.failureMessage, "Claude Code exited with code 17");

  const runtimeEvents = await readClaudeCodeSessionEvents(sessionsDir, result.sessionRef);
  assert.equal(runtimeEvents.at(-1)?.summary, "Failed Claude Code session run-claude-4-claude");
});

test("ClaudeCodeAdapter normalizes lifecycle and stream events into shared execution events", () => {
  const adapter = new ClaudeCodeAdapter({ sessionsDir: "/tmp/specrail-claude" });

  assert.deepEqual(
    adapter.normalize({
      kind: "spawned",
      executionId: "run-claude-3",
      sessionRef: "run-claude-3-claude",
      timestamp: "2026-04-10T12:00:00.000Z",
      command: {
        command: "claude",
        args: ["--print"],
        cwd: "/tmp/specrail/run-claude-3",
      },
      sessionId: "claude-session-xyz",
      runId: "run-uuid-1",
      model: "claude-sonnet-4",
    }),
    {
      id: "run-claude-3:spawned:2026-04-10T12:00:00.000Z",
      executionId: "run-claude-3",
      type: "shell_command",
      timestamp: "2026-04-10T12:00:00.000Z",
      source: "claude_code",
      summary: "Spawned Claude Code session run-claude-3-claude",
      payload: {
        sessionRef: "run-claude-3-claude",
        command: {
          command: "claude",
          args: ["--print"],
          cwd: "/tmp/specrail/run-claude-3",
        },
        providerSessionId: "claude-session-xyz",
        providerInvocationId: "run-uuid-1",
        model: "claude-sonnet-4",
      },
    },
  );

  assert.deepEqual(
    adapter.normalize({
      kind: "stdout",
      executionId: "run-claude-3",
      sessionRef: "run-claude-3-claude",
      timestamp: "2026-04-10T12:00:01.000Z",
      text: "hello",
      sessionId: "claude-session-xyz",
    }),
    {
      id: "run-claude-3:stdout:2026-04-10T12:00:01.000Z",
      executionId: "run-claude-3",
      type: "message",
      timestamp: "2026-04-10T12:00:01.000Z",
      source: "claude_code",
      summary: "STDOUT run-claude-3-claude",
      payload: {
        sessionRef: "run-claude-3-claude",
        stream: "stdout",
        text: "hello",
        providerSessionId: "claude-session-xyz",
      },
    },
  );

  assert.deepEqual(
    adapter.normalize({
      kind: "failed",
      executionId: "run-claude-3",
      sessionRef: "run-claude-3-claude",
      timestamp: "2026-04-10T12:00:02.000Z",
      exitCode: 1,
      signal: null,
      sessionId: "claude-session-xyz",
      runId: "run-uuid-2",
      model: "claude-opus-4-6",
    }),
    {
      id: "run-claude-3:failed:2026-04-10T12:00:02.000Z",
      executionId: "run-claude-3",
      type: "task_status_changed",
      timestamp: "2026-04-10T12:00:02.000Z",
      source: "claude_code",
      summary: "Failed Claude Code session run-claude-3-claude",
      payload: {
        sessionRef: "run-claude-3-claude",
        status: "failed",
        exitCode: 1,
        signal: null,
        providerSessionId: "claude-session-xyz",
        providerInvocationId: "run-uuid-2",
        model: "claude-opus-4-6",
      },
    },
  );

  assert.equal(adapter.normalize({ foo: "bar" }), null);
});
