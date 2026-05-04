import type { ExecutionEvent } from "@specrail/core";

import type {
  ExecutionBackend,
  ExecutorCommandSpec,
  ExecutorSessionMetadata,
  SpawnExecutionInput,
} from "../interfaces/executor-adapter.js";

export const CLAUDE_CODE_BACKEND: ExecutionBackend = "claude_code";

export interface ClaudeCodeProviderContract {
  backend: typeof CLAUDE_CODE_BACKEND;
  displayName: "Claude Code";
  supportsResume: true;
  supportsCancel: true;
  sessionModel: "durable_cli_session";
  eventModel: "structured_stdout_or_log";
}

export const CLAUDE_CODE_PROVIDER_CONTRACT: ClaudeCodeProviderContract = {
  backend: CLAUDE_CODE_BACKEND,
  displayName: "Claude Code",
  supportsResume: true,
  supportsCancel: true,
  sessionModel: "durable_cli_session",
  eventModel: "structured_stdout_or_log",
};

export type ClaudeCodeSessionStatus = ExecutorSessionMetadata["status"];

export interface ClaudeCodeSessionSnapshot {
  executionId: string;
  sessionRef: string;
  prompt: string;
  workspacePath: string;
  profile: string;
  command: ExecutorCommandSpec;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  resumedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  pid?: number;
  status: ClaudeCodeSessionStatus;
  sessionId?: string;
  runId?: string;
  resumeSessionRef?: string;
  parentSessionRef?: string;
  model?: string;
  transcriptPath?: string;
  workingDirectory?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  failureMessage?: string;
}

export interface ClaudeCodeStartContract extends SpawnExecutionInput {
  backend?: typeof CLAUDE_CODE_BACKEND;
  cwd?: string;
}

export interface ClaudeCodeResumeContract {
  executionId?: string;
  sessionRef: string;
  prompt: string;
  workspacePath?: string;
  profile?: string;
  providerSessionId?: string;
}

export interface ClaudeCodeCancelContract {
  executionId?: string;
  sessionRef: string;
  providerSessionId?: string;
}

export interface ClaudeCodeLifecycleEvent {
  kind: "spawned" | "resumed" | "cancelled" | "stdout" | "stderr" | "completed" | "failed";
  executionId: string;
  sessionRef: string;
  timestamp: string;
  text?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  command?: ExecutorCommandSpec;
  sessionId?: string;
  runId?: string;
  model?: string;
}

export interface ClaudeCodeStructuredMessage {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  usage?: Record<string, unknown>;
  content?: ClaudeCodeStructuredContentBlock[];
}

export interface ClaudeCodeStructuredContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

export interface ClaudeCodeStreamJsonEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  uuid?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{ name?: string; status?: string }>;
  permissionMode?: string;
  apiKeySource?: string;
  parent_tool_use_id?: string;
  message?: ClaudeCodeStructuredMessage;
  result?: string;
  is_error?: boolean;
  error?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: Array<{
    tool_name?: string;
    tool_use_id?: string;
    tool_input?: Record<string, unknown>;
  }>;
}

export function normalizeClaudeCodeSessionMetadata(snapshot: ClaudeCodeSessionSnapshot): ExecutorSessionMetadata {
  return {
    executionId: snapshot.executionId,
    sessionRef: snapshot.sessionRef,
    backend: CLAUDE_CODE_BACKEND,
    profile: snapshot.profile,
    workspacePath: snapshot.workspacePath,
    command: snapshot.command,
    pid: snapshot.pid,
    providerSessionId: snapshot.sessionId,
    providerInvocationId: snapshot.runId,
    resumeSessionRef: snapshot.resumeSessionRef ?? snapshot.sessionId,
    parentSessionRef: snapshot.parentSessionRef,
    providerMetadata: {
      model: snapshot.model,
      transcriptPath: snapshot.transcriptPath,
      workingDirectory: snapshot.workingDirectory ?? snapshot.workspacePath,
    },
    status: snapshot.status,
    prompt: snapshot.prompt,
    createdAt: snapshot.createdAt,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    resumedAt: snapshot.resumedAt,
    cancelledAt: snapshot.cancelledAt,
    finishedAt: snapshot.finishedAt,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    failureMessage: snapshot.failureMessage,
  };
}

