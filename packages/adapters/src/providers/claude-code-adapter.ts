import { spawn as nodeSpawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CommandExecutionMetadata, ExecutionEvent } from "@specrail/core";
import type {
  CancelExecutionInput,
  ExecutorAdapter,
  ExecutorCommandSpec,
  ExecutorSessionMetadata,
  ResumeExecutionInput,
  ResumeExecutionResult,
  SpawnExecutionInput,
  SpawnExecutionResult,
} from "../interfaces/executor-adapter.js";
import {
  CLAUDE_CODE_BACKEND,
  normalizeClaudeCodeEvent,
  normalizeClaudeCodeSessionMetadata,
  type ClaudeCodeLifecycleEvent,
  type ClaudeCodeSessionSnapshot,
} from "./claude-code-contract.js";

interface SpawnedProcessStreamLike {
  on(event: "data", listener: (chunk: string | Buffer) => void): this;
}

interface SpawnedProcessLike {
  pid?: number;
  stdout?: SpawnedProcessStreamLike | null;
  stderr?: SpawnedProcessStreamLike | null;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface ClaudeCliJsonEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  uuid?: string;
}

export interface ClaudeCodeAdapterOptions {
  sessionsDir?: string;
  now?: () => string;
  spawnProcess?: (command: string, args: string[], cwd: string) => SpawnedProcessLike;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  onEvent?: (event: ExecutionEvent) => void | Promise<void>;
}

function buildSessionMetadataPath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.json`);
}

function buildSessionEventsPath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.events.jsonl`);
}

