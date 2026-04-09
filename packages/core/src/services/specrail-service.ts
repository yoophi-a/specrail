import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  renderPlanDocument,
  renderSpecDocument,
  renderTaskDocument,
  type PlanDocument,
  type SpecDocument,
  type TaskDocument,
} from "../domain/artifacts.js";
import type {
  ApprovalStatus,
  Execution,
  ExecutionEvent,
  ExecutionStatus,
  GitHubIssueReference,
  GitHubPullRequestReference,
  GitHubRunCommentSyncState,
  Project,
  RunInspection,
  Track,
  TrackInspection,
  TrackIntegrationsInspection,
  TrackStatus,
} from "../domain/types.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type {
  EventStore,
  ExecutionRepository,
  GitHubRunCommentPublishResult,
  GitHubRunCommentPublisher,
  GitHubRunCommentSyncStore,
  ProjectRepository,
  TrackRepository,
} from "./ports.js";

export interface TrackArtifactWriterInput {
  track: Track;
  project: Project;
  specContent: string;
  planContent: string;
  tasksContent: string;
}

export interface TrackArtifactWriter {
  write(input: TrackArtifactWriterInput): Promise<void>;
}

export interface OpenSpecTrackArtifacts {
  spec: string;
  plan: string;
  tasks: string;
}

export interface OpenSpecImportSource {
  kind: "file";
  path: string;
}

export type OpenSpecImportConflictPolicy = "reject" | "overwrite";

export interface OpenSpecExportTarget {
  kind: "file";
  path: string;
  overwrite?: boolean;
}

export interface OpenSpecTrackPackage {
  metadata: {
    version: 1;
    format: "specrail.openspec.bundle";
    exportedAt: string;
    generatedBy: "specrail";
  };
  track: Track;
  artifacts: OpenSpecTrackArtifacts;
  files: {
    spec: string;
    plan: string;
    tasks: string;
  };
}

export interface OpenSpecAdapter {
  readonly name: string;
  importPackage(input: { source: OpenSpecImportSource }): Promise<{ package: OpenSpecTrackPackage }>;
  exportPackage(input: { package: OpenSpecTrackPackage; target: OpenSpecExportTarget }): Promise<{
    package: OpenSpecTrackPackage;
    target: OpenSpecExportTarget;
  }>;
}

export interface TrackArtifactReader {
  read(trackId: string): Promise<OpenSpecTrackArtifacts>;
}

export interface ExecutorLaunchResult {
  sessionRef: string;
  command: Execution["command"];
  events: ExecutionEvent[];
}

export interface ExecutionBackend {
  readonly name: string;
  spawn(input: {
    executionId: string;
    prompt: string;
    workspacePath: string;
    profile: string;
  }): Promise<ExecutorLaunchResult>;
  resume(input: {
    executionId: string;
    sessionRef: string;
    prompt: string;
    workspacePath: string;
    profile: string;
  }): Promise<ExecutorLaunchResult>;
  cancel(input: {
    executionId: string;
    sessionRef: string;
    workspacePath: string;
    profile: string;
  }): Promise<ExecutionEvent>;
}

export interface SpecRailServiceDependencies {
  projectRepository: ProjectRepository;
  trackRepository: TrackRepository;
  executionRepository: ExecutionRepository;
  eventStore: EventStore;
  artifactWriter: TrackArtifactWriter;
  artifactReader?: TrackArtifactReader;
  executor: ExecutionBackend;
  openSpecAdapter?: OpenSpecAdapter;
  defaultProject: {
    id: string;
    name: string;
    repoUrl?: string;
    localRepoPath?: string;
    defaultWorkflowPolicy?: string;
  };
  workspaceRoot: string;
  githubRunCommentPublisher?: GitHubRunCommentPublisher;
  githubRunCommentSyncStore?: GitHubRunCommentSyncStore;
  now?: () => string;
  idGenerator?: () => string;
}

export interface CreateTrackInput {
  title: string;
  description: string;
  priority?: Track["priority"];
  githubIssue?: GitHubIssueReference;
  githubPullRequest?: GitHubPullRequestReference;
}

export interface StartRunInput {
  trackId: string;
  prompt: string;
  profile?: string;
}

export interface UpdateTrackInput {
  trackId: string;
  status?: TrackStatus;
  specStatus?: ApprovalStatus;
  planStatus?: ApprovalStatus;
  githubIssue?: GitHubIssueReference;
  githubPullRequest?: GitHubPullRequestReference;
}