export function normalizeClaudeCodeEvent(event: ClaudeCodeLifecycleEvent): ExecutionEvent {
  if (event.kind === "spawned") {
    return {
      id: `${event.executionId}:${event.kind}:${event.timestamp}`,
      executionId: event.executionId,
      type: "shell_command",
      subtype: "claude_spawned",
      timestamp: event.timestamp,
      source: CLAUDE_CODE_BACKEND,
      summary: `Spawned Claude Code session ${event.sessionRef}`,
      payload: {
        sessionRef: event.sessionRef,
        command: event.command,
        providerSessionId: event.sessionId,
        providerInvocationId: event.runId,
        model: event.model,
      },
    };
  }

  if (event.kind === "stdout" || event.kind === "stderr") {
    return {
      id: `${event.executionId}:${event.kind}:${event.timestamp}`,
      executionId: event.executionId,
      type: "message",
      subtype: `claude_${event.kind}`,
      timestamp: event.timestamp,
      source: CLAUDE_CODE_BACKEND,
      summary: `${event.kind.toUpperCase()} ${event.sessionRef}`,
      payload: {
        sessionRef: event.sessionRef,
        stream: event.kind,
        text: event.text,
        providerSessionId: event.sessionId,
      },
    };
  }

  return {
    id: `${event.executionId}:${event.kind}:${event.timestamp}`,
    executionId: event.executionId,
    type: "task_status_changed",
    subtype: `claude_${event.kind}`,
    timestamp: event.timestamp,
    source: CLAUDE_CODE_BACKEND,
    summary: `${toLifecycleVerb(event.kind)} Claude Code session ${event.sessionRef}`,
    payload: {
      sessionRef: event.sessionRef,
      provider: CLAUDE_CODE_BACKEND,
      status: event.kind,
      terminal: ["completed", "failed", "cancelled"].includes(event.kind),
      exitCode: event.exitCode,
      signal: event.signal,
      providerSessionId: event.sessionId,
      providerInvocationId: event.runId,
      model: event.model,
    },
  };
}

export function normalizeClaudeCodeStructuredStreamEvent(input: {
  executionId: string;
  sessionRef: string;
  timestamp: string;
  event: ClaudeCodeStreamJsonEvent;
  eventIndex?: number;
}): ExecutionEvent[] {
  const basePayload = {
    sessionRef: input.sessionRef,
    providerSessionId: input.event.session_id,
    providerInvocationId: input.event.uuid,
    providerEventType: input.event.type,
    providerEventSubtype: input.event.subtype,
  };
  const idPrefix = `${input.executionId}:claude:${input.timestamp}:${input.eventIndex ?? 0}`;

  if (input.event.type === "system" && input.event.subtype === "init") {
    return [
      {
        id: `${idPrefix}:init`,
        executionId: input.executionId,
        type: "summary",
        subtype: "claude_init",
        timestamp: input.timestamp,
        source: CLAUDE_CODE_BACKEND,
        summary: `Initialized Claude Code session ${input.sessionRef}`,
        payload: {
          ...basePayload,
          cwd: input.event.cwd,
          model: input.event.model,
          permissionMode: input.event.permissionMode,
          apiKeySource: input.event.apiKeySource,
          tools: input.event.tools,
          mcpServers: input.event.mcp_servers,
        },
      },
    ];
  }

  if (input.event.type === "assistant" || input.event.type === "user") {
    return normalizeClaudeMessageEvent({
      executionId: input.executionId,
      sessionRef: input.sessionRef,
      timestamp: input.timestamp,
      eventIndex: input.eventIndex ?? 0,
      event: input.event,
      basePayload,
    });
  }

  if (input.event.type === "result") {
    return normalizeClaudeResultEvent({
      executionId: input.executionId,
      sessionRef: input.sessionRef,
      timestamp: input.timestamp,
      eventIndex: input.eventIndex ?? 0,
      event: input.event,
      basePayload,
    });
  }

  return [];
}

