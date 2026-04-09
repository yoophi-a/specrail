import type { ExecutionEvent } from "@specrail/core";

export interface SpawnExecutionInput {
  prompt: string;
  workspacePath: string;
  profile: string;
}

export interface ResumeExecutionInput {
  sessionRef: string;
  prompt: string;
}

export interface AdapterCapabilities {
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
  supportsApprovalBroker: boolean;
}

export interface ExecutorAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  spawn(input: SpawnExecutionInput): Promise<{ sessionRef: string }>;
  resume(input: ResumeExecutionInput): Promise<void>;
  cancel(sessionRef: string): Promise<void>;
  normalize(rawEvent: unknown): ExecutionEvent | null;
}