export interface ResumeRunInput {
  runId: string;
  prompt: string;
}

export interface CancelRunInput {
  runId: string;
}

export interface ExportTrackToOpenSpecInput {
  trackId: string;
  target: OpenSpecExportTarget;
}

export interface ImportTrackFromOpenSpecInput {
  source: OpenSpecImportSource;
  dryRun?: boolean;
  conflictPolicy?: OpenSpecImportConflictPolicy;
}

export interface ImportTrackFromOpenSpecResult {
  track: Track;
  action: "created" | "updated";
  applied: boolean;
  conflictPolicy: OpenSpecImportConflictPolicy;
  conflict: {
    hasConflict: boolean;
    reason: "track_id_exists" | null;
  };
}

export type SortOrder = "asc" | "desc";

export interface ListTracksInput {
  status?: TrackStatus;
  priority?: Track["priority"];
  page?: number;
  pageSize?: number;
  sortBy?: "updatedAt" | "createdAt" | "title" | "priority" | "status";
  sortOrder?: SortOrder;
}

export interface ListRunsInput {
  trackId?: string;
  status?: ExecutionStatus;
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "startedAt" | "finishedAt" | "status";
  sortOrder?: SortOrder;
}

export interface ListPageMeta {
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ListPageResult<T> {
  items: T[];
  meta: ListPageMeta;
}

function buildExecutionSummary(events: ExecutionEvent[]): Execution["summary"] {
  const lastEvent = events.at(-1);

  return {
    eventCount: events.length,
    lastEventSummary: lastEvent?.summary,
    lastEventAt: lastEvent?.timestamp,
  };
}

function readExecutionStatus(event: ExecutionEvent): ExecutionStatus | null {
  if (event.type === "approval_requested") {
    return "waiting_approval";
  }

  if (event.type === "approval_resolved") {
    return "running";
  }

  if (event.type === "task_status_changed") {
    const status = event.payload?.status;
    if (
      status === "created" ||
      status === "queued" ||
      status === "running" ||
      status === "waiting_approval" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return status;
    }
  }

  return null;
}

function buildExecutionSnapshot(execution: Execution, events: ExecutionEvent[]): Execution {
  const derivedStatus = events.reduce<ExecutionStatus>(
    (status, event) => readExecutionStatus(event) ?? status,
    execution.status,
  );
  const lastStatusEvent = [...events].reverse().find((event) => readExecutionStatus(event) !== null);
  const isTerminal = derivedStatus === "completed" || derivedStatus === "failed" || derivedStatus === "cancelled";

  return {
    ...execution,
    status: derivedStatus,
    summary: buildExecutionSummary(events),
    startedAt:
      execution.startedAt ??
      (derivedStatus === "running" || derivedStatus === "waiting_approval" || isTerminal
        ? execution.createdAt
        : undefined),
    finishedAt: isTerminal ? (lastStatusEvent?.timestamp ?? execution.finishedAt ?? execution.createdAt) : undefined,
  };
}

function mapTrackStatusFromExecution(status: ExecutionStatus): TrackStatus | null {
  switch (status) {
    case "completed":
      return "review";
    case "failed":
      return "failed";
    case "cancelled":
      return "blocked";
    default:
      return null;
  }
}

function compareValues(left: string | undefined, right: string | undefined, sortOrder: SortOrder): number {
  const leftValue = left ?? "";
  const rightValue = right ?? "";
  const compared = leftValue.localeCompare(rightValue);
  return sortOrder === "asc" ? compared : -compared;
}

function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function buildListPageResult<T>(items: T[], page: number, pageSize: number): ListPageResult<T> {
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    items: paginateItems(items, page, pageSize),
    meta: {
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1 && totalPages > 0,
    },
  };
}

function normalizeRequiredString(value: string): string {
  return value.trim();
}

function normalizeProfile(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "default";
}

function normalizeGitHubReference<T extends GitHubIssueReference | GitHubPullRequestReference>(value: T | undefined): T | undefined {
  if (!value) {
    return undefined;
  }

  return {
    ...value,
    url: value.url.trim(),
  };
}