function normalizeClaudeMessageEvent(input: {
  executionId: string;
  sessionRef: string;
  timestamp: string;
  eventIndex: number;
  event: ClaudeCodeStreamJsonEvent;
  basePayload: Record<string, unknown>;
}): ExecutionEvent[] {
  const message = input.event.message;
  const messageId = message?.id;
  const contentBlocks = Array.isArray(message?.content) ? message.content : [];
  const events: ExecutionEvent[] = [];

  contentBlocks.forEach((block, contentIndex) => {
    const blockId = `${input.executionId}:claude:${input.timestamp}:${input.eventIndex}:${contentIndex}`;

    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({
        id: `${blockId}:text`,
        executionId: input.executionId,
        type: "message",
        subtype: input.event.type === "assistant" ? "claude_assistant_text" : "claude_user_text",
        timestamp: input.timestamp,
        source: CLAUDE_CODE_BACKEND,
        summary: `${input.event.type === "assistant" ? "Claude" : "User"} message ${input.sessionRef}`,
        payload: {
          ...input.basePayload,
          role: message?.role,
          messageId,
          text: block.text,
          usage: message?.usage,
          model: message?.model ?? input.event.model,
          parentToolUseId: input.event.parent_tool_use_id,
        },
      });
      return;
    }

    if (block?.type === "tool_use") {
      events.push({
        id: `${blockId}:tool-call`,
        executionId: input.executionId,
        type: "tool_call",
        subtype: "claude_tool_call",
        timestamp: input.timestamp,
        source: CLAUDE_CODE_BACKEND,
        summary: `Claude requested tool ${block.name ?? "unknown"}`,
        payload: {
          ...input.basePayload,
          role: message?.role,
          messageId,
          toolUseId: block.id,
          toolName: block.name,
          toolInput: block.input,
          parentToolUseId: input.event.parent_tool_use_id,
        },
      });
      return;
    }

    if (block?.type === "tool_result") {
      events.push({
        id: `${blockId}:tool-result`,
        executionId: input.executionId,
        type: "tool_result",
        subtype: "claude_tool_result",
        timestamp: input.timestamp,
        source: CLAUDE_CODE_BACKEND,
        summary: `Claude received tool result ${block.tool_use_id ?? "unknown"}`,
        payload: {
          ...input.basePayload,
          role: message?.role,
          messageId,
          toolUseId: block.tool_use_id,
          content: block.content,
          parentToolUseId: input.event.parent_tool_use_id,
        },
      });
    }
  });

  return events;
}

function normalizeClaudeResultEvent(input: {
  executionId: string;
  sessionRef: string;
  timestamp: string;
  eventIndex: number;
  event: ClaudeCodeStreamJsonEvent;
  basePayload: Record<string, unknown>;
}): ExecutionEvent[] {
  const resultEvents: ExecutionEvent[] = [];
  const denials = Array.isArray(input.event.permission_denials) ? input.event.permission_denials : [];

  denials.forEach((denial, denialIndex) => {
    resultEvents.push({
      id: `${input.executionId}:claude:${input.timestamp}:${input.eventIndex}:approval:${denialIndex}`,
      executionId: input.executionId,
      type: "approval_requested",
      subtype: "claude_permission_denial",
      timestamp: input.timestamp,
      source: CLAUDE_CODE_BACKEND,
      summary: `Claude requested approval for ${denial.tool_name ?? "tool"}`,
      payload: {
        ...input.basePayload,
        toolName: denial.tool_name,
        toolUseId: denial.tool_use_id,
        toolInput: denial.tool_input,
        error: input.event.error,
      },
    });
  });

  resultEvents.push({
    id: `${input.executionId}:claude:${input.timestamp}:${input.eventIndex}:result`,
    executionId: input.executionId,
    type: "summary",
    subtype: `claude_result_${input.event.subtype ?? (input.event.is_error ? "error" : "success")}`,
    timestamp: input.timestamp,
    source: CLAUDE_CODE_BACKEND,
    summary: input.event.is_error ? `Claude result error ${input.sessionRef}` : `Claude result ${input.sessionRef}`,
    payload: {
      ...input.basePayload,
      result: input.event.result,
      error: input.event.error,
      isError: input.event.is_error,
      totalCostUsd: input.event.total_cost_usd,
      durationMs: input.event.duration_ms,
      durationApiMs: input.event.duration_api_ms,
      numTurns: input.event.num_turns,
      usage: input.event.usage,
      modelUsage: input.event.modelUsage,
      permissionDenials: denials,
    },
  });

  return resultEvents;
}

function toLifecycleVerb(kind: ClaudeCodeLifecycleEvent["kind"]): string {
  switch (kind) {
    case "resumed":
      return "Resumed";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Updated";
  }
}
