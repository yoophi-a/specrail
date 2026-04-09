import type { Execution, ExecutionEvent, Project, Track } from "../domain/types.js";

export interface GitHubRunCommentTarget {
  kind: "issue" | "pull_request";
  number: number;
  url: string;
}

export interface GitHubRunCommentPublishResult {
  action: "created" | "updated" | "noop";
  target: GitHubRunCommentTarget;
  body: string;
  commentId?: number;
}

export interface GitHubRunCommentPublisher {
  publishRunSummary(input: {
    track: Track;
    run: Execution;
    events: ExecutionEvent[];
  }): Promise<GitHubRunCommentPublishResult[]>;
}

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
