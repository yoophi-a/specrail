import type { ExecutionEvent } from "@specrail/core";
import type { ExecutorAdapter, ResumeExecutionInput, SpawnExecutionInput } from "../interfaces/executor-adapter.js";

export class CodexAdapterStub implements ExecutorAdapter {
  readonly name = "codex";

  readonly capabilities = {
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsApprovalBroker: true,
  };

  async spawn(_input: SpawnExecutionInput): Promise<{ sessionRef: string }> {
    return { sessionRef: "stub-codex-session" };
  }

  async resume(_input: ResumeExecutionInput): Promise<void> {
    return;
  }

  async cancel(_sessionRef: string): Promise<void> {
    return;
  }

  normalize(_rawEvent: unknown): ExecutionEvent | null {
    return null;
  }
}