function listGitHubRunCommentTargets(track: Pick<Track, "githubIssue" | "githubPullRequest">): GitHubRunCommentSyncState["comments"][number]["target"][] {
  const targets = [] as GitHubRunCommentSyncState["comments"][number]["target"][];

  if (track.githubIssue) {
    targets.push({ kind: "issue", number: track.githubIssue.number, url: track.githubIssue.url });
  }

  if (track.githubPullRequest) {
    targets.push({ kind: "pull_request", number: track.githubPullRequest.number, url: track.githubPullRequest.url });
  }

  return targets.filter(
    (target, index, all) => all.findIndex((candidate) => candidate.kind === target.kind && candidate.url === target.url) === index,
  );
}

function summarizeGitHubIntegration(
  track: Pick<Track, "githubIssue" | "githubPullRequest">,
  syncState: GitHubRunCommentSyncState | null,
): TrackIntegrationsInspection["github"]["summary"] {
  const linkedTargetCount = listGitHubRunCommentTargets(track).length;
  const syncedTargetCount = syncState?.comments.length ?? 0;

  if (!syncState || syncState.comments.length === 0) {
    return { linkedTargetCount, syncedTargetCount };
  }

  const sortedComments = [...syncState.comments].sort((left, right) => right.lastPublishedAt.localeCompare(left.lastPublishedAt));
  const lastComment = sortedComments[0];
  const statuses = new Set(syncState.comments.map((comment) => comment.lastSyncStatus));
  const lastErrorComment = sortedComments.find((comment) => comment.lastSyncError);

  return {
    linkedTargetCount,
    syncedTargetCount,
    lastPublishedAt: lastComment?.lastPublishedAt,
    lastSyncStatus: statuses.size > 1 ? "mixed" : lastComment?.lastSyncStatus,
    ...(lastErrorComment?.lastSyncError ? { lastSyncError: lastErrorComment.lastSyncError } : {}),
  };
}

export class SpecRailService {
  private readonly now: () => string;
  private readonly idGenerator: () => string;

