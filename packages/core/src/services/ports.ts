import type {
  AttachmentReference,
  ApprovalRequest,
  ArtifactRevision,
  ChannelBinding,
  Execution,
  ExecutionEvent,
  PlanningMessage,
  PlanningSession,
  Project,
  Track,
} from "../domain/types.js";

export interface ProjectRepository {
  create(project: Project): Promise<void>;
  getById(projectId: string): Promise<Project | null>;
}

export interface TrackRepository {
  create(track: Track): Promise<void>;
  getById(trackId: string): Promise<Track | null>;
  list(): Promise<Track[]>;
  update(track: Track): Promise<void>;
}

export interface PlanningSessionRepository {
  create(session: PlanningSession): Promise<void>;
  getById(sessionId: string): Promise<PlanningSession | null>;
  listByTrack(trackId: string): Promise<PlanningSession[]>;
  update(session: PlanningSession): Promise<void>;
}

export interface PlanningMessageStore {
  append(message: PlanningMessage): Promise<void>;
  listBySession(planningSessionId: string): Promise<PlanningMessage[]>;
}

export interface ArtifactRevisionRepository {
  create(revision: ArtifactRevision): Promise<void>;
  getById(revisionId: string): Promise<ArtifactRevision | null>;
  listByTrack(trackId: string, artifact?: ArtifactRevision["artifact"]): Promise<ArtifactRevision[]>;
  getLatestVersion(trackId: string, artifact: ArtifactRevision["artifact"]): Promise<number>;
  update(revision: ArtifactRevision): Promise<void>;
}

export interface ApprovalRequestRepository {
  create(request: ApprovalRequest): Promise<void>;
  getById(requestId: string): Promise<ApprovalRequest | null>;
  listByTrack(trackId: string, artifact?: ApprovalRequest["artifact"]): Promise<ApprovalRequest[]>;
  update(request: ApprovalRequest): Promise<void>;
}

export interface ChannelBindingRepository {
  create(binding: ChannelBinding): Promise<void>;
  getById(bindingId: string): Promise<ChannelBinding | null>;
  findByExternalRef(input: {
    channelType: ChannelBinding["channelType"];
    externalChatId: string;
    externalThreadId?: string;
  }): Promise<ChannelBinding | null>;
  list(): Promise<ChannelBinding[]>;
  update(binding: ChannelBinding): Promise<void>;
}

export interface AttachmentReferenceRepository {
  create(attachment: AttachmentReference): Promise<void>;
  getById(attachmentId: string): Promise<AttachmentReference | null>;
  listByTarget(input: { trackId?: string; planningSessionId?: string }): Promise<AttachmentReference[]>;
}

export interface ExecutionRepository {
  create(execution: Execution): Promise<void>;
  getById(executionId: string): Promise<Execution | null>;
  list(): Promise<Execution[]>;
  update(execution: Execution): Promise<void>;
}

export interface EventStore {
  append(event: ExecutionEvent): Promise<void>;
  listByExecution(executionId: string): Promise<ExecutionEvent[]>;
}
