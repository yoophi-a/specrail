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
  AttachmentReference,
  ApprovalStatus,
  ApprovalRequest,
  ApprovalRequestStatus,
  ArtifactKind,
  ArtifactRevision,
  ChannelBinding,
  Execution,
  ExecutionEvent,
  ExecutionStatus,
  PlanningMessage,
  PlanningMessageKind,
  PlanningSession,
  PlanningSessionStatus,
  Project,
  Track,
  TrackStatus,
} from "../domain/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type {
  EventStore,
  ExecutionRepository,
  ApprovalRequestRepository,
  AttachmentReferenceRepository,
  ArtifactRevisionRepository,
  ChannelBindingRepository,
  PlanningMessageStore,
  PlanningSessionRepository,
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
  writeApprovedArtifact(input: {
    track: Track;
    project: Project;
    artifact: ArtifactKind;
    content: string;
  }): Promise<void>;
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
  planningSessionRepository: PlanningSessionRepository;
  planningMessageStore: PlanningMessageStore;
  artifactRevisionRepository: ArtifactRevisionRepository;
  approvalRequestRepository: ApprovalRequestRepository;
  channelBindingRepository: ChannelBindingRepository;
  attachmentReferenceRepository: AttachmentReferenceRepository;
  executionRepository: ExecutionRepository;
  eventStore: EventStore;
  artifactWriter: TrackArtifactWriter;
  executor?: ExecutionBackend;
  executors?: Record<string, ExecutionBackend>;
  defaultExecutionBackend?: string;
  defaultExecutionProfile?: string;
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
  backend?: string;
  profile?: string;
  planningSessionId?: string;
}

export interface UpdateTrackInput {
  trackId: string;
  status?: TrackStatus;
  specStatus?: ApprovalStatus;
  planStatus?: ApprovalStatus;
}

export interface CreatePlanningSessionInput {
  trackId: string;
  status?: PlanningSessionStatus;
}

export interface AppendPlanningMessageInput {
  planningSessionId: string;
  authorType: PlanningMessage["authorType"];
  kind?: PlanningMessageKind;
  body: string;
  relatedArtifact?: PlanningMessage["relatedArtifact"];
}

export interface ResumeRunInput {
  runId: string;
  prompt: string;
  backend?: string;
  profile?: string;
}

export interface CancelRunInput {
  runId: string;
}

export interface ProposeArtifactRevisionInput {
  trackId: string;
  artifact: ArtifactKind;
  content: string;
  summary?: string;
  createdBy: ArtifactRevision["createdBy"];
}

export interface DecideApprovalRequestInput {
  approvalRequestId: string;
  decidedBy: ApprovalRequest["requestedBy"];
  comment?: string;
}

export interface BindChannelInput {
  projectId: string;
  channelType: ChannelBinding["channelType"];
  externalChatId: string;
  externalThreadId?: string;
  externalUserId?: string;
  trackId?: string;
  planningSessionId?: string;
}

export interface RegisterAttachmentReferenceInput {
  sourceType: AttachmentReference["sourceType"];
  externalFileId: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
  trackId?: string;
  planningSessionId?: string;
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

export interface PlanningContextSnapshot {
  planningSessionId?: string;
  specRevisionId?: string;
  planRevisionId?: string;
  tasksRevisionId?: string;
  hasPendingChanges: boolean;
  updatedAt?: string;
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

  private listExecutors(): Record<string, ExecutionBackend> {
    if (this.dependencies.executors && Object.keys(this.dependencies.executors).length > 0) {
      return this.dependencies.executors;
    }

    if (this.dependencies.executor) {
      return { [this.dependencies.executor.name]: this.dependencies.executor };
    }

    throw new Error("SpecRailService requires at least one execution backend");
  }

  private resolveExecutor(name?: string): ExecutionBackend {
    const executors = this.listExecutors();
    const backendName = name ?? this.dependencies.defaultExecutionBackend ?? this.dependencies.executor?.name;

    if (!backendName) {
      throw new ValidationError("Execution backend is required");
    }

    const executor = executors[backendName];
    if (!executor) {
      throw new ValidationError(`Unsupported execution backend: ${backendName}`);
    }

    return executor;
  }

  private resolveExecutionProfile(profile?: string): string {
    return profile ?? this.dependencies.defaultExecutionProfile ?? "default";
  }

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
      planningSystem: project.defaultPlanningSystem ?? "native",
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