  constructor(private readonly dependencies: SpecRailServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  async createTrack(input: CreateTrackInput): Promise<Track> {
    const project = await this.ensureDefaultProject();
    const timestamp = this.now();
    const track: Track = {
      id: `track-${this.idGenerator()}`,
      projectId: project.id,
      title: normalizeRequiredString(input.title),
      description: normalizeRequiredString(input.description),
      githubIssue: normalizeGitHubReference(input.githubIssue),
      githubPullRequest: normalizeGitHubReference(input.githubPullRequest),
      status: "new",
      specStatus: "draft",
      planStatus: "draft",
      priority: input.priority ?? "medium",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.dependencies.trackRepository.create(track);
    await this.dependencies.artifactWriter.write({
      track,
      project,
      specContent: this.renderDefaultSpec(track),
      planContent: this.renderDefaultPlan(track),
      tasksContent: this.renderDefaultTasks(track),
    });

    return track;
  }

  getTrack(trackId: string): Promise<Track | null> {
    return this.dependencies.trackRepository.getById(trackId);
  }

  async getTrackInspection(trackId: string): Promise<TrackInspection | null> {
    const track = await this.dependencies.trackRepository.getById(trackId);
    if (!track) {
      return null;
    }

    return {
      track,
      githubRunCommentSync: (await this.dependencies.githubRunCommentSyncStore?.getByTrackId(track.id)) ?? null,
    };
  }

  async getTrackIntegrationsInspection(trackId: string): Promise<TrackIntegrationsInspection | null> {
    const track = await this.dependencies.trackRepository.getById(trackId);
    if (!track) {
      return null;
    }

    const githubRunCommentSync = (await this.dependencies.githubRunCommentSyncStore?.getByTrackId(track.id)) ?? null;

    return {
      trackId: track.id,
      github: {
        issue: track.githubIssue,
        pullRequest: track.githubPullRequest,
        runCommentSync: githubRunCommentSync,
        summary: summarizeGitHubIntegration(track, githubRunCommentSync),
      },
    };
  }

  async listTracks(input: ListTracksInput = {}): Promise<Track[]> {
    const result = await this.listTracksPage(input);
    return result.items;
  }

  async listTracksPage(input: ListTracksInput = {}): Promise<ListPageResult<Track>> {
    const tracks = await this.dependencies.trackRepository.list();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const sortBy = input.sortBy ?? "updatedAt";
    const sortOrder = input.sortOrder ?? "desc";

    const sorted = tracks
      .filter((track) => (input.status ? track.status === input.status : true))
      .filter((track) => (input.priority ? track.priority === input.priority : true))
      .sort((left, right) => {
        const primary = (() => {
          switch (sortBy) {
            case "createdAt":
              return compareValues(left.createdAt, right.createdAt, sortOrder);
            case "title":
              return compareValues(left.title, right.title, sortOrder);
            case "priority":
              return compareValues(left.priority, right.priority, sortOrder);
            case "status":
              return compareValues(left.status, right.status, sortOrder);
            case "updatedAt":
            default:
              return compareValues(left.updatedAt, right.updatedAt, sortOrder);
          }
        })();

        return primary || compareValues(left.createdAt, right.createdAt, "desc") || compareValues(left.id, right.id, "desc");
      });

    return buildListPageResult(sorted, page, pageSize);
  }

  async updateTrack(input: UpdateTrackInput): Promise<Track> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const nextTrack: Track = {
      ...track,
      status: input.status ?? track.status,
      specStatus: input.specStatus ?? track.specStatus,
      planStatus: input.planStatus ?? track.planStatus,
      githubIssue: input.githubIssue === undefined ? track.githubIssue : normalizeGitHubReference(input.githubIssue),
      githubPullRequest:
        input.githubPullRequest === undefined ? track.githubPullRequest : normalizeGitHubReference(input.githubPullRequest),
      updatedAt: this.now(),
    };

    await this.dependencies.trackRepository.update(nextTrack);

    return nextTrack;
  }

  async exportTrackToOpenSpec(input: ExportTrackToOpenSpecInput) {
    const adapter = this.requireOpenSpecAdapter();
    const artifactReader = this.requireTrackArtifactReader();
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const artifacts = await artifactReader.read(track.id);

    return adapter.exportPackage({
      package: {
        metadata: {
          version: 1,
          format: "specrail.openspec.bundle",
          exportedAt: this.now(),
          generatedBy: "specrail",
        },
        track,
        artifacts,
        files: {
          spec: "spec.md",
          plan: "plan.md",
          tasks: "tasks.md",
        },
      },
      target: input.target,
    });
  }

  async importTrackFromOpenSpec(input: ImportTrackFromOpenSpecInput): Promise<ImportTrackFromOpenSpecResult> {
    const adapter = this.requireOpenSpecAdapter();
    const project = await this.ensureDefaultProject();
    const imported = await adapter.importPackage({ source: input.source });
    const timestamp = this.now();
    const importedTrack = imported.package.track;
    const existingTrack = await this.dependencies.trackRepository.getById(importedTrack.id);
    const conflictPolicy = input.conflictPolicy ?? "reject";
    const action = existingTrack ? "updated" : "created";
    const conflict = {
      hasConflict: existingTrack !== null,
      reason: existingTrack ? ("track_id_exists" as const) : null,
    };

    const track: Track = {
      ...importedTrack,
      projectId: existingTrack?.projectId ?? importedTrack.projectId ?? project.id,
      title: normalizeRequiredString(importedTrack.title),
      description: normalizeRequiredString(importedTrack.description),
      githubIssue: normalizeGitHubReference(importedTrack.githubIssue),
      githubPullRequest: normalizeGitHubReference(importedTrack.githubPullRequest),
      updatedAt: timestamp,
      createdAt: existingTrack?.createdAt ?? importedTrack.createdAt ?? timestamp,
    };

    if (existingTrack && conflictPolicy === "reject") {
      if (input.dryRun) {
        return {
          track,
          action,
          applied: false,
          conflictPolicy,
          conflict,
        };
      }

      throw new ConflictError(`OpenSpec import would overwrite existing track: ${track.id}. Retry with conflictPolicy=overwrite or dryRun=true.`);
    }

    if (input.dryRun) {
      return {
        track,
        action,
        applied: false,
        conflictPolicy,
        conflict,
      };
    }

    if (existingTrack) {
      await this.dependencies.trackRepository.update(track);
    } else {
      await this.dependencies.trackRepository.create(track);
    }

    await this.dependencies.artifactWriter.write({
      track,
      project,
      specContent: imported.package.artifacts.spec,
      planContent: imported.package.artifacts.plan,
      tasksContent: imported.package.artifacts.tasks,
    });

    return {
      track,
      action,
      applied: true,
      conflictPolicy,
      conflict,
    };
  }

  async startRun(input: StartRunInput): Promise<Execution> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const executionId = `run-${this.idGenerator()}`;
    const createdAt = this.now();
    const workspacePath = path.join(this.dependencies.workspaceRoot, executionId);
    const prompt = normalizeRequiredString(input.prompt);
    const profile = normalizeProfile(input.profile);
    await mkdir(workspacePath, { recursive: true });

    const launch = await this.dependencies.executor.spawn({
      executionId,
      prompt,
      workspacePath,
      profile,
    });

    const initialExecution: Execution = {
      id: executionId,
      trackId: track.id,
      backend: this.dependencies.executor.name,
      profile,
      workspacePath,
      branchName: `specrail/${executionId}`,
      sessionRef: launch.sessionRef,
      command: launch.command,
      status: "running",
      createdAt,
      startedAt: createdAt,
    };

    await this.dependencies.executionRepository.create(initialExecution);

    for (const event of launch.events) {
      await this.dependencies.eventStore.append(event);
    }

    const execution = buildExecutionSnapshot(
      initialExecution,
      await this.dependencies.eventStore.listByExecution(executionId),
    );
    await this.dependencies.executionRepository.update(execution);
    const nextTrack = await this.reconcileTrackStatusFromRun(track.id, execution);
    await this.publishRunSummaryForExecution(nextTrack ?? track, execution);

    return execution;
  }

