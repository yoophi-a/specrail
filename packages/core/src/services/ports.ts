import type { Execution, ExecutionEvent, Project, Track } from "../domain/types.js";

export interface ProjectRepository {
  create(project: Project): Promise<void>;
  getById(projectId: string): Promise<Project | null>;
}

export interface TrackRepository {
  create(track: Track): Promise<void>;
  getById(trackId: string): Promise<Track | null>;
  update(track: Track): Promise<void>;
}

export interface ExecutionRepository {
  create(execution: Execution): Promise<void>;
  getById(executionId: string): Promise<Execution | null>;
  update(execution: Execution): Promise<void>;
}

export interface EventStore {
  append(event: ExecutionEvent): Promise<void>;
  listByExecution(executionId: string): Promise<ExecutionEvent[]>;
}
