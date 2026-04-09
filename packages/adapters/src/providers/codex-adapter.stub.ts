import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface SpawnedProcessStreamLike {
  on(event: "data", listener: (chunk: string | Buffer) => void): this;
}

interface SpawnedProcessLike {
  pid?: number;
  stdout?: SpawnedProcessStreamLike | null;
  stderr?: SpawnedProcessStreamLike | null;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill?(signal?: NodeJS.Signals | number): boolean;
}

export interface CodexLifecycleEvent {
  kind:
    | "spawned"
    | "resumed"
    | "cancelled"
    | "stdout"
    | "stderr"
    | "completed"
    | "failed";
  executionId: string;
  sessionRef: string;
  timestamp: string;
  command?: ExecutorCommandSpec;
  text?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface CodexAdapterOptions {
  sessionsDir?: string;
  now?: () => string;
  spawnProcess?: (command: string, args: string[], cwd: string) => SpawnedProcessLike;
  onEvent?: (event: ExecutionEvent) => void | Promise<void>;
}

interface CodexJsonEvent {
  id?: string;
  session_id?: string;
  sessionId?: string;
  thread_id?: string;
  threadId?: string;
  conversation_id?: string;
  conversationId?: string;
  type?: string;
  msg?: {
    id?: string;
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

function buildSessionMetadataPath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.json`);
}

function buildSessionEventsPath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.events.jsonl`);
}

function buildSessionLastMessagePath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.last-message.txt`);
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

function readCodexSessionId(event: CodexJsonEvent): string | undefined {
  const candidate = event.session_id ?? event.sessionId ?? event.thread_id ?? event.threadId ?? event.conversation_id ?? event.conversationId ?? event.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
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

export function buildCodexSpawnCommand(input: SpawnExecutionInput): ExecutorCommandSpec {
  const sessionRef = `${input.executionId}-codex`;
  return {
    command: "codex",
    args: buildCodexSpawnArgs(input, path.resolve(process.cwd(), ".specrail-data", "sessions"), sessionRef),
    cwd: input.workspacePath,
  };
}

function buildCodexSpawnCommandForSessionsDir(input: SpawnExecutionInput, sessionsDir: string): ExecutorCommandSpec {
  const sessionRef = `${input.executionId}-codex`;
  return {
    command: "codex",
    args: buildCodexSpawnArgs(input, sessionsDir, sessionRef),
    cwd: input.workspacePath,
  };
}

function buildCodexSpawnArgs(input: SpawnExecutionInput, sessionsDir: string, sessionRef: string): string[] {
  const args = [
    "exec",
    "--json",
    "--output-last-message",
    buildSessionLastMessagePath(sessionsDir, sessionRef),
    "--skip-git-repo-check",
  ];

  if (input.profile && input.profile !== "default") {
    args.push("--profile", input.profile);
  }

  args.push(input.prompt);
  return args;
}

function buildCodexResumeCommand(input: ResumeExecutionInput, sessionsDir: string, sessionRef: string): ExecutorCommandSpec {
  const lastMessagePath = buildSessionLastMessagePath(sessionsDir, sessionRef);
  const actualSessionRef = input.sessionRef;

  return {
    command: "codex",
    args: [
      "exec",
      "resume",
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--skip-git-repo-check",
      actualSessionRef,
      input.prompt,
    ],
    cwd: input.workspacePath ?? process.cwd(),
  };
}

export class CodexAdapter implements ExecutorAdapter {
  readonly name = "codex";

  readonly capabilities = {
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsApprovalBroker: true,
  };

  private readonly sessionsDir: string;
  private readonly now: () => string;
  private readonly spawnProcess: (command: string, args: string[], cwd: string) => SpawnedProcessLike;
  private readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;

  constructor(options: CodexAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? path.resolve(process.cwd(), ".specrail-data", "sessions");
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnProcess = options.spawnProcess ?? ((command, args, cwd) => nodeSpawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }));
    this.onEvent = options.onEvent;
  }

  async spawn(input: SpawnExecutionInput): Promise<SpawnExecutionResult> {
    const timestamp = this.now();
    const sessionRef = `${input.executionId}-codex`;
    const command = buildCodexSpawnCommandForSessionsDir(input, this.sessionsDir);
    const metadata: ExecutorSessionMetadata = {
      executionId: input.executionId,
      sessionRef,
      backend: this.name,
      profile: input.profile,
      workspacePath: input.workspacePath,
      command,
      status: "running",
      prompt: input.prompt,
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    };

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
    });

    return {
      sessionRef,
      metadata,
      command: toCommandMetadata(command, input.prompt),
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
    const resumeSessionRef = metadata.codexSessionId ?? metadata.sessionRef;
    const command = buildCodexResumeCommand(
      {
        ...input,
        sessionRef: resumeSessionRef,
        workspacePath: input.workspacePath ?? metadata.workspacePath,
      },
      this.sessionsDir,
      metadata.sessionRef,
    );
    const spawned = this.spawnProcess(command.command, command.args, command.cwd);
    const updatedMetadata: ExecutorSessionMetadata = {
      ...metadata,
      command,
      pid: spawned.pid,
      prompt: input.prompt,
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
        process.kill(metadata.pid, "SIGTERM");
      } catch {
        // Process may already be gone. Preserve cancellation state anyway.
      }
    }

    await writeSessionMetadata(this.sessionsDir, {
      ...metadata,
      status: "cancelled",
      cancelledAt: timestamp,
      finishedAt: metadata.finishedAt ?? timestamp,
      updatedAt: timestamp,
    });

    return {
      id: `${metadata.executionId}:cancelled:${timestamp}`,
      executionId: metadata.executionId,
      type: "task_status_changed",
      timestamp,
      source: this.name,
      summary: `Cancelled Codex session ${sessionRef}`,
      payload: {
        sessionRef,
        status: "cancelled",
      },
    };
  }

  normalize(rawEvent: unknown): ExecutionEvent | null {
    if (!rawEvent || typeof rawEvent !== "object") {
      return null;
    }

    const event = rawEvent as Partial<CodexLifecycleEvent>;

    if (
      ![
        "spawned",
        "resumed",
        "cancelled",
        "stdout",
        "stderr",
        "completed",
        "failed",
      ].includes(event.kind ?? "") ||
      typeof event.executionId !== "string" ||
      typeof event.sessionRef !== "string" ||
      typeof event.timestamp !== "string"
    ) {
      return null;
    }

    if (event.kind === "spawned") {
      return {
        id: `${event.executionId}:${event.kind}:${event.timestamp}`,
        executionId: event.executionId,
        type: "shell_command",
        timestamp: event.timestamp,
        source: this.name,
        summary: `Spawned Codex session ${event.sessionRef}`,
        payload: {
          sessionRef: event.sessionRef,
          command: event.command,
        },
      };
    }

    if (event.kind === "stdout" || event.kind === "stderr") {
      return {
        id: `${event.executionId}:${event.kind}:${event.timestamp}`,
        executionId: event.executionId,
        type: "message",
        timestamp: event.timestamp,
        source: this.name,
        summary: `${event.kind.toUpperCase()} ${event.sessionRef}`,
        payload: {
          sessionRef: event.sessionRef,
          stream: event.kind,
          text: event.text,
        },
      };
    }

    if (event.kind === "completed" || event.kind === "failed") {
      return {
        id: `${event.executionId}:${event.kind}:${event.timestamp}`,
        executionId: event.executionId,
        type: "task_status_changed",
        timestamp: event.timestamp,
        source: this.name,
        summary: `${event.kind === "completed" ? "Completed" : "Failed"} Codex session ${event.sessionRef}`,
        payload: {
          sessionRef: event.sessionRef,
          status: event.kind === "completed" ? "completed" : "failed",
          exitCode: event.exitCode,
          signal: event.signal,
        },
      };
    }

    return {
      id: `${event.executionId}:${event.kind}:${event.timestamp}`,
      executionId: event.executionId,
      type: "task_status_changed",
      timestamp: event.timestamp,
      source: this.name,
      summary: `${event.kind === "resumed" ? "Resumed" : "Cancelled"} Codex session ${event.sessionRef}`,
      payload: {
        sessionRef: event.sessionRef,
        status: event.kind,
      },
    };
  }

  private attachProcessLifecycle(input: {
    executionId: string;
    sessionRef: string;
    process: SpawnedProcessLike;
  }): void {
    const stdoutBuffer = { value: "" };

    input.process.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
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
        }),
      );
    });

    input.process.on("exit", (code, signal) => {
      const timestamp = this.now();
      const metadata = readSessionMetadataSync(this.sessionsDir, input.sessionRef);
      const nextStatus = metadata.status === "cancelled" ? "cancelled" : code === 0 ? "completed" : "failed";
      writeSessionMetadataSync(this.sessionsDir, {
        ...metadata,
        status: nextStatus,
        exitCode: code,
        signal: signal ?? undefined,
        finishedAt: timestamp,
        updatedAt: timestamp,
      });

      if (nextStatus === "completed" || nextStatus === "failed") {
        this.persistRuntimeEvent(
          input.executionId,
          input.sessionRef,
          this.normalize({
            kind: nextStatus === "completed" ? "completed" : "failed",
            executionId: input.executionId,
            sessionRef: input.sessionRef,
            timestamp,
            exitCode: code,
            signal,
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
        const parsed = JSON.parse(line) as CodexJsonEvent;
        const codexSessionId = readCodexSessionId(parsed);
        if (codexSessionId) {
          const metadata = readSessionMetadataSync(this.sessionsDir, sessionRef);
          if (metadata.codexSessionId !== codexSessionId) {
            writeSessionMetadataSync(this.sessionsDir, {
              ...metadata,
              codexSessionId,
              updatedAt: this.now(),
            });
          }
        }
      } catch {
        // Best-effort only. Raw stdout is still persisted as an event.
      }
    }
  }

  private persistRuntimeEvent(executionId: string, sessionRef: string, event: ExecutionEvent | null): void {
    if (!event) {
      return;
    }

    appendSessionEventSync(this.sessionsDir, sessionRef, event);
    void Promise.resolve(this.onEvent?.(event)).catch(() => {
      // Best-effort fan-out only. Session logs stay authoritative for adapter-local recovery.
    });
  }
}

export const CodexAdapterStub = CodexAdapter;

export async function readCodexSessionMetadata(
  sessionsDir: string,
  sessionRef: string,
): Promise<ExecutorSessionMetadata> {
  return readSessionMetadata(sessionsDir, sessionRef);
}

export async function readCodexSessionEvents(
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

export async function readCodexLastMessage(sessionsDir: string, sessionRef: string): Promise<string | null> {
  const lastMessagePath = buildSessionLastMessagePath(sessionsDir, sessionRef);
  if (!existsSync(lastMessagePath)) {
    return null;
  }

  return readFile(lastMessagePath, "utf8");
}

export type { ChildProcessWithoutNullStreams };