  async resumeRun(input: ResumeRunInput): Promise<Execution> {
    const execution = await this.requireRun(input.runId);

    if (!execution.sessionRef) {
      throw new Error(`Run is missing sessionRef: ${input.runId}`);
    }

    const launch = await this.dependencies.executor.resume({
      executionId: execution.id,
      sessionRef: execution.sessionRef,
      prompt: normalizeRequiredString(input.prompt),
      workspacePath: execution.workspacePath,
      profile: execution.profile,
    });

    const resumedExecution: Execution = {
      ...execution,
      command: launch.command,
      status: "running",
      startedAt: execution.startedAt ?? this.now(),
      finishedAt: undefined,
    };

    await this.dependencies.executionRepository.update(resumedExecution);

    for (const event of launch.events) {
      await this.dependencies.eventStore.append(event);
    }

    const reconciledExecution = buildExecutionSnapshot(
      resumedExecution,
      await this.dependencies.eventStore.listByExecution(execution.id),
    );
    await this.dependencies.executionRepository.update(reconciledExecution);
    const track = await this.reconcileTrackStatusFromRun(reconciledExecution.trackId, reconciledExecution);
    await this.publishRunSummaryForExecution(track, reconciledExecution);

    return reconciledExecution;
  }

  async cancelRun(input: CancelRunInput): Promise<Execution> {
    const execution = await this.requireRun(input.runId);

    if (!execution.sessionRef) {
      throw new Error(`Run is missing sessionRef: ${input.runId}`);
    }

    const cancellationEvent = await this.dependencies.executor.cancel({
      executionId: execution.id,
      sessionRef: execution.sessionRef,
      workspacePath: execution.workspacePath,
      profile: execution.profile,
    });

    await this.dependencies.eventStore.append(cancellationEvent);

    const cancelledExecution = buildExecutionSnapshot(
      execution,
      await this.dependencies.eventStore.listByExecution(execution.id),
    );
    await this.dependencies.executionRepository.update(cancelledExecution);
    const track = await this.reconcileTrackStatusFromRun(cancelledExecution.trackId, cancelledExecution);
    await this.publishRunSummaryForExecution(track, cancelledExecution);

    return cancelledExecution;
  }

  getRun(runId: string): Promise<Execution | null> {
    return this.dependencies.executionRepository.getById(runId);
  }

  async getRunInspection(runId: string): Promise<RunInspection | null> {
    const run = await this.dependencies.executionRepository.getById(runId);
    if (!run) {
      return null;
    }

    const githubRunCommentSync = (await this.dependencies.githubRunCommentSyncStore?.getByTrackId(run.trackId)) ?? null;

    return {
      run,
      githubRunCommentSync,
      githubRunCommentSyncForRun: githubRunCommentSync?.comments.filter((comment) => comment.lastRunId === run.id) ?? [],
    };
  }

  async listRuns(input: ListRunsInput = {}): Promise<Execution[]> {
    const result = await this.listRunsPage(input);
    return result.items;
  }