  async createPlanningSession(input: CreatePlanningSessionInput): Promise<PlanningSession> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const timestamp = this.now();
    const session: PlanningSession = {
      id: `planning-session-${this.idGenerator()}`,
      trackId: track.id,
      status: input.status ?? "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.dependencies.planningSessionRepository.create(session);
    return session;
  }

  getPlanningSession(sessionId: string): Promise<PlanningSession | null> {
    return this.dependencies.planningSessionRepository.getById(sessionId);
  }

  listPlanningSessions(trackId: string): Promise<PlanningSession[]> {
    return this.dependencies.planningSessionRepository.listByTrack(trackId);
  }

  async getTrackPlanningContext(trackId: string, planningSessionId?: string): Promise<PlanningContextSnapshot> {
    const track = await this.dependencies.trackRepository.getById(trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${trackId}`);
    }

    return this.resolvePlanningContext(track, planningSessionId);
  }

  async appendPlanningMessage(input: AppendPlanningMessageInput): Promise<PlanningMessage> {
    const session = await this.dependencies.planningSessionRepository.getById(input.planningSessionId);

    if (!session) {
      throw new NotFoundError(`Planning session not found: ${input.planningSessionId}`);
    }

    const timestamp = this.now();
    const message: PlanningMessage = {
      id: `planning-message-${this.idGenerator()}`,
      planningSessionId: session.id,
      authorType: input.authorType,
      kind: input.kind ?? "message",
      body: input.body,
      relatedArtifact: input.relatedArtifact,
      createdAt: timestamp,
    };

    await this.dependencies.planningMessageStore.append(message);
    await this.dependencies.planningSessionRepository.update({
      ...session,
      updatedAt: timestamp,
    });

    return message;
  }

  async bindChannel(input: BindChannelInput): Promise<ChannelBinding> {
    const project = await this.dependencies.projectRepository.getById(input.projectId);
    if (!project) {
      throw new NotFoundError(`Project not found: ${input.projectId}`);
    }

    if (input.trackId) {
      const track = await this.dependencies.trackRepository.getById(input.trackId);
      if (!track) {
        throw new NotFoundError(`Track not found: ${input.trackId}`);
      }

      if (track.projectId !== input.projectId) {
        throw new ValidationError(`Track does not belong to project: ${input.trackId}`);
      }
    }

    if (input.planningSessionId) {
      const session = await this.dependencies.planningSessionRepository.getById(input.planningSessionId);
      if (!session) {
        throw new NotFoundError(`Planning session not found: ${input.planningSessionId}`);
      }

      if (input.trackId && session.trackId !== input.trackId) {
        throw new ValidationError(`Planning session does not belong to track: ${input.planningSessionId}`);
      }
    }

    const existing = await this.dependencies.channelBindingRepository.findByExternalRef({
      channelType: input.channelType,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
    });
    const timestamp = this.now();

    const binding: ChannelBinding = existing
      ? {
          ...existing,
          externalUserId: input.externalUserId,
          trackId: input.trackId,
          planningSessionId: input.planningSessionId,
          updatedAt: timestamp,
        }
      : {
          id: `channel-binding-${this.idGenerator()}`,
          projectId: input.projectId,
          channelType: input.channelType,
          externalChatId: input.externalChatId,
          externalThreadId: input.externalThreadId,
          externalUserId: input.externalUserId,
          trackId: input.trackId,
          planningSessionId: input.planningSessionId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    if (existing) {
      await this.dependencies.channelBindingRepository.update(binding);
    } else {
      await this.dependencies.channelBindingRepository.create(binding);
    }

    return binding;
  }

  findChannelBindingByExternalRef(input: {
    channelType: ChannelBinding["channelType"];
    externalChatId: string;
    externalThreadId?: string;
  }): Promise<ChannelBinding | null> {
    return this.dependencies.channelBindingRepository.findByExternalRef(input);
  }

  async registerAttachmentReference(input: RegisterAttachmentReferenceInput): Promise<AttachmentReference> {
    if (input.trackId) {
      const track = await this.dependencies.trackRepository.getById(input.trackId);
      if (!track) {
        throw new NotFoundError(`Track not found: ${input.trackId}`);
      }
    }

    if (input.planningSessionId) {
      const session = await this.dependencies.planningSessionRepository.getById(input.planningSessionId);
      if (!session) {
        throw new NotFoundError(`Planning session not found: ${input.planningSessionId}`);
      }

      if (input.trackId && session.trackId !== input.trackId) {
        throw new ValidationError(`Planning session does not belong to track: ${input.planningSessionId}`);
      }
    }

    const attachment: AttachmentReference = {
      id: `attachment-reference-${this.idGenerator()}`,
      sourceType: input.sourceType,
      externalFileId: input.externalFileId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      localPath: input.localPath,
      trackId: input.trackId,
      planningSessionId: input.planningSessionId,
      uploadedAt: this.now(),
    };

    await this.dependencies.attachmentReferenceRepository.create(attachment);
    return attachment;
  }

  listAttachmentReferences(input: { trackId?: string; planningSessionId?: string }): Promise<AttachmentReference[]> {
    return this.dependencies.attachmentReferenceRepository.listByTarget(input);
  }

  async proposeArtifactRevision(
    input: ProposeArtifactRevisionInput,
  ): Promise<{ revision: ArtifactRevision; approvalRequest: ApprovalRequest }> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const timestamp = this.now();
    const version = (await this.dependencies.artifactRevisionRepository.getLatestVersion(track.id, input.artifact)) + 1;
    const revision: ArtifactRevision = {
      id: `artifact-revision-${this.idGenerator()}`,
      trackId: track.id,
      artifact: input.artifact,
      version,
      content: input.content,
      summary: input.summary,
      createdAt: timestamp,
      createdBy: input.createdBy,
    };
    const approvalRequest: ApprovalRequest = {
      id: `approval-request-${this.idGenerator()}`,
      trackId: track.id,
      artifact: input.artifact,
      revisionId: revision.id,
      status: "pending",
      requestedBy: input.createdBy,
      requestedAt: timestamp,
    };

    revision.approvalRequestId = approvalRequest.id;

    await this.dependencies.artifactRevisionRepository.create(revision);
    await this.dependencies.approvalRequestRepository.create(approvalRequest);
    await this.dependencies.trackRepository.update({
      ...track,
      ...this.getTrackApprovalPatch(track, input.artifact, "pending"),
      updatedAt: timestamp,
    });

    return { revision, approvalRequest };
  }

  listArtifactRevisions(trackId: string, artifact?: ArtifactKind): Promise<ArtifactRevision[]> {
    return this.dependencies.artifactRevisionRepository.listByTrack(trackId, artifact);
  }

  listApprovalRequests(trackId: string, artifact?: ArtifactKind): Promise<ApprovalRequest[]> {
    return this.dependencies.approvalRequestRepository.listByTrack(trackId, artifact);
  }

  async approveApprovalRequest(input: DecideApprovalRequestInput): Promise<ApprovalRequest> {
    return this.resolveApprovalRequest(input, "approved");
  }

  async rejectApprovalRequest(input: DecideApprovalRequestInput): Promise<ApprovalRequest> {
    return this.resolveApprovalRequest(input, "rejected");
  }

  async listPlanningMessages(planningSessionId: string): Promise<PlanningMessage[]> {
    const session = await this.dependencies.planningSessionRepository.getById(planningSessionId);

    if (!session) {
      throw new NotFoundError(`Planning session not found: ${planningSessionId}`);
    }

    return this.dependencies.planningMessageStore.listBySession(planningSessionId);
  }

  async startRun(input: StartRunInput): Promise<Execution> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new NotFoundError(`Track not found: ${input.trackId}`);
    }

    const executor = this.resolveExecutor(input.backend);
    const profile = this.resolveExecutionProfile(input.profile);
    const planningContext = await this.resolvePlanningContextForStart(track, input.planningSessionId);
    const executionId = `run-${this.idGenerator()}`;
    const createdAt = this.now();
    const workspacePath = path.join(this.dependencies.workspaceRoot, executionId);
    await mkdir(workspacePath, { recursive: true });

    const launch = await executor.spawn({
      executionId,
      prompt: input.prompt,
      workspacePath,
      profile,
    });

    const initialExecution: Execution = {
      id: executionId,
      trackId: track.id,
      backend: executor.name,
      profile,
      workspacePath,
      branchName: `specrail/${executionId}`,
      sessionRef: launch.sessionRef,
      command: launch.command,
      planningSessionId: planningContext.planningSessionId,
      specRevisionId: planningContext.specRevisionId,
      planRevisionId: planningContext.planRevisionId,
      tasksRevisionId: planningContext.tasksRevisionId,
      planningContextStale: false,
      planningContextUpdatedAt: planningContext.updatedAt,
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

    return this.hydrateExecutionPlanningContext(execution);
  }

  async resumeRun(input: ResumeRunInput): Promise<Execution> {
    const execution = await this.requireRun(input.runId);

    if (input.backend && input.backend !== execution.backend) {
      throw new ValidationError(`Run ${input.runId} is backed by ${execution.backend}, not ${input.backend}`);
    }

    if (!execution.sessionRef) {
      throw new Error(`Run is missing sessionRef: ${input.runId}`);
    }

    const executor = this.resolveExecutor(execution.backend);
    const profile = this.resolveExecutionProfile(input.profile ?? execution.profile);

    const launch = await executor.resume({
      executionId: execution.id,
      sessionRef: execution.sessionRef,
      prompt: input.prompt,
      workspacePath: execution.workspacePath,
      profile,
    });

    const resumedExecution: Execution = {
      ...execution,
      profile,
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

    return this.hydrateExecutionPlanningContext(reconciledExecution);
  }

  async cancelRun(input: CancelRunInput): Promise<Execution> {
    const execution = await this.requireRun(input.runId);

    if (!execution.sessionRef) {
      throw new Error(`Run is missing sessionRef: ${input.runId}`);
    }

    const cancellationEvent = await this.resolveExecutor(execution.backend).cancel({
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

    return this.hydrateExecutionPlanningContext(cancelledExecution);
  }

  async getRun(runId: string): Promise<Execution | null> {
    const execution = await this.dependencies.executionRepository.getById(runId);
    if (!execution) {
      return null;
    }

    return this.hydrateExecutionPlanningContext(execution);
  }

  async listRuns(input: ListRunsInput = {}): Promise<Execution[]> {
    const result = await this.listRunsPage(input);
    return Promise.all(result.items.map((execution) => this.hydrateExecutionPlanningContext(execution)));
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

    const result = buildListPageResult(sorted, page, pageSize);
    return {
      items: await Promise.all(result.items.map((execution) => this.hydrateExecutionPlanningContext(execution))),
      meta: result.meta,
    };
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
    await this.dependencies.executionRepository.update(await this.hydrateExecutionPlanningContext(reconciledExecution));
    await this.reconcileTrackStatusFromRun(reconciledExecution.trackId, reconciledExecution);
  }

  private async resolvePlanningContext(track: Track, planningSessionId?: string): Promise<PlanningContextSnapshot> {
    const [sessions, specRevisions, planRevisions, tasksRevisions] = await Promise.all([
      this.dependencies.planningSessionRepository.listByTrack(track.id),
      this.dependencies.artifactRevisionRepository.listByTrack(track.id, "spec"),
      this.dependencies.artifactRevisionRepository.listByTrack(track.id, "plan"),
      this.dependencies.artifactRevisionRepository.listByTrack(track.id, "tasks"),
    ]);

    const latestApprovedSpec = specRevisions.find((revision) => revision.approvedAt);
    const latestApprovedPlan = planRevisions.find((revision) => revision.approvedAt);
    const latestApprovedTasks = tasksRevisions.find((revision) => revision.approvedAt);
    const selectedSession = planningSessionId
      ? sessions.find((session) => session.id === planningSessionId)
      : sessions[0];

    if (planningSessionId && !selectedSession) {
      throw new ValidationError(`Planning session does not belong to track: ${planningSessionId}`);
    }

    const hasPendingChanges = [specRevisions, planRevisions, tasksRevisions].some((revisions) => {
      const latestApprovedAt = revisions.find((revision) => revision.approvedAt)?.approvedAt;
      return revisions.some((revision) => !revision.approvedAt && (!latestApprovedAt || revision.createdAt >= latestApprovedAt));
    });

    const timestamps = [
      selectedSession?.updatedAt,
      latestApprovedSpec?.approvedAt,
      latestApprovedPlan?.approvedAt,
      latestApprovedTasks?.approvedAt,
    ].filter((value): value is string => Boolean(value));

    return {
      planningSessionId: selectedSession?.id,
      specRevisionId: latestApprovedSpec?.id,
      planRevisionId: latestApprovedPlan?.id,
      tasksRevisionId: latestApprovedTasks?.id,
      hasPendingChanges,
      updatedAt: timestamps.sort((left, right) => right.localeCompare(left))[0],
    };
  }

  private async resolvePlanningContextForStart(track: Track, planningSessionId?: string): Promise<PlanningContextSnapshot> {
    const planningContext = await this.resolvePlanningContext(track, planningSessionId);
    const hasRevisionHistory = Boolean(
      planningContext.specRevisionId || planningContext.planRevisionId || planningContext.tasksRevisionId,
    );

    if (planningContext.hasPendingChanges) {
      throw new ValidationError(`Track has pending planning changes and cannot start a run: ${track.id}`);
    }

    if ((hasRevisionHistory || track.planStatus === "approved") && !planningContext.planRevisionId) {
      throw new ValidationError(`Track requires an approved plan revision before starting a run: ${track.id}`);
    }

    return planningContext;
  }

  private async hydrateExecutionPlanningContext(execution: Execution): Promise<Execution> {
    if (!execution.planningSessionId && !execution.specRevisionId && !execution.planRevisionId && !execution.tasksRevisionId) {
      return {
        ...execution,
        planningContextStale: false,
      };
    }

    const track = await this.dependencies.trackRepository.getById(execution.trackId);
    if (!track) {
      throw new NotFoundError(`Track not found: ${execution.trackId}`);
    }

    const planningContext = await this.resolvePlanningContext(track, execution.planningSessionId);
    const staleArtifacts: string[] = [];

    if (execution.specRevisionId && planningContext.specRevisionId && execution.specRevisionId !== planningContext.specRevisionId) {
      staleArtifacts.push("spec");
    }
    if (execution.planRevisionId && planningContext.planRevisionId && execution.planRevisionId !== planningContext.planRevisionId) {
      staleArtifacts.push("plan");
    }
    if (execution.tasksRevisionId && planningContext.tasksRevisionId && execution.tasksRevisionId !== planningContext.tasksRevisionId) {
      staleArtifacts.push("tasks");
    }

    return {
      ...execution,
      planningContextStale: staleArtifacts.length > 0,
      planningContextUpdatedAt: planningContext.updatedAt ?? execution.planningContextUpdatedAt,
      planningContextStaleReason:
        staleArtifacts.length > 0 ? `Approved planning context changed for: ${staleArtifacts.join(", ")}` : undefined,
    };
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

  private async resolveApprovalRequest(
    input: DecideApprovalRequestInput,
    nextStatus: ApprovalRequestStatus,
  ): Promise<ApprovalRequest> {
    const request = await this.dependencies.approvalRequestRepository.getById(input.approvalRequestId);

    if (!request) {
      throw new NotFoundError(`Approval request not found: ${input.approvalRequestId}`);
    }

    if (request.status !== "pending") {
      throw new Error(`Approval request is already ${request.status}: ${request.id}`);
    }

    const revision = await this.dependencies.artifactRevisionRepository.getById(request.revisionId);
    if (!revision) {
      throw new NotFoundError(`Artifact revision not found: ${request.revisionId}`);
    }

    const track = await this.dependencies.trackRepository.getById(request.trackId);
    if (!track) {
      throw new NotFoundError(`Track not found: ${request.trackId}`);
    }

    const project = await this.ensureDefaultProject();
    const timestamp = this.now();
    const resolvedRequest: ApprovalRequest = {
      ...request,
      status: nextStatus,
      decidedAt: timestamp,
      decidedBy: input.decidedBy,
      decisionComment: input.comment,
    };

    await this.dependencies.approvalRequestRepository.update(resolvedRequest);

    const trackApprovalStatus: ApprovalStatus = nextStatus === "approved" ? "approved" : "rejected";
    await this.dependencies.trackRepository.update({
      ...track,
      ...this.getTrackApprovalPatch(track, request.artifact, trackApprovalStatus),
      updatedAt: timestamp,
    });

    if (nextStatus === "approved") {
      await this.dependencies.artifactRevisionRepository.update({
        ...revision,
        approvedAt: timestamp,
      });
      await this.dependencies.artifactWriter.writeApprovedArtifact({
        track,
        project,
        artifact: request.artifact,
        content: revision.content,
      });
    }

    return resolvedRequest;
  }

  private getTrackApprovalPatch(track: Track, artifact: ArtifactKind, status: ApprovalStatus): Partial<Track> {
    switch (artifact) {
      case "spec":
        return { specStatus: status };
      case "plan":
        return { planStatus: status };
      case "tasks":
        return { status: status === "approved" ? track.status : track.status };
      default:
        return {};
    }
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
      defaultPlanningSystem: "native",
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
