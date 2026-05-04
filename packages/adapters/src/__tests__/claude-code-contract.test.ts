import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CODE_BACKEND,
  CLAUDE_CODE_PROVIDER_CONTRACT,
  normalizeClaudeCodeEvent,
  normalizeClaudeCodeSessionMetadata,
  normalizeClaudeCodeStructuredStreamEvent,
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
      subtype: "claude_spawned",
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
      subtype: "claude_stderr",
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
      subtype: "claude_completed",
      timestamp: "2026-04-10T10:06:00.000Z",
      source: "claude_code",
      summary: "Completed Claude Code session run-claude-2-claude",
      payload: {
        sessionRef: "run-claude-2-claude",
        provider: "claude_code",
        status: "completed",
        terminal: true,
        exitCode: 0,
        signal: null,
        providerSessionId: "claude-session-234",
        providerInvocationId: "claude-run-def",
        model: "claude-sonnet-4",
      },
    },
  );
});

test("normalizeClaudeCodeStructuredStreamEvent promotes Claude stream-json events into richer execution events", () => {
  assert.deepEqual(
    normalizeClaudeCodeStructuredStreamEvent({
      executionId: "run-claude-3",
      sessionRef: "run-claude-3-claude",
      timestamp: "2026-04-10T10:07:00.000Z",
      eventIndex: 1,
      event: {
        type: "assistant",
        session_id: "claude-session-345",
        uuid: "msg-123",
        message: {
          id: "msg-123",
          role: "assistant",
          content: [
            { type: "text", text: "Planning next steps." },
            { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      },
    }),
    [
      {
        id: "run-claude-3:claude:2026-04-10T10:07:00.000Z:1:0:text",
        executionId: "run-claude-3",
        type: "message",
        subtype: "claude_assistant_text",
        timestamp: "2026-04-10T10:07:00.000Z",
        source: "claude_code",
        summary: "Claude message run-claude-3-claude",
        payload: {
          sessionRef: "run-claude-3-claude",
          providerSessionId: "claude-session-345",
          providerInvocationId: "msg-123",
          providerEventType: "assistant",
          providerEventSubtype: undefined,
          role: "assistant",
          messageId: "msg-123",
          text: "Planning next steps.",
          usage: undefined,
          model: undefined,
          parentToolUseId: undefined,
        },
      },
      {
        id: "run-claude-3:claude:2026-04-10T10:07:00.000Z:1:1:tool-call",
        executionId: "run-claude-3",
        type: "tool_call",
        subtype: "claude_tool_call",
        timestamp: "2026-04-10T10:07:00.000Z",
        source: "claude_code",
        summary: "Claude requested tool Bash",
        payload: {
          sessionRef: "run-claude-3-claude",
          providerSessionId: "claude-session-345",
          providerInvocationId: "msg-123",
          providerEventType: "assistant",
          providerEventSubtype: undefined,
          role: "assistant",
          messageId: "msg-123",
          toolUseId: "toolu-1",
          toolName: "Bash",
          toolInput: { command: "ls -la" },
          parentToolUseId: undefined,
        },
      },
    ],
  );

  assert.deepEqual(
    normalizeClaudeCodeStructuredStreamEvent({
      executionId: "run-claude-3",
      sessionRef: "run-claude-3-claude",
      timestamp: "2026-04-10T10:08:00.000Z",
      eventIndex: 2,
      event: {
        type: "result",
        subtype: "error",
        session_id: "claude-session-345",
        is_error: true,
        error: "Permission denied",
        permission_denials: [
          {
            tool_name: "Bash",
            tool_use_id: "toolu-1",
            tool_input: { command: "git fetch origin main" },
          },
        ],
      },
    }),
    [
      {
        id: "run-claude-3:claude:2026-04-10T10:08:00.000Z:2:approval:0",
        executionId: "run-claude-3",
        type: "approval_requested",
        subtype: "claude_permission_denial",
        timestamp: "2026-04-10T10:08:00.000Z",
        source: "claude_code",
        summary: "Claude requested approval for Bash",
        payload: {
          sessionRef: "run-claude-3-claude",
          providerSessionId: "claude-session-345",
          providerInvocationId: undefined,
          providerEventType: "result",
          providerEventSubtype: "error",
          toolName: "Bash",
          toolUseId: "toolu-1",
          toolInput: { command: "git fetch origin main" },
          error: "Permission denied",
        },
      },
      {
        id: "run-claude-3:claude:2026-04-10T10:08:00.000Z:2:result",
        executionId: "run-claude-3",
        type: "summary",
        subtype: "claude_result_error",
        timestamp: "2026-04-10T10:08:00.000Z",
        source: "claude_code",
        summary: "Claude result error run-claude-3-claude",
        payload: {
          sessionRef: "run-claude-3-claude",
          providerSessionId: "claude-session-345",
          providerInvocationId: undefined,
          providerEventType: "result",
          providerEventSubtype: "error",
          result: undefined,
          error: "Permission denied",
          isError: true,
          totalCostUsd: undefined,
          durationMs: undefined,
          durationApiMs: undefined,
          numTurns: undefined,
          usage: undefined,
          modelUsage: undefined,
          permissionDenials: [
            {
              tool_name: "Bash",
              tool_use_id: "toolu-1",
              tool_input: { command: "git fetch origin main" },
            },
          ],
        },
      },
    ],
  );
});
