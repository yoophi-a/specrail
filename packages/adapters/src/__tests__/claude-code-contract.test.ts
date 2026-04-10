import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CODE_BACKEND,
  CLAUDE_CODE_PROVIDER_CONTRACT,
  normalizeClaudeCodeEvent,
  normalizeClaudeCodeSessionMetadata,
} from "../index.js";

test("Claude Code provider contract advertises the shared backend expectations", () => {
  assert.deepEqual(CLAUDE_CODE_PROVIDER_CONTRACT, {
    backend: CLAUDE_CODE_BACKEND,
    displayName: "Claude Code",
    supportsResume: true,
    supportsCancel: true,
    sessionModel: "durable_cli_session",
    eventModel: "structured_stdout_or_log",
  });
});

test("normalizeClaudeCodeSessionMetadata maps provider session fields into shared executor metadata", () => {
  assert.deepEqual(
    normalizeClaudeCodeSessionMetadata({
      executionId: "run-claude-1",
      sessionRef: "run-claude-1-claude",
      prompt: "Implement the adapter",
      workspacePath: "/tmp/specrail/run-claude-1",
      profile: "default",
      command: {
        command: "claude",
        args: ["code", "--json", "Implement the adapter"],
        cwd: "/tmp/specrail/run-claude-1",
      },
      pid: 9001,
      status: "running",
      sessionId: "claude-session-123",
      runId: "claude-run-abc",
      resumeSessionRef: "claude-session-123",
      parentSessionRef: "parent-session-1",
      model: "claude-sonnet-4",
      transcriptPath: "/tmp/specrail/run-claude-1/.claude/transcript.jsonl",
      workingDirectory: "/tmp/specrail/run-claude-1",
      createdAt: "2026-04-10T10:00:00.000Z",
      startedAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:01.000Z",
    }),
    {
      executionId: "run-claude-1",
      sessionRef: "run-claude-1-claude",
      backend: "claude_code",
      profile: "default",
      workspacePath: "/tmp/specrail/run-claude-1",
      command: {
        command: "claude",
        args: ["code", "--json", "Implement the adapter"],
        cwd: "/tmp/specrail/run-claude-1",
      },
      pid: 9001,
      providerSessionId: "claude-session-123",
      providerInvocationId: "claude-run-abc",
      resumeSessionRef: "claude-session-123",
      parentSessionRef: "parent-session-1",
      providerMetadata: {
        model: "claude-sonnet-4",
        transcriptPath: "/tmp/specrail/run-claude-1/.claude/transcript.jsonl",
        workingDirectory: "/tmp/specrail/run-claude-1",
      },
      status: "running",
      prompt: "Implement the adapter",
      createdAt: "2026-04-10T10:00:00.000Z",
      startedAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T10:00:01.000Z",
      resumedAt: undefined,
      cancelledAt: undefined,
      finishedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      failureMessage: undefined,
    },
  );
});

test("normalizeClaudeCodeEvent preserves shared event semantics for lifecycle and log output", () => {
  assert.deepEqual(
    normalizeClaudeCodeEvent({
      kind: "spawned",
      executionId: "run-claude-2",
      sessionRef: "run-claude-2-claude",
      timestamp: "2026-04-10T10:05:00.000Z",
      command: {
        command: "claude",
        args: ["code", "--json"],
        cwd: "/tmp/specrail/run-claude-2",
      },
      sessionId: "claude-session-234",
      runId: "claude-run-def",
      model: "claude-sonnet-4",
    }),
    {
      id: "run-claude-2:spawned:2026-04-10T10:05:00.000Z",
      executionId: "run-claude-2",
      type: "shell_command",
      timestamp: "2026-04-10T10:05:00.000Z",
      source: "claude_code",
      summary: "Spawned Claude Code session run-claude-2-claude",
      payload: {
        sessionRef: "run-claude-2-claude",
        command: {
          command: "claude",
          args: ["code", "--json"],
          cwd: "/tmp/specrail/run-claude-2",
        },
        providerSessionId: "claude-session-234",
        providerInvocationId: "claude-run-def",
        model: "claude-sonnet-4",
      },
    },
  );

  assert.deepEqual(
    normalizeClaudeCodeEvent({
      kind: "stderr",
      executionId: "run-claude-2",
      sessionRef: "run-claude-2-claude",
      timestamp: "2026-04-10T10:05:01.000Z",
      text: "warning: approval needed",
      sessionId: "claude-session-234",
    }),
    {
      id: "run-claude-2:stderr:2026-04-10T10:05:01.000Z",
      executionId: "run-claude-2",
      type: "message",
      timestamp: "2026-04-10T10:05:01.000Z",
      source: "claude_code",
      summary: "STDERR run-claude-2-claude",
      payload: {
        sessionRef: "run-claude-2-claude",
        stream: "stderr",
        text: "warning: approval needed",
        providerSessionId: "claude-session-234",
      },
    },
  );

  assert.deepEqual(
    normalizeClaudeCodeEvent({
      kind: "completed",
      executionId: "run-claude-2",
      sessionRef: "run-claude-2-claude",
      timestamp: "2026-04-10T10:06:00.000Z",
      sessionId: "claude-session-234",
      runId: "claude-run-def",
      model: "claude-sonnet-4",
      exitCode: 0,
      signal: null,
    }),
    {
      id: "run-claude-2:completed:2026-04-10T10:06:00.000Z",
      executionId: "run-claude-2",
      type: "task_status_changed",
      timestamp: "2026-04-10T10:06:00.000Z",
      source: "claude_code",
      summary: "Completed Claude Code session run-claude-2-claude",
      payload: {
        sessionRef: "run-claude-2-claude",
        status: "completed",
        exitCode: 0,
        signal: null,
        providerSessionId: "claude-session-234",
        providerInvocationId: "claude-run-def",
        model: "claude-sonnet-4",
      },
    },
  );
});
