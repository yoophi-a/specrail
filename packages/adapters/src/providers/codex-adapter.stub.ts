import { mkdir, readFile, writeFile } from "node:fs/promises";
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

interface SpawnedProcessLike {
  pid?: number;
}

export interface CodexLifecycleEvent {
  kind: "spawned" | "resumed" | "cancelled";
  executionId: string;
  sessionRef: string;
  timestamp: string;
  command?: ExecutorCommandSpec;
}

export interface CodexAdapterOptions {
  sessionsDir?: string;
  now?: () => string;
  spawnProcess?: (command: string, args: string[], cwd: string) => SpawnedProcessLike;
}

function buildSessionMetadataPath(sessionsDir: string, sessionRef: string): string {
  return path.join(sessionsDir, `${sessionRef}.json`);
}

async function writeSessionMetadata(sessionsDir: string, metadata: ExecutorSessionMetadata): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(buildSessionMetadataPath(sessionsDir, metadata.sessionRef), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readSessionMetadata(sessionsDir: string, sessionRef: string): Promise<ExecutorSessionMetadata> {
  const content = await readFile(buildSessionMetadataPath(sessionsDir, sessionRef), "utf8");
  return JSON.parse(content) as ExecutorSessionMetadata;
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
  return {
    command: "codex",
    args: ["exec", "--profile", input.profile, input.prompt],
    cwd: input.workspacePath,
  };
}

export class CodexAdapterStub implements ExecutorAdapter {
  readonly name = "codex";

  readonly capabilities = {
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsApprovalBroker: true,
  };

  private readonly sessionsDir: string;
  private readonly now: () => string;
  private readonly spawnProcess: (command: string, args: string[], cwd: string) => SpawnedProcessLike;

  constructor(options: CodexAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? path.resolve(process.cwd(), ".specrail-data", "sessions");
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnProcess = options.spawnProcess ?? (() => ({ pid: undefined }));
  }

  async spawn(input: SpawnExecutionInput): Promise<SpawnExecutionResult> {
    const timestamp = this.now();
    const sessionRef = `${input.executionId}-codex`;
    const command = buildCodexSpawnCommand(input);
    const spawned = this.spawnProcess(command.command, command.args, command.cwd);
    const metadata: ExecutorSessionMetadata = {
      executionId: input.executionId,
      sessionRef,
      backend: this.name,
      profile: input.profile,
      workspacePath: input.workspacePath,
      command,
      pid: spawned.pid,
      status: "spawned",
      prompt: input.prompt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await writeSessionMetadata(this.sessionsDir, metadata);

    const event = this.normalize({
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
          payload: { status: "running", sessionRef },
        },
        ...(event ? [event] : []),
      ],
    };
  }

  async resume(input: ResumeExecutionInput): Promise<ResumeExecutionResult> {
    const metadata = await readSessionMetadata(this.sessionsDir, input.sessionRef);
    const timestamp = this.now();
    const updatedMetadata: ExecutorSessionMetadata = {
      ...metadata,
      prompt: input.prompt,
      status: "resumed",
      resumedAt: timestamp,
      updatedAt: timestamp,
    };

    await writeSessionMetadata(this.sessionsDir, updatedMetadata);

    const event = this.normalize({
      kind: "resumed",
      executionId: metadata.executionId,
      sessionRef: input.sessionRef,
      timestamp,
    });

    return {
      sessionRef: input.sessionRef,
      command: toCommandMetadata(metadata.command, input.prompt, input.sessionRef),
      events: event ? [event] : [],
    };
  }

  async cancel(input: CancelExecutionInput | string): Promise<ExecutionEvent> {
    const sessionRef = typeof input === "string" ? input : input.sessionRef;
    const metadata = await readSessionMetadata(this.sessionsDir, sessionRef);
    const timestamp = this.now();

    await writeSessionMetadata(this.sessionsDir, {
      ...metadata,
      status: "cancelled",
      cancelledAt: timestamp,
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
      (event.kind !== "spawned" && event.kind !== "resumed" && event.kind !== "cancelled") ||
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
}

export async function readCodexSessionMetadata(
  sessionsDir: string,
  sessionRef: string,
): Promise<ExecutorSessionMetadata> {
  return readSessionMetadata(sessionsDir, sessionRef);
}
