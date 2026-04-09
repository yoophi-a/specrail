export const TRACK_STATUSES = [
  "new",
  "planned",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "failed",
] as const;

export type TrackStatus =
  | "new"
  | "planned"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "failed";

export const APPROVAL_STATUSES = ["draft", "pending", "approved", "rejected"] as const;

export type ApprovalStatus = "draft" | "pending" | "approved" | "rejected";

export interface GitHubIssueReference {
  number: number;
  url: string;
}

export interface GitHubPullRequestReference {
  number: number;
  url: string;
}

export type ExecutionStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface Project {
  id: string;
  name: string;
  repoUrl?: string;
  localRepoPath?: string;
  defaultWorkflowPolicy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Track {
  id: string;
  projectId: string;
  title: string;
  description: string;
  githubIssue?: GitHubIssueReference;
  githubPullRequest?: GitHubPullRequestReference;
  status: TrackStatus;
  specStatus: ApprovalStatus;
  planStatus: ApprovalStatus;
  priority: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface CommandExecutionMetadata {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  resumeSessionRef?: string;
  environment?: Record<string, string>;
}

export interface ExecutionSummary {
  eventCount: number;
  lastEventSummary?: string;
  lastEventAt?: string;
}

export interface Execution {
  id: string;
  trackId: string;
  backend: string;
  profile: string;
  workspacePath: string;
  branchName: string;
  sessionRef?: string;
  command?: CommandExecutionMetadata;
  summary?: ExecutionSummary;
  status: ExecutionStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type EventType =
  | "message"
  | "tool_call"
  | "tool_result"
  | "file_change"
  | "shell_command"
  | "approval_requested"
  | "approval_resolved"
  | "task_status_changed"
  | "test_result"
  | "summary";

export interface ExecutionEvent {
  id: string;
  executionId: string;
  type: EventType;
  timestamp: string;
  source: string;
  summary: string;
  payload?: Record<string, unknown>;
}
