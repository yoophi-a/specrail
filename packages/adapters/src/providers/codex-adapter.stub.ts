import type { ExecutionEvent } from "@specrail/core";
import type {
  CancelExecutionInput,
  ExecutorAdapter,
  ExecutorLaunch,
  ResumeExecutionInput,
  SpawnExecutionInput,
} from "../interfaces/executor-adapter.js";

export interface CodexAdapterOptions {
  binaryPath?: string;
  fullAuto?: boolean;
  sandboxMode?: "workspace-write" | "danger-full-access";
  additionalArgs?: string[];
  environment?: Record<string, string>;
  now?: () => string;
  eventIdFactory?: (executionId: string, kind: string) => string;
}

interface RawCodexEvent {
  executionId: string;
  type: "session.started" | "session.resumed" | "session.cancelled" | "shell.command" | "message";
  timestamp: string;
  summary: string;
  command?: string;
  args?: string[];
  text?: string;
}

function createDefaultEventId(executionId: string, kind: string): string {
  return `${executionId}:${kind}`;
}

function isRawCodexEvent(value: unknown): value is RawCodexEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RawCodexEvent>;
  return (
    typeof candidate.executionId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.summary === "string"
  );
}

export class CodexAdapterStub implements ExecutorAdapter {
  readonly name = "codex";

  readonly capabilities = {
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsApprovalBroker: true,
  };

  private readonly binaryPath: string;
  private readonly fullAuto: boolean;
  private readonly sandboxMode: "workspace-write" | "danger-full-access";
  private readonly additionalArgs: string[];
  private readonly environment?: Record<string, string>;
  private readonly now: () => string;
  private readonly eventIdFactory: (executionId: string, kind: string) => string;

  constructor(options: CodexAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? "codex";
    this.fullAuto = options.fullAuto ?? true;
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.additionalArgs = options.additionalArgs ?? [];
    this.environment = options.environment;
    this.now = options.now ?? (() => new Date().toISOString());
    this.eventIdFactory = options.eventIdFactory ?? createDefaultEventId;
  }

  async spawn(input: SpawnExecutionInput): Promise<ExecutorLaunch> {
    const sessionRef = `${input.executionId}:spawn`;
    return this.createLaunch({
      executionId: input.executionId,
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      profile: input.profile,
      sessionRef,
      lifecycleType: "session.started",
      lifecycleSummary: `Codex run queued for ${input.profile}`,
    });
  }

  async resume(input: ResumeExecutionInput): Promise<ExecutorLaunch> {
    return this.createLaunch({
      executionId: input.executionId,
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      profile: input.profile,
      sessionRef: input.sessionRef,
      lifecycleType: "session.resumed",
      lifecycleSummary: `Codex run resumed for session ${input.sessionRef}`,
      resumeSessionRef: input.sessionRef,
    });
  }

  async cancel(input: CancelExecutionInput): Promise<ExecutionEvent> {
    return {
      id: this.eventIdFactory(input.executionId, `cancelled:${input.sessionRef}`),
      executionId: input.executionId,
      type: "task_status_changed",
      timestamp: this.now(),
      source: this.name,
      summary: `Cancellation requested for session ${input.sessionRef}`,
      payload: {
        profile: input.profile,
        workspacePath: input.workspacePath,
        sessionRef: input.sessionRef,
        status: "cancelled",
      },
    };
  }

  normalize(rawEvent: unknown): ExecutionEvent | null {
    if (!isRawCodexEvent(rawEvent)) {
      return null;
    }

    switch (rawEvent.type) {
      case "session.started":
      case "session.resumed":
      case "session.cancelled":
        return {
          id: this.eventIdFactory(rawEvent.executionId, rawEvent.type),
          executionId: rawEvent.executionId,
          type: "task_status_changed",
          timestamp: rawEvent.timestamp,
          source: this.name,
          summary: rawEvent.summary,
          payload: { lifecycle: rawEvent.type },
        };
      case "shell.command":
        return {
          id: this.eventIdFactory(rawEvent.executionId, rawEvent.type),
          executionId: rawEvent.executionId,
          type: "shell_command",
          timestamp: rawEvent.timestamp,
          source: this.name,
          summary: rawEvent.summary,
          payload: {
            command: rawEvent.command,
            args: rawEvent.args ?? [],
          },
        };
      case "message":
        return {
          id: this.eventIdFactory(rawEvent.executionId, rawEvent.type),
          executionId: rawEvent.executionId,
          type: "message",
          timestamp: rawEvent.timestamp,
          source: this.name,
          summary: rawEvent.summary,
          payload: {
            text: rawEvent.text,
          },
        };
      default:
        return null;
    }
  }

  private async createLaunch(params: {
    executionId: string;
    prompt: string;
    workspacePath: string;
    profile: string;
    sessionRef: string;
    lifecycleType: "session.started" | "session.resumed";
    lifecycleSummary: string;
    resumeSessionRef?: string;
  }): Promise<ExecutorLaunch> {
    const args = this.buildArgs(params.prompt, params.profile, params.resumeSessionRef);
    const timestamp = this.now();

    return {
      sessionRef: params.sessionRef,
      command: {
        command: this.binaryPath,
        args,
        cwd: params.workspacePath,
        prompt: params.prompt,
        resumeSessionRef: params.resumeSessionRef,
        environment: this.environment,
      },
      events: [
        {
          id: this.eventIdFactory(params.executionId, params.lifecycleType),
          executionId: params.executionId,
          type: "task_status_changed",
          timestamp,
          source: this.name,
          summary: params.lifecycleSummary,
          payload: {
            lifecycle: params.lifecycleType,
            profile: params.profile,
            sessionRef: params.sessionRef,
          },
        },
        {
          id: this.eventIdFactory(params.executionId, `shell:${params.sessionRef}`),
          executionId: params.executionId,
          type: "shell_command",
          timestamp,
          source: this.name,
          summary: `Prepared Codex command for ${params.profile}`,
          payload: {
            command: this.binaryPath,
            args,
            cwd: params.workspacePath,
          },
        },
      ],
    };
  }

  private buildArgs(prompt: string, profile: string, resumeSessionRef?: string): string[] {
    const args = ["exec"];

    if (this.fullAuto) {
      args.push("--full-auto");
    }

    args.push("--sandbox", this.sandboxMode, "--profile", profile);

    if (resumeSessionRef) {
      args.push("resume", resumeSessionRef);
    }

    args.push(...this.additionalArgs, prompt);

    return args;
  }
}