  async listRunsPage(input: ListRunsInput = {}): Promise<ListPageResult<Execution>> {
    const executions = await this.dependencies.executionRepository.list();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const sortBy = input.sortBy ?? "createdAt";
    const sortOrder = input.sortOrder ?? "desc";

    const sorted = executions
      .filter((execution) => (input.trackId ? execution.trackId === input.trackId : true))
      .filter((execution) => (input.status ? execution.status === input.status : true))
      .sort((left, right) => {
        const primary = (() => {
          switch (sortBy) {
            case "startedAt":
              return compareValues(left.startedAt, right.startedAt, sortOrder);
            case "finishedAt":
              return compareValues(left.finishedAt, right.finishedAt, sortOrder);
            case "status":
              return compareValues(left.status, right.status, sortOrder);
            case "createdAt":
            default:
              return compareValues(left.createdAt, right.createdAt, sortOrder);
          }
        })();

        return primary || compareValues(left.startedAt, right.startedAt, "desc") || compareValues(left.id, right.id, "desc");
      });

    return buildListPageResult(sorted, page, pageSize);
  }

  listRunEvents(runId: string): Promise<ExecutionEvent[]> {
    return this.dependencies.eventStore.listByExecution(runId);
  }

  async recordExecutionEvent(event: ExecutionEvent): Promise<void> {
    await this.dependencies.eventStore.append(event);

    const execution = await this.dependencies.executionRepository.getById(event.executionId);
    if (!execution) {
      return;
    }

    const reconciledExecution = buildExecutionSnapshot(
      execution,
      await this.dependencies.eventStore.listByExecution(event.executionId),
    );
    await this.dependencies.executionRepository.update(reconciledExecution);
    const track = await this.reconcileTrackStatusFromRun(reconciledExecution.trackId, reconciledExecution);
    await this.publishRunSummaryForExecution(track, reconciledExecution);
  }

  async publishRunSummary(runId: string): Promise<GitHubRunCommentPublishResult[]> {
    const execution = await this.requireRun(runId);
    const track = await this.dependencies.trackRepository.getById(execution.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${execution.trackId}`);
    }

    return this.publishRunSummaryForExecution(track, execution);
  }

  async retryGitHubRunCommentSync(trackId: string): Promise<{ runId: string; results: GitHubRunCommentPublishResult[] }> {
    const track = await this.dependencies.trackRepository.getById(trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${trackId}`);
    }

    const syncState = await this.dependencies.githubRunCommentSyncStore?.getByTrackId(track.id);
    const failedComments = syncState?.comments.filter((comment) => comment.lastSyncStatus === "failed") ?? [];

    if (failedComments.length === 0) {
      throw new ConflictError(`Track does not have any failed GitHub run comment syncs: ${track.id}`);
    }

    const retryCandidate = failedComments
      .slice()
      .sort((left, right) => {
        const published = right.lastPublishedAt.localeCompare(left.lastPublishedAt);
        return published || right.lastRunId.localeCompare(left.lastRunId);
      })[0];

    if (!retryCandidate) {
      throw new ConflictError(`Track does not have any retryable GitHub run comment syncs: ${track.id}`);
    }

