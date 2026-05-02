import { rm } from "node:fs/promises";

import type {
  ExecutionWorkspaceCleanupOperation,
  ExecutionWorkspaceCleanupPlan,
} from "./execution-workspace-cleanup-planner.js";
import { NodeGitCommandRunner, type GitCommandRunner } from "./execution-workspace-manager.js";

export interface FileSystemCleanupRunner {
  removeDirectory(path: string): Promise<void>;
}

export class NodeFileSystemCleanupRunner implements FileSystemCleanupRunner {
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
  }
}

export interface ApplyExecutionWorkspaceCleanupInput {
  plan: ExecutionWorkspaceCleanupPlan;
  confirm: boolean;
}

export interface AppliedExecutionWorkspaceCleanupOperation {
  operation: ExecutionWorkspaceCleanupOperation;
  status: "applied" | "failed";
  error?: string;
}

export interface ApplyExecutionWorkspaceCleanupResult {
  executionId: string;
  applied: boolean;
  status: "applied" | "refused" | "failed";
  summary: string;
  operations: AppliedExecutionWorkspaceCleanupOperation[];
  refusalReasons: string[];
}

export class ExecutionWorkspaceCleanupApplier {
  private readonly fileSystemRunner: FileSystemCleanupRunner;
  private readonly gitRunner: GitCommandRunner;

  constructor(input: { fileSystemRunner?: FileSystemCleanupRunner; gitRunner?: GitCommandRunner } = {}) {
    this.fileSystemRunner = input.fileSystemRunner ?? new NodeFileSystemCleanupRunner();
    this.gitRunner = input.gitRunner ?? new NodeGitCommandRunner();
  }

  async apply(input: ApplyExecutionWorkspaceCleanupInput): Promise<ApplyExecutionWorkspaceCleanupResult> {
    const refusalReasons = collectRefusalReasons(input);

    if (refusalReasons.length > 0) {
      return {
        executionId: input.plan.executionId,
        applied: false,
        status: "refused",
        summary: `Workspace cleanup refused for execution ${input.plan.executionId}`,
        operations: [],
        refusalReasons,
      };
    }

    const operations: AppliedExecutionWorkspaceCleanupOperation[] = [];

    for (const operation of input.plan.operations) {
      try {
        await this.applyOperation(operation);
        operations.push({ operation, status: "applied" });
      } catch (error) {
        operations.push({ operation, status: "failed", error: formatErrorMessage(error) });
        return {
          executionId: input.plan.executionId,
          applied: false,
          status: "failed",
          summary: `Workspace cleanup failed for execution ${input.plan.executionId}`,
          operations,
          refusalReasons: [],
        };
      }
    }

    return {
      executionId: input.plan.executionId,
      applied: true,
      status: "applied",
      summary: `Workspace cleanup applied for execution ${input.plan.executionId}`,
      operations,
      refusalReasons: [],
    };
  }

  private async applyOperation(operation: ExecutionWorkspaceCleanupOperation): Promise<void> {
    switch (operation.kind) {
      case "remove_directory":
        await this.fileSystemRunner.removeDirectory(operation.path);
        return;
      case "git_worktree_remove":
      case "git_branch_delete":
        await this.gitRunner.run({ cwd: operation.cwd, command: operation.command, args: operation.args });
        return;
    }
  }
}

function collectRefusalReasons(input: ApplyExecutionWorkspaceCleanupInput): string[] {
  const refusalReasons: string[] = [];

  if (!input.confirm) {
    refusalReasons.push("Workspace cleanup apply requires explicit confirmation");
  }

  if (!input.plan.dryRun) {
    refusalReasons.push("Workspace cleanup apply requires a dry-run plan as input");
  }

  if (!input.plan.eligible) {
    refusalReasons.push(...input.plan.refusalReasons);
  }

  if (input.plan.operations.length === 0) {
    refusalReasons.push("Workspace cleanup plan has no operations to apply");
  }

  return refusalReasons;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
