import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodexStructuredStreamEvent } from "../index.js";

test("normalizeCodexStructuredStreamEvent promotes assistant text into shared message events", () => {
  assert.deepEqual(
    normalizeCodexStructuredStreamEvent({
      executionId: "run-codex-1",
      sessionRef: "run-codex-1-codex",
      timestamp: "2026-07-20T10:00:00.000Z",
      eventIndex: 1,
      event: {
        id: "msg-1",
        session_id: "codex-session-123",
        type: "agent_message",
        msg: {
          id: "assistant-msg-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I will inspect the files." }],
        },
      },
    }),
    [
      {
        id: "run-codex-1:codex:2026-07-20T10:00:00.000Z:1:0:text",
        executionId: "run-codex-1",
        type: "message",
        subtype: "codex_assistant_text",
        timestamp: "2026-07-20T10:00:00.000Z",
        source: "codex",
        summary: "Codex message run-codex-1-codex",
        payload: {
          sessionRef: "run-codex-1-codex",
          providerSessionId: "codex-session-123",
          providerInvocationId: "msg-1",
          providerEventType: "agent_message",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "I will inspect the files.",
          contentType: "output_text",
        },
      },
    ],
  );
});

test("normalizeCodexStructuredStreamEvent promotes tool calls and results into shared tool events", () => {
  assert.deepEqual(
    normalizeCodexStructuredStreamEvent({
      executionId: "run-codex-2",
      sessionRef: "run-codex-2-codex",
      timestamp: "2026-07-20T10:01:00.000Z",
      eventIndex: 2,
      event: {
        id: "tool-event-1",
        session_id: "codex-session-234",
        type: "function_call",
        name: "shell",
        call_id: "call-1",
        arguments: { cmd: "pnpm test" },
      },
    }),
    [
      {
        id: "run-codex-2:codex:2026-07-20T10:01:00.000Z:2:tool-call",
        executionId: "run-codex-2",
        type: "tool_call",
        subtype: "codex_tool_call",
        timestamp: "2026-07-20T10:01:00.000Z",
        source: "codex",
        summary: "Codex requested tool shell",
        payload: {
          sessionRef: "run-codex-2-codex",
          providerSessionId: "codex-session-234",
          providerInvocationId: "tool-event-1",
          providerEventType: "function_call",
          messageId: "tool-event-1",
          role: undefined,
          toolUseId: "call-1",
          toolName: "shell",
          toolInput: { cmd: "pnpm test" },
        },
      },
    ],
  );

  assert.deepEqual(
    normalizeCodexStructuredStreamEvent({
      executionId: "run-codex-2",
      sessionRef: "run-codex-2-codex",
      timestamp: "2026-07-20T10:01:01.000Z",
      eventIndex: 3,
      event: {
        id: "tool-result-1",
        session_id: "codex-session-234",
        type: "function_call_output",
        call_id: "call-1",
        output: "ok",
      },
    }),
    [
      {
        id: "run-codex-2:codex:2026-07-20T10:01:01.000Z:3:tool-result",
        executionId: "run-codex-2",
        type: "tool_result",
        subtype: "codex_tool_result",
        timestamp: "2026-07-20T10:01:01.000Z",
        source: "codex",
        summary: "Codex received tool result call-1",
        payload: {
          sessionRef: "run-codex-2-codex",
          providerSessionId: "codex-session-234",
          providerInvocationId: "tool-result-1",
          providerEventType: "function_call_output",
          messageId: "tool-result-1",
          role: undefined,
          toolUseId: "call-1",
          content: "ok",
        },
      },
    ],
  );
});

test("normalizeCodexStructuredStreamEvent promotes result events into shared status summaries", () => {
  assert.deepEqual(
    normalizeCodexStructuredStreamEvent({
      executionId: "run-codex-3",
      sessionRef: "run-codex-3-codex",
      timestamp: "2026-07-20T10:02:00.000Z",
      eventIndex: 4,
      event: {
        id: "result-1",
        session_id: "codex-session-345",
        type: "result",
        output: { status: "done" },
      },
    }),
    [
      {
        id: "run-codex-3:codex:2026-07-20T10:02:00.000Z:4:result",
        executionId: "run-codex-3",
        type: "summary",
        subtype: "codex_result_success",
        timestamp: "2026-07-20T10:02:00.000Z",
        source: "codex",
        summary: "Codex result run-codex-3-codex",
        status: "completed",
        payload: {
          sessionRef: "run-codex-3-codex",
          providerSessionId: "codex-session-345",
          providerInvocationId: "result-1",
          providerEventType: "result",
          messageId: "result-1",
          role: undefined,
          result: { status: "done" },
          error: undefined,
        },
      },
    ],
  );

  assert.deepEqual(
    normalizeCodexStructuredStreamEvent({
      executionId: "run-codex-3",
      sessionRef: "run-codex-3-codex",
      timestamp: "2026-07-20T10:02:01.000Z",
      eventIndex: 5,
      event: {
        id: "result-2",
        session_id: "codex-session-345",
        type: "turn.failed",
        error: "Permission denied",
      },
    }),
    [
      {
        id: "run-codex-3:codex:2026-07-20T10:02:01.000Z:5:result",
        executionId: "run-codex-3",
        type: "summary",
        subtype: "codex_result_error",
        timestamp: "2026-07-20T10:02:01.000Z",
        source: "codex",
        summary: "Codex result error run-codex-3-codex",
        status: "failed",
        payload: {
          sessionRef: "run-codex-3-codex",
          providerSessionId: "codex-session-345",
          providerInvocationId: "result-2",
          providerEventType: "turn.failed",
          messageId: "result-2",
          role: undefined,
          result: undefined,
          error: "Permission denied",
        },
      },
    ],
  );
});
