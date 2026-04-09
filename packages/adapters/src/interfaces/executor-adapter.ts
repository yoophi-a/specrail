import type { CommandExecutionMetadata, ExecutionEvent } from "@specrail/core";

export interface SpawnExecutionInput {
  executionId: string;
  prompt: string;
  workspacePath: string;
  profile: string;
}

export interface ResumeExecutionInput {
  executionId: string;
  sessionRef: string;
  prompt: string;
  workspacePath: string;
  profile: string;
}

export interface CancelExecutionInput {
  executionId: string;
  sessionRef: string;
  workspacePath: string;
  profile: string;
}

export interface ExecutorLaunch {
  sessionRef: string;
  command: CommandExecutionMetadata;
  events: ExecutionEvent[];
}

export interface AdapterCapabilities {
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
  supportsApprovalBroker: boolean;
}

export interface ExecutorAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  spawn(input: SpawnExecutionInput): Promise<ExecutorLaunch>;
  resume(input: ResumeExecutionInput): Promise<ExecutorLaunch>;
  cancel(input: CancelExecutionInput): Promise<ExecutionEvent>;
  normalize(rawEvent: unknown): ExecutionEvent | null;
}
