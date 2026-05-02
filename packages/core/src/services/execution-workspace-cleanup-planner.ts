import path from "node:path";

import type { Execution } from "../domain/types.js";
import type { ExecutionWorkspaceMode } from "./execution-workspace-manager.js";

export type ExecutionWorkspaceCleanupOperation =
  | {
      kind: "remove_directory";
      path: string;
    }
  | {
      kind: "git_worktree_remove";
      cwd: string;
      command: "git";
      args: ["worktree", "remove", string];
    }
  | {
      kind: "git_branch_delete";
      cwd: string;
      command: "git";
      args: ["branch", "-D", string];
    };

export interface PlanExecutionWorkspaceCleanupInput {
  execution: Execution;
  workspaceRoot: string;
  mode: ExecutionWorkspaceMode;
  localRepoPath?: string;
}

export interface ExecutionWorkspaceCleanupPlan {
  executionId: string;
  eligible: boolean;
  dryRun: true;
  workspacePath: string;
  branchName: string;
  mode: ExecutionWorkspaceMode;
  operations: ExecutionWorkspaceCleanupOperation[];
  refusalReasons: string[];
}

const CLEANUP_ELIGIBLE_STATUSES = new Set<Execution["status"]>(["completed", "failed", "cancelled"]);

export function planExecutionWorkspaceCleanup(input: PlanExecutionWorkspaceCleanupInput): ExecutionWorkspaceCleanupPlan {
  const refusalReasons: string[] = [];
  const workspacePath = path.resolve(input.execution.workspacePath);
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const expectedBranchName = `specrail/${input.execution.id}`;

  if (!CLEANUP_ELIGIBLE_STATUSES.has(input.execution.status)) {
    refusalReasons.push(`Execution status ${input.execution.status} is not eligible for workspace cleanup`);
  }

  if (!isPathWithinRoot(workspacePath, workspaceRoot)) {
    refusalReasons.push(`Execution workspace path is outside workspace root: ${input.execution.workspacePath}`);
  }

  if (input.execution.branchName !== expectedBranchName) {
    refusalReasons.push(`Execution branch is not owned by SpecRail for this run: ${input.execution.branchName}`);
  }

  if (input.mode === "git_worktree" && !input.localRepoPath) {
    refusalReasons.push("Git worktree cleanup planning requires localRepoPath");
  }

  const eligible = refusalReasons.length === 0;
  const operations = eligible ? buildCleanupOperations(input, workspacePath) : [];

  return {
    executionId: input.execution.id,
    eligible,
    dryRun: true,
    workspacePath,
    branchName: input.execution.branchName,
    mode: input.mode,
    operations,
    refusalReasons,
  };
}

function buildCleanupOperations(
  input: PlanExecutionWorkspaceCleanupInput,
  workspacePath: string,
): ExecutionWorkspaceCleanupOperation[] {
  if (input.mode === "directory") {
    return [{ kind: "remove_directory", path: workspacePath }];
  }

  const cwd = input.localRepoPath ?? "";

  return [
    {
      kind: "git_worktree_remove",
      cwd,
      command: "git",
      args: ["worktree", "remove", workspacePath],
    },
    {
      kind: "git_branch_delete",
      cwd,
      command: "git",
      args: ["branch", "-D", input.execution.branchName],
    },
  ];
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
