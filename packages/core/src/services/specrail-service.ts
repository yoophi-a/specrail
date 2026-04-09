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
  Project,
  Track,
  TrackStatus,
} from "../domain/types.js";
import { NotFoundError } from "../errors.js";
import type { EventStore, ExecutionRepository, ProjectRepository, TrackRepository } from "./ports.js";

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
  executor: ExecutionBackend;
  defaultProject: {
    id: string;
    name: string;
    repoUrl?: string;
    localRepoPath?: string;
    defaultWorkflowPolicy?: string;
  };
  workspaceRoot: string;
  now?: () => string;
  idGenerator?: () => string;
}

export interface CreateTrackInput {
  title: string;
  description: string;
  priority?: Track["priority"];
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
}

export interface ResumeRunInput {
  runId: string;
  prompt: string;
}

export interface CancelRunInput {
  runId: string;
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
  if (event.type !== "task_status_changed") {
    return null;
  }

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
      title: input.title,
      description: input.description,
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
      updatedAt: this.now(),
    };

    await this.dependencies.trackRepository.update(nextTrack);

    return nextTrack;
  }

  async startRun(input: StartRunInput): Promise<Execution> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const executionId = `run-${this.idGenerator()}`;
    const createdAt = this.now();
    const workspacePath = path.join(this.dependencies.workspaceRoot, executionId);
    await mkdir(workspacePath, { recursive: true });

    const launch = await this.dependencies.executor.spawn({
      executionId,
      prompt: input.prompt,
      workspacePath,
      profile: input.profile ?? "default",
    });

    const initialExecution: Execution = {
      id: executionId,
      trackId: track.id,
      backend: this.dependencies.executor.name,
      profile: input.profile ?? "default",
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
    await this.reconcileTrackStatusFromRun(track.id, execution);

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
      prompt: input.prompt,
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
    await this.reconcileTrackStatusFromRun(reconciledExecution.trackId, reconciledExecution);

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
    await this.reconcileTrackStatusFromRun(cancelledExecution.trackId, cancelledExecution);

    return cancelledExecution;
  }

  getRun(runId: string): Promise<Execution | null> {
    return this.dependencies.executionRepository.getById(runId);
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
    await this.reconcileTrackStatusFromRun(reconciledExecution.trackId, reconciledExecution);
  }

  private async reconcileTrackStatusFromRun(trackId: string, execution: Execution): Promise<void> {
    const nextStatus = mapTrackStatusFromExecution(execution.status);
    if (!nextStatus) {
      return;
    }

    const track = await this.dependencies.trackRepository.getById(trackId);
    if (!track || track.status === nextStatus) {
      return;
    }

    await this.dependencies.trackRepository.update({
      ...track,
      status: nextStatus,
      updatedAt: execution.finishedAt ?? this.now(),
    });
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
