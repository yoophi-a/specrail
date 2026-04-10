import type {
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