function buildSessionRawOutputPath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.claude-stream.jsonl`);
}

function ensureSessionsDir(sessionsDir: string): void {
  mkdirSync(sessionsDir, { recursive: true });
}

async function writeSessionMetadata(sessionsDir: string, metadata: ExecutorSessionMetadata): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  writeFileSync(buildSessionMetadataPath(sessionsDir, metadata.sessionRef), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readSessionMetadata(sessionsDir: string, sessionRef: string): Promise<ExecutorSessionMetadata> {
  const content = await readFile(buildSessionMetadataPath(sessionsDir, sessionRef), "utf8");
  return JSON.parse(content) as ExecutorSessionMetadata;
}

function writeSessionMetadataSync(sessionsDir: string, metadata: ExecutorSessionMetadata): void {
  ensureSessionsDir(sessionsDir);
  writeFileSync(buildSessionMetadataPath(sessionsDir, metadata.sessionRef), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function readSessionMetadataSync(sessionsDir: string, sessionRef: string): ExecutorSessionMetadata {
  const content = readFileSync(buildSessionMetadataPath(sessionsDir, sessionRef), "utf8");
  return JSON.parse(content) as ExecutorSessionMetadata;
}

function appendSessionEventSync(sessionsDir: string, sessionRef: string, event: ExecutionEvent): void {
  ensureSessionsDir(sessionsDir);
  appendFileSync(buildSessionEventsPath(sessionsDir, sessionRef), `${JSON.stringify(event)}\n`, "utf8");
}

function appendRawOutputSync(sessionsDir: string, sessionRef: string, text: string): void {
  ensureSessionsDir(sessionsDir);
  appendFileSync(buildSessionRawOutputPath(sessionsDir, sessionRef), text, "utf8");
}

function toCommandMetadata(command: ExecutorCommandSpec, prompt: string, sessionRef?: string): CommandExecutionMetadata {
  return {
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    prompt,
    resumeSessionRef: sessionRef,
  };
}

export function buildClaudeCodeSpawnCommand(input: SpawnExecutionInput): ExecutorCommandSpec {
  return buildClaudeCodeSpawnCommandForSessionRef(input, `${input.executionId}-claude`);
}

function buildClaudeCodeSpawnCommandForSessionRef(input: SpawnExecutionInput, sessionRef: string): ExecutorCommandSpec {
  const args = [
    "--permission-mode",
    "bypassPermissions",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
  ];

  if (input.profile && input.profile !== "default") {
    args.push("--model", input.profile);
  }

  args.push("--session-id", deriveClaudeSessionId(sessionRef));
  args.push(input.prompt);

  return {
    command: "claude",
    args,
    cwd: input.workspacePath,
  };
}

function buildClaudeCodeResumeCommand(input: ResumeExecutionInput, metadata: ExecutorSessionMetadata): ExecutorCommandSpec {
  const args = [
    "--permission-mode",
    "bypassPermissions",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--resume",
    input.sessionRef,
  ];

  if (input.profile && input.profile !== "default") {
    args.push("--model", input.profile);
  }

  args.push(input.prompt);

  return {
    command: "claude",
    args,
    cwd: input.workspacePath ?? metadata.workspacePath,
  };
}

function deriveClaudeSessionId(sessionRef: string): string {
  const base = Buffer.from(sessionRef).toString("hex").slice(0, 32).padEnd(32, "0");
  return `${base.slice(0, 8)}-${base.slice(8, 12)}-${base.slice(12, 16)}-${base.slice(16, 20)}-${base.slice(20, 32)}`;
}

function formatClaudeExitFailure(code: number | null, signal: NodeJS.Signals | null): string {
  if (typeof code === "number") {
    return `Claude Code exited with code ${code}`;
  }

  if (signal) {
    return `Claude Code exited from signal ${signal}`;
  }

  return "Claude Code exited unexpectedly";
}

export class ClaudeCodeAdapter implements ExecutorAdapter {
  readonly name = CLAUDE_CODE_BACKEND;

  readonly capabilities = {
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsApprovalBroker: true,
  };

  private readonly sessionsDir: string;
  private readonly now: () => string;
  private readonly spawnProcess: (command: string, args: string[], cwd: string) => SpawnedProcessLike;
  private readonly killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  private readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? path.resolve(process.cwd(), ".specrail-data", "sessions");
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnProcess = options.spawnProcess ?? ((command, args, cwd) => nodeSpawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }));
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.onEvent = options.onEvent;
  }

  async spawn(input: SpawnExecutionInput): Promise<SpawnExecutionResult> {
    const timestamp = this.now();
    const sessionRef = `${input.executionId}-claude`;
    const command = buildClaudeCodeSpawnCommandForSessionRef(input, sessionRef);
    const metadata = normalizeClaudeCodeSessionMetadata({
      executionId: input.executionId,
      sessionRef,
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      profile: input.profile,
      command,
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      sessionId: deriveClaudeSessionId(sessionRef),
      workingDirectory: input.workspacePath,
      transcriptPath: buildSessionRawOutputPath(this.sessionsDir, sessionRef),
    });

    const spawned = this.spawnProcess(command.command, command.args, command.cwd);
    metadata.pid = spawned.pid;
    await writeSessionMetadata(this.sessionsDir, metadata);
    this.attachProcessLifecycle({ executionId: input.executionId, sessionRef, process: spawned });

    const lifecycleEvent = this.normalize({
      kind: "spawned",
      executionId: input.executionId,
      sessionRef,
      timestamp,
      command,
      sessionId: metadata.providerSessionId,
    });

    return {
      sessionRef,
      metadata,
      command: toCommandMetadata(command, input.prompt, metadata.providerSessionId),
      events: [
        {
          id: `${input.executionId}:running:${timestamp}`,
          executionId: input.executionId,
          type: "task_status_changed",
          timestamp,
          source: this.name,
          summary: "Run started",
          payload: { status: "running", sessionRef, pid: spawned.pid },
        },
        ...(lifecycleEvent ? [lifecycleEvent] : []),
      ],
    };
  }

  async resume(input: ResumeExecutionInput): Promise<ResumeExecutionResult> {
    const metadata = await readSessionMetadata(this.sessionsDir, input.sessionRef);
    const timestamp = this.now();
    const resumeSessionRef = metadata.providerSessionId ?? metadata.resumeSessionRef ?? metadata.sessionRef;
    const command = buildClaudeCodeResumeCommand(
      {
        ...input,
        sessionRef: resumeSessionRef,
        workspacePath: input.workspacePath ?? metadata.workspacePath,
        profile: input.profile ?? metadata.profile,
      },
      metadata,
    );
    const spawned = this.spawnProcess(command.command, command.args, command.cwd);
    const updatedMetadata: ExecutorSessionMetadata = {
      ...metadata,
      command,
      pid: spawned.pid,
      prompt: input.prompt,
      resumeSessionRef,
      status: "running",
      resumedAt: timestamp,
      updatedAt: timestamp,
    };

    await writeSessionMetadata(this.sessionsDir, updatedMetadata);
    this.attachProcessLifecycle({ executionId: metadata.executionId, sessionRef: metadata.sessionRef, process: spawned });

    const event = this.normalize({
      kind: "resumed",
      executionId: metadata.executionId,
      sessionRef: metadata.sessionRef,
      timestamp,
      sessionId: updatedMetadata.providerSessionId,
      runId: updatedMetadata.providerInvocationId,
      model: readProviderModel(updatedMetadata),
    });

    return {
      sessionRef: metadata.sessionRef,
      command: toCommandMetadata(command, input.prompt, resumeSessionRef),
      events: event ? [event] : [],
    };
  }

  async cancel(input: CancelExecutionInput | string): Promise<ExecutionEvent> {
    const sessionRef = typeof input === "string" ? input : input.sessionRef;
    const metadata = await readSessionMetadata(this.sessionsDir, sessionRef);
    const timestamp = this.now();

    if (typeof metadata.pid === "number") {
      try {
        this.killProcess(metadata.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }

    const updatedMetadata: ExecutorSessionMetadata = {
      ...metadata,
      status: "cancelled",
      cancelledAt: timestamp,
      finishedAt: metadata.finishedAt ?? timestamp,
      updatedAt: timestamp,
    };
    await writeSessionMetadata(this.sessionsDir, updatedMetadata);

    return normalizeClaudeCodeEvent({
      kind: "cancelled",
      executionId: metadata.executionId,
      sessionRef,
      timestamp,
      sessionId: metadata.providerSessionId,
      runId: metadata.providerInvocationId,
      model: readProviderModel(metadata),
    });
  }

  normalize(rawEvent: unknown): ExecutionEvent | null {
    if (!rawEvent || typeof rawEvent !== "object") {
      return null;
    }

    const event = rawEvent as Partial<ClaudeCodeLifecycleEvent>;
    if (
      !["spawned", "resumed", "cancelled", "stdout", "stderr", "completed", "failed"].includes(event.kind ?? "") ||
      typeof event.executionId !== "string" ||
      typeof event.sessionRef !== "string" ||
      typeof event.timestamp !== "string"
    ) {
      return null;
    }

    return normalizeClaudeCodeEvent(event as ClaudeCodeLifecycleEvent);
  }

  private attachProcessLifecycle(input: {
    executionId: string;
    sessionRef: string;
    process: SpawnedProcessLike;
  }): void {
    const stdoutBuffer = { value: "" };

    input.process.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      appendRawOutputSync(this.sessionsDir, input.sessionRef, text);
      this.captureStructuredStdout(input.executionId, input.sessionRef, stdoutBuffer, text);
      this.persistRuntimeEvent(
        input.executionId,
        input.sessionRef,
        this.normalize({
          kind: "stdout",
          executionId: input.executionId,
          sessionRef: input.sessionRef,
          timestamp: this.now(),
          text,
          sessionId: readSessionMetadataSync(this.sessionsDir, input.sessionRef).providerSessionId,
        }),
      );
    });

    input.process.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      this.persistRuntimeEvent(
        input.executionId,
        input.sessionRef,
        this.normalize({
          kind: "stderr",
          executionId: input.executionId,
          sessionRef: input.sessionRef,
          timestamp: this.now(),
          text,
          sessionId: readSessionMetadataSync(this.sessionsDir, input.sessionRef).providerSessionId,
        }),
      );
    });

    input.process.on("error", (error) => {
      const timestamp = this.now();
      const metadata = readSessionMetadataSync(this.sessionsDir, input.sessionRef);
      writeSessionMetadataSync(this.sessionsDir, {
        ...metadata,
        status: "failed",
        finishedAt: timestamp,
        updatedAt: timestamp,
        failureMessage: error.message,
      });
      this.persistRuntimeEvent(
        input.executionId,
        input.sessionRef,
        this.normalize({
          kind: "failed",
          executionId: input.executionId,
          sessionRef: input.sessionRef,
          timestamp,
          sessionId: metadata.providerSessionId,
          runId: metadata.providerInvocationId,
          model: readProviderModel(metadata),
        }),
      );
    });

    input.process.on("exit", (code, signal) => {
      const timestamp = this.now();
      const metadata = readSessionMetadataSync(this.sessionsDir, input.sessionRef);
      const nextStatus = metadata.status === "cancelled" ? "cancelled" : code === 0 ? "completed" : "failed";
      const failureMessage =
        nextStatus === "failed"
          ? metadata.failureMessage ?? formatClaudeExitFailure(code, signal)
          : metadata.failureMessage;

      writeSessionMetadataSync(this.sessionsDir, {
        ...metadata,
        status: nextStatus,
        exitCode: code,
        signal: signal ?? undefined,
        finishedAt: timestamp,
        updatedAt: timestamp,
        failureMessage,
      });

      if (nextStatus === "completed" || nextStatus === "failed") {
        this.persistRuntimeEvent(
          input.executionId,
          input.sessionRef,
          this.normalize({
            kind: nextStatus,
            executionId: input.executionId,
            sessionRef: input.sessionRef,
            timestamp,
            exitCode: code,
            signal,
            sessionId: metadata.providerSessionId,
            runId: metadata.providerInvocationId,
            model: readProviderModel(metadata),
          }),
        );
      }
    });
  }

  private captureStructuredStdout(executionId: string, sessionRef: string, buffer: { value: string }, chunk: string): void {
    buffer.value += chunk;

    while (true) {
      const newlineIndex = buffer.value.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.value.slice(0, newlineIndex).trim();
      buffer.value = buffer.value.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as ClaudeCliJsonEvent;
        const metadata = readSessionMetadataSync(this.sessionsDir, sessionRef);
        const nextProviderSessionId = typeof parsed.session_id === "string" && parsed.session_id ? parsed.session_id : metadata.providerSessionId;
        const nextModel = typeof parsed.model === "string" && parsed.model ? parsed.model : readProviderModel(metadata);
        const nextRunId = typeof parsed.uuid === "string" && parsed.uuid ? parsed.uuid : metadata.providerInvocationId;

        if (
          nextProviderSessionId !== metadata.providerSessionId ||
          nextRunId !== metadata.providerInvocationId ||
          nextModel !== readProviderModel(metadata)
        ) {
          writeSessionMetadataSync(this.sessionsDir, {
            ...metadata,
            providerSessionId: nextProviderSessionId,
            providerInvocationId: nextRunId,
            resumeSessionRef: nextProviderSessionId ?? metadata.resumeSessionRef,
            providerMetadata: {
              ...(metadata.providerMetadata ?? {}),
              model: nextModel,
              transcriptPath: buildSessionRawOutputPath(this.sessionsDir, sessionRef),
              workingDirectory: metadata.workspacePath,
              lastEventType: parsed.type,
              lastEventSubtype: parsed.subtype,
            },
            updatedAt: this.now(),
          });
        }
      } catch {
        // best-effort only
      }
    }
  }

  private persistRuntimeEvent(executionId: string, sessionRef: string, event: ExecutionEvent | null): void {
    if (!event) {
      return;
    }

    appendSessionEventSync(this.sessionsDir, sessionRef, event);
    void Promise.resolve(this.onEvent?.(event)).catch(() => {
      // best-effort fan-out only
    });
  }
}

function readProviderModel(metadata: ExecutorSessionMetadata): string | undefined {
  const model = metadata.providerMetadata?.model;
  return typeof model === "string" ? model : undefined;
}

export async function readClaudeCodeSessionMetadata(
  sessionsDir: string,
  sessionRef: string,
): Promise<ExecutorSessionMetadata> {
  return readSessionMetadata(sessionsDir, sessionRef);
}

export async function readClaudeCodeSessionEvents(
  sessionsDir: string,
  sessionRef: string,
): Promise<ExecutionEvent[]> {
  const eventsPath = buildSessionEventsPath(sessionsDir, sessionRef);
  if (!existsSync(eventsPath)) {
    return [];
  }

  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExecutionEvent);
}

export async function readClaudeCodeRawOutput(sessionsDir: string, sessionRef: string): Promise<string | null> {
  const rawPath = buildSessionRawOutputPath(sessionsDir, sessionRef);
  if (!existsSync(rawPath)) {
    return null;
  }

  return readFile(rawPath, "utf8");
}
