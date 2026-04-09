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

export interface GitHubRunCommentSyncTarget {
  kind: "issue" | "pull_request";
  number: number;
  url: string;
}

export interface GitHubRunCommentSyncRecord {
  target: GitHubRunCommentSyncTarget;
  commentId?: number;
  lastRunId: string;
  lastRunStatus: ExecutionStatus;
  lastPublishedAt: string;
  lastCommentBody?: string;
  lastSyncStatus: "success" | "failed";
  lastSyncError?: string;
}

export interface GitHubRunCommentSyncState {
  id: string;
  trackId: string;
  updatedAt: string;
  comments: GitHubRunCommentSyncRecord[];
}

export interface TrackInspection {
  track: Track;
  githubRunCommentSync: GitHubRunCommentSyncState | null;
}

export type OpenSpecImportConflictPolicy = "reject" | "overwrite" | "resolve";

export type OpenSpecImportResolutionChoice = "incoming" | "existing";

export interface OpenSpecImportResolution {
  track?: Partial<Record<"title" | "description" | "status" | "specStatus" | "planStatus" | "priority" | "githubIssue" | "githubPullRequest", OpenSpecImportResolutionChoice>>;
  artifacts?: Partial<Record<"spec" | "plan" | "tasks", OpenSpecImportResolutionChoice>>;
}

export interface OpenSpecImportRecord {
  id: string;
  source: {
    kind: "file";
    path: string;
  };
  importedAt: string;
  conflictPolicy: OpenSpecImportConflictPolicy;
  resolution?: OpenSpecImportResolution;
  bundle: {
    version: 1;
    format: "specrail.openspec.bundle";
    exportedAt: string;
    generatedBy: "specrail";
  };
}

export interface GitHubIntegrationSummary {
  linkedTargetCount: number;
  syncedTargetCount: number;
  lastPublishedAt?: string;
  lastSyncStatus?: "success" | "failed" | "mixed";
  lastSyncError?: string;
}

export interface TrackIntegrationsInspection {
  trackId: string;
  openSpec: {
    latestImport: OpenSpecImportRecord | null;
    importHistory: OpenSpecImportRecord[];
  };
  github: {
    issue?: GitHubIssueReference;
    pullRequest?: GitHubPullRequestReference;
    runCommentSync: GitHubRunCommentSyncState | null;
    summary: GitHubIntegrationSummary;
  };
}

export interface RunInspection {
  run: Execution;
  githubRunCommentSync: GitHubRunCommentSyncState | null;
  githubRunCommentSyncForRun: GitHubRunCommentSyncRecord[];
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
  openSpecImport?: OpenSpecImportRecord;
  openSpecImportHistory?: OpenSpecImportRecord[];
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
