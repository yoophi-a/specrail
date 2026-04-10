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
    timestamp: event.timestamp,
    source: CLAUDE_CODE_BACKEND,
    summary: `${toLifecycleVerb(event.kind)} Claude Code session ${event.sessionRef}`,
    payload: {
      sessionRef: event.sessionRef,
      status: event.kind,
      exitCode: event.exitCode,
      signal: event.signal,
      providerSessionId: event.sessionId,
      providerInvocationId: event.runId,
      model: event.model,
    },
  };
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