    return {
      runId: retryCandidate.lastRunId,
      results: await this.publishRunSummary(retryCandidate.lastRunId),
    };
  }

  private async reconcileTrackStatusFromRun(trackId: string, execution: Execution): Promise<Track | undefined> {
    const track = await this.dependencies.trackRepository.getById(trackId);
    if (!track) {
      return undefined;
    }

    const nextStatus = mapTrackStatusFromExecution(execution.status);
    if (!nextStatus || track.status === nextStatus) {
      return track;
    }

    const updatedTrack = {
      ...track,
      status: nextStatus,
      updatedAt: execution.finishedAt ?? this.now(),
    };

    await this.dependencies.trackRepository.update(updatedTrack);
    return updatedTrack;
  }

  private async publishRunSummaryForExecution(track: Track | undefined, execution: Execution): Promise<GitHubRunCommentPublishResult[]> {
    if (!track || !this.dependencies.githubRunCommentPublisher) {
      return [];
    }

    if (!track.githubIssue && !track.githubPullRequest) {
      return [];
    }

    const syncState = await this.dependencies.githubRunCommentSyncStore?.getByTrackId(track.id);
    const events = await this.dependencies.eventStore.listByExecution(execution.id);
    let results: GitHubRunCommentPublishResult[];

    try {
      results = await this.dependencies.githubRunCommentPublisher.publishRunSummary({
        track,
        run: execution,
        events,
        syncState: syncState ?? undefined,
      });
    } catch (error) {
      if (this.dependencies.githubRunCommentSyncStore) {
        const timestamp = this.now();
        const previousComments = syncState?.comments ?? [];
        await this.dependencies.githubRunCommentSyncStore.upsert({
          id: track.id,
          trackId: track.id,
          updatedAt: timestamp,
          comments: listGitHubRunCommentTargets(track).map((target) => {
            const previous = previousComments.find((comment) => comment.target.kind === target.kind && comment.target.url === target.url);
            return {
              target,
              commentId: previous?.commentId,
              lastRunId: execution.id,
              lastRunStatus: execution.status,
              lastPublishedAt: previous?.lastPublishedAt ?? timestamp,
              lastCommentBody: previous?.lastCommentBody,
              lastSyncStatus: "failed" as const,
              lastSyncError: error instanceof Error ? error.message : String(error),
            };
          }),
        });
      }

      throw error;
    }

    if (this.dependencies.githubRunCommentSyncStore) {
      const timestamp = this.now();
      await this.dependencies.githubRunCommentSyncStore.upsert({
        id: track.id,
        trackId: track.id,
        updatedAt: timestamp,
        comments: results.map((result) => ({
          target: result.target,
          commentId: result.commentId,
          lastRunId: execution.id,
          lastRunStatus: execution.status,
          lastPublishedAt: timestamp,
          lastCommentBody: result.body,
          lastSyncStatus: "success",
        })),
      } satisfies GitHubRunCommentSyncState);
    }

    return results;
  }

  private async requireRun(runId: string): Promise<Execution> {
    const execution = await this.dependencies.executionRepository.getById(runId);

    if (!execution) {
      throw new NotFoundError(`Run not found: ${runId}`);
    }

    return execution;
  }

  private async ensureDefaultProject(): Promise<Project> {
    const existing = await this.dependencies.projectRepository.getById(this.dependencies.defaultProject.id);

    if (existing) {
      return existing;
    }

    const timestamp = this.now();
    const project: Project = {
      id: this.dependencies.defaultProject.id,
      name: this.dependencies.defaultProject.name,
      repoUrl: this.dependencies.defaultProject.repoUrl,
      localRepoPath: this.dependencies.defaultProject.localRepoPath,
      defaultWorkflowPolicy: this.dependencies.defaultProject.defaultWorkflowPolicy,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.dependencies.projectRepository.create(project);
    return project;
  }

  private requireOpenSpecAdapter(): OpenSpecAdapter {
    if (!this.dependencies.openSpecAdapter) {
      throw new Error("OpenSpec adapter is not configured");
    }

    return this.dependencies.openSpecAdapter;
  }

  private requireTrackArtifactReader(): TrackArtifactReader {
    if (!this.dependencies.artifactReader) {
      throw new Error("Track artifact reader is not configured");
    }

    return this.dependencies.artifactReader;
  }

  private renderDefaultSpec(track: Track): string {
    const document: SpecDocument = {
      title: track.title,
      problem: track.description,
      goals: ["Define the MVP scope", "Ship one end-to-end path"],
      nonGoals: ["Database-backed persistence"],
      constraints: ["Artifact-first workflow", "Readable markdown outputs"],
      acceptanceCriteria: ["Track has spec, plan, and tasks artifacts"],
    };

    return renderSpecDocument(document);
  }

  private renderDefaultPlan(track: Track): string {
    const document: PlanDocument = {
      objective: track.title,
      approvalStatus: "draft",
      steps: [
        { title: "Clarify scope", detail: "Capture the MVP intent in spec.md" },
        { title: "Implement", detail: "Ship the smallest useful vertical slice" },
        { title: "Verify", detail: "Add tests and run the required checks" },
      ],
      risks: ["Prompt or workflow drift between artifacts and execution"],
      testStrategy: ["Automated tests for core behavior and API contract"],
    };

    return renderPlanDocument(document);
  }

  private renderDefaultTasks(track: Track): string {
    const document: TaskDocument = {
      trackTitle: track.title,
      tasks: [
        {
          id: `${track.id}-spec`,
          title: "Review generated spec artifact",
          status: "todo",
          priority: track.priority,
        },
        {
          id: `${track.id}-run`,
          title: "Start MVP execution",
          status: "todo",
          priority: track.priority,
        },
      ],
    };

    return renderTaskDocument(document);
  }
}
