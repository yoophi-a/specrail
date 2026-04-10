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

export type OpenSpecImportResolutionFieldGroup = "track" | "artifacts";

export type OpenSpecImportTrackResolutionField =
  | "title"
  | "description"
  | "status"
  | "specStatus"
  | "planStatus"
  | "priority"
  | "githubIssue"
  | "githubPullRequest";

export type OpenSpecImportArtifactResolutionField = "spec" | "plan" | "tasks";

export type OpenSpecImportResolutionPresetName =
  | "policyDefaults"
  | "preferIncomingArtifacts"
  | "preserveWorkflowState"
  | "preferIncomingAll";

export interface OpenSpecImportResolution {
  track?: Partial<Record<OpenSpecImportTrackResolutionField, OpenSpecImportResolutionChoice>>;
  artifacts?: Partial<Record<OpenSpecImportArtifactResolutionField, OpenSpecImportResolutionChoice>>;
}

export interface OpenSpecSourceOfTruthPolicy {
  group: OpenSpecImportResolutionFieldGroup;
  field: OpenSpecImportTrackResolutionField | OpenSpecImportArtifactResolutionField;
  sourceOfTruth: "openspec" | "specrail";
  defaultChoice: OpenSpecImportResolutionChoice;
  rationale: string;
}

export interface OpenSpecImportResolutionPreset {
  name: OpenSpecImportResolutionPresetName;
  label: string;
  description: string;
  resolution: OpenSpecImportResolution;
}

export interface OpenSpecImportResolutionGuide {
  presetApplied: OpenSpecImportResolutionPresetName | null;
  effectiveResolution: OpenSpecImportResolution;
  policies: OpenSpecSourceOfTruthPolicy[];
  presets: OpenSpecImportResolutionPreset[];
}

export interface OpenSpecImportOperatorChoiceSummary {
  group: OpenSpecImportResolutionFieldGroup;
  field: OpenSpecImportTrackResolutionField | OpenSpecImportArtifactResolutionField;
  label: string;
  choice: OpenSpecImportResolutionChoice;
  sourceOfTruth: "openspec" | "specrail";
  rationale: string;
}

export interface OpenSpecImportPresetSummary {
  name: OpenSpecImportResolutionPresetName;
  label: string;
  description: string;
  highlights: string[];
  choices: OpenSpecImportOperatorChoiceSummary[];
}

export interface OpenSpecImportOperatorExample {
  id: "reject-preview" | "overwrite-apply" | "policy-defaults-resolve" | "preset-with-override";
  label: string;
  description: string;
  request: {
    dryRun?: boolean;
    conflictPolicy?: OpenSpecImportConflictPolicy;
    resolutionPreset?: OpenSpecImportResolutionPresetName;
    resolution?: OpenSpecImportResolution;
  };
  explanation: string[];
}

export interface OpenSpecImportOperatorGuide {
  recommendedFlow: string[];
  conflictPolicies: Array<{
    name: OpenSpecImportConflictPolicy;
    label: string;
    description: string;
  }>;
  selectedPreset: OpenSpecImportPresetSummary | null;
  effectiveChoices: OpenSpecImportOperatorChoiceSummary[];
  examples: OpenSpecImportOperatorExample[];
}

export interface OpenSpecImportRecord {
  id: string;
  source: {
    kind: "file";
    path: string;
  };
  importedAt: string;
  conflictPolicy: OpenSpecImportConflictPolicy;
  resolutionPreset?: OpenSpecImportResolutionPresetName;
  resolution?: OpenSpecImportResolution;
  bundle: {
    version: 1;
    format: "specrail.openspec.bundle";
    exportedAt: string;
    generatedBy: "specrail";
  };
}

export interface OpenSpecExportRecord {
  id: string;
  target: {
    kind: "file";
    path: string;
    overwrite?: boolean;
  };
  exportedAt: string;
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

export interface TrackOpenSpecImportInspectionEntry {
  trackId: string;
  trackTitle: string;
  provenance: OpenSpecImportRecord;
}

export interface TrackOpenSpecExportInspectionEntry {
  trackId: string;
  trackTitle: string;
  exportRecord: OpenSpecExportRecord;
}

export interface TrackOpenSpecInspectionPageMeta {
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface TrackOpenSpecInspectionPage<TEntry, TRecord> {
  latest: TRecord | null;
  items: TEntry[];
  meta: TrackOpenSpecInspectionPageMeta;
}

export interface TrackOpenSpecInspection {
  trackId: string;
  imports: TrackOpenSpecInspectionPage<TrackOpenSpecImportInspectionEntry, OpenSpecImportRecord>;
  exports: TrackOpenSpecInspectionPage<TrackOpenSpecExportInspectionEntry, OpenSpecExportRecord>;
}

export interface TrackIntegrationsInspection {
  trackId: string;
  openSpec: TrackOpenSpecInspection;
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
  openSpecExport?: OpenSpecExportRecord;
  openSpecExportHistory?: OpenSpecExportRecord[];
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

export interface HeartbeatTaskReference {
  trackId?: string;
  runId?: string;
  taskId?: string;
  title: string;
}

export interface HeartbeatSessionContext {
  sessionRef?: string;
  executionId?: string;
  profile?: string;
  workspacePath?: string;
}

export interface HeartbeatTaskSnapshot {
  task: HeartbeatTaskReference;
  timestamp: string;
  session?: HeartbeatSessionContext;
}

export interface HeartbeatActiveTask {
  task: HeartbeatTaskReference;
  startedAt: string;
  session?: HeartbeatSessionContext;
}

export interface HeartbeatState {
  id: "specrail-automation";
  updatedAt: string;
  lastStartedTask?: HeartbeatTaskSnapshot;
  lastCompletedTask?: HeartbeatTaskSnapshot;
  lastReportAt?: string;
  activeTask?: HeartbeatActiveTask;
}
