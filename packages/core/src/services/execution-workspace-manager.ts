import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecutionWorkspaceMode = "directory" | "git_worktree";

export interface AllocateExecutionWorkspaceInput {
  executionId: string;
  workspaceRoot: string;
  localRepoPath?: string;
}

export interface AllocatedExecutionWorkspace {
  workspacePath: string;
  branchName: string;
  mode: ExecutionWorkspaceMode;
}

export interface ExecutionWorkspaceManager {
  allocate(input: AllocateExecutionWorkspaceInput): Promise<AllocatedExecutionWorkspace>;
}

export interface GitCommandRunner {
  run(input: { cwd: string; command: string; args: string[] }): Promise<void>;
}

export class NodeGitCommandRunner implements GitCommandRunner {
  async run(input: { cwd: string; command: string; args: string[] }): Promise<void> {
    await execFileAsync(input.command, input.args, { cwd: input.cwd });
  }
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

export class GitWorktreeExecutionWorkspaceManager implements ExecutionWorkspaceManager {
  private readonly gitRunner: GitCommandRunner;

  constructor(input: { gitRunner?: GitCommandRunner } = {}) {
    this.gitRunner = input.gitRunner ?? new NodeGitCommandRunner();
  }

  async allocate(input: AllocateExecutionWorkspaceInput): Promise<AllocatedExecutionWorkspace> {
    if (!input.localRepoPath) {
      throw new Error("Git worktree workspace allocation requires localRepoPath");
    }

    const workspacePath = path.join(input.workspaceRoot, input.executionId);
    const branchName = `specrail/${input.executionId}`;

    if (await pathExists(workspacePath)) {
      throw new Error(`Execution workspace already exists: ${workspacePath}`);
    }

    await mkdir(input.workspaceRoot, { recursive: true });

    try {
      await this.gitRunner.run({
        cwd: input.localRepoPath,
        command: "git",
        args: ["worktree", "add", "-b", branchName, workspacePath],
      });
    } catch (error) {
      throw new Error(`Failed to allocate git worktree for execution ${input.executionId}: ${formatErrorMessage(error)}`);
    }

    return {
      workspacePath,
      branchName,
      mode: "git_worktree",
    };
  }
}

export function createExecutionWorkspaceManager(mode: ExecutionWorkspaceMode): ExecutionWorkspaceManager {
  switch (mode) {
    case "directory":
      return new DirectoryExecutionWorkspaceManager();
    case "git_worktree":
      return new GitWorktreeExecutionWorkspaceManager();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
