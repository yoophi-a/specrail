import type { CommandExecutionMetadata, ExecutionEvent, RuntimeApprovalDecisionInput } from "@specrail/core";

export type ExecutionBackend = "codex" | "claude_code" | (string & {});

export interface ExecutorCommandSpec {
  command: string;
  args: string[];
  cwd: string;
}

export interface ExecutorSessionMetadata {
  executionId: string;
  sessionRef: string;
  backend: ExecutionBackend;
  profile: string;
  workspacePath: string;
  command: ExecutorCommandSpec;
  pid?: number;
  providerSessionId?: string;
  providerInvocationId?: string;
  resumeSessionRef?: string;
  parentSessionRef?: string;
  providerMetadata?: Record<string, unknown>;
  codexSessionId?: string;
  status: "spawned" | "running" | "completed" | "failed" | "cancelled";
  prompt: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  resumedAt?: string;
  cancelledAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  failureMessage?: string;
}

export interface SpawnExecutionInput {
  executionId: string;
  prompt: string;
  workspacePath: string;
  profile: string;
}

export interface SpawnExecutionResult {
  sessionRef: string;
  metadata: ExecutorSessionMetadata;
  command: CommandExecutionMetadata;
  events: ExecutionEvent[];
}

export interface ResumeExecutionInput {
  executionId?: string;
  sessionRef: string;
  prompt: string;
  workspacePath?: string;
  profile?: string;
}

export interface ResumeExecutionResult {
  sessionRef: string;
  command: CommandExecutionMetadata;
  events: ExecutionEvent[];
}

export interface CancelExecutionInput {
  executionId?: string;
  sessionRef: string;
}

export interface AdapterCapabilities {
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
  supportsApprovalBroker: boolean;
}

export interface ExecutorAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  spawn(input: SpawnExecutionInput): Promise<SpawnExecutionResult>;
  resume(input: ResumeExecutionInput): Promise<ResumeExecutionResult>;
  cancel(input: CancelExecutionInput): Promise<ExecutionEvent>;
  resolveRuntimeApproval?(input: RuntimeApprovalDecisionInput): Promise<ExecutionEvent[]>;
  normalize(rawEvent: unknown): ExecutionEvent | null;
}
