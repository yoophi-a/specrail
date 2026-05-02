import { mkdir } from "node:fs/promises";
import path from "node:path";

export type ExecutionWorkspaceMode = "directory" | "git_worktree";

export interface AllocateExecutionWorkspaceInput {
  executionId: string;
  workspaceRoot: string;
}

export interface AllocatedExecutionWorkspace {
  workspacePath: string;
  branchName: string;
  mode: ExecutionWorkspaceMode;
}

export interface ExecutionWorkspaceManager {
  allocate(input: AllocateExecutionWorkspaceInput): Promise<AllocatedExecutionWorkspace>;
}

export class DirectoryExecutionWorkspaceManager implements ExecutionWorkspaceManager {
  async allocate(input: AllocateExecutionWorkspaceInput): Promise<AllocatedExecutionWorkspace> {
    const workspacePath = path.join(input.workspaceRoot, input.executionId);
    const branchName = `specrail/${input.executionId}`;

    await mkdir(workspacePath, { recursive: true });

    return {
      workspacePath,
      branchName,
      mode: "directory",
    };
  }
}
