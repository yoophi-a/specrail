import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalRequest,
  ArtifactRevision,
  Execution,
  ExecutionEvent,
  PlanningMessage,
  PlanningSession,
  Project,
  Track,
} from "../domain/types.js";
import type {
  ApprovalRequestRepository,
  ArtifactRevisionRepository,
  EventStore,
  ExecutionRepository,
  PlanningMessageStore,
  PlanningSessionRepository,
  ProjectRepository,
  TrackRepository,
} from "./ports.js";

interface FileStatePaths {
  projectsDir: string;
  tracksDir: string;
  planningSessionsDir: string;
  planningMessagesDir: string;
  artifactRevisionsDir: string;
  approvalRequestsDir: string;
  executionsDir: string;
  eventsDir: string;
}

export function getStatePaths(rootDir: string): FileStatePaths {
  return {
    projectsDir: path.join(rootDir, "projects"),
    tracksDir: path.join(rootDir, "tracks"),
    planningSessionsDir: path.join(rootDir, "planning-sessions"),
    planningMessagesDir: path.join(rootDir, "planning-messages"),
    artifactRevisionsDir: path.join(rootDir, "artifact-revisions"),
    approvalRequestsDir: path.join(rootDir, "approval-requests"),
    executionsDir: path.join(rootDir, "executions"),
    eventsDir: path.join(rootDir, "events"),
  };
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

class JsonFileRepository<T extends { id: string }> {
  constructor(private readonly dirPath: string) {}

  async create(value: T): Promise<void> {
    await writeJsonFile(path.join(this.dirPath, `${value.id}.json`), value);
  }

  async getById(id: string): Promise<T | null> {
    return readJsonFile<T>(path.join(this.dirPath, `${id}.json`));
  }

  async update(value: T): Promise<void> {
    await writeJsonFile(path.join(this.dirPath, `${value.id}.json`), value);
  }

  async list(): Promise<T[]> {
    try {
      const entries = await readdir(this.dirPath, { withFileTypes: true });
      const values = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => readJsonFile<T>(path.join(this.dirPath, entry.name))),
      );

      const result: T[] = [];
      for (const value of values) {
        if (value) {
          result.push(value);
        }
      }

      return result;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}

export class FileProjectRepository implements ProjectRepository {
  private readonly repository: JsonFileRepository<Project>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<Project>(getStatePaths(rootDir).projectsDir);
  }

  create(project: Project): Promise<void> {
    return this.repository.create(project);
  }

  getById(projectId: string): Promise<Project | null> {
    return this.repository.getById(projectId);
  }
}

export class FileTrackRepository implements TrackRepository {
  private readonly repository: JsonFileRepository<Track>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<Track>(getStatePaths(rootDir).tracksDir);
  }

  create(track: Track): Promise<void> {
    return this.repository.create(track);
  }

  getById(trackId: string): Promise<Track | null> {
    return this.repository.getById(trackId);
  }

  list(): Promise<Track[]> {
    return this.repository.list();
  }

  update(track: Track): Promise<void> {
    return this.repository.update(track);
  }
}

export class FilePlanningSessionRepository implements PlanningSessionRepository {
  private readonly repository: JsonFileRepository<PlanningSession>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<PlanningSession>(getStatePaths(rootDir).planningSessionsDir);
  }

  create(session: PlanningSession): Promise<void> {
    return this.repository.create(session);
  }

  getById(sessionId: string): Promise<PlanningSession | null> {
    return this.repository.getById(sessionId);
  }

  async listByTrack(trackId: string): Promise<PlanningSession[]> {
    const sessions = await this.repository.list();
    return sessions
      .filter((session) => session.trackId === trackId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  update(session: PlanningSession): Promise<void> {
    return this.repository.update(session);
  }
}

export class JsonlPlanningMessageStore implements PlanningMessageStore {
  private readonly messagesDir: string;

  constructor(rootDir: string) {
    this.messagesDir = getStatePaths(rootDir).planningMessagesDir;
  }

  async append(message: PlanningMessage): Promise<void> {
    const filePath = path.join(this.messagesDir, `${message.planningSessionId}.jsonl`);
    await ensureDir(path.dirname(filePath));
    await appendFile(filePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  async listBySession(planningSessionId: string): Promise<PlanningMessage[]> {
    const filePath = path.join(this.messagesDir, `${planningSessionId}.jsonl`);

    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PlanningMessage);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}

export class FileExecutionRepository implements ExecutionRepository {
  private readonly repository: JsonFileRepository<Execution>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<Execution>(getStatePaths(rootDir).executionsDir);
  }

  create(execution: Execution): Promise<void> {
    return this.repository.create(execution);
  }

  getById(executionId: string): Promise<Execution | null> {
    return this.repository.getById(executionId);
  }

  list(): Promise<Execution[]> {
    return this.repository.list();
  }

  update(execution: Execution): Promise<void> {
    return this.repository.update(execution);
  }
}

export class FileArtifactRevisionRepository implements ArtifactRevisionRepository {
  private readonly repository: JsonFileRepository<ArtifactRevision>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<ArtifactRevision>(getStatePaths(rootDir).artifactRevisionsDir);
  }

  create(revision: ArtifactRevision): Promise<void> {
    return this.repository.create(revision);
  }

  getById(revisionId: string): Promise<ArtifactRevision | null> {
    return this.repository.getById(revisionId);
  }

  async listByTrack(trackId: string, artifact?: ArtifactRevision["artifact"]): Promise<ArtifactRevision[]> {
    const revisions = await this.repository.list();
    return revisions
      .filter((revision) => revision.trackId === trackId)
      .filter((revision) => (artifact ? revision.artifact === artifact : true))
      .sort(
        (left, right) =>
          right.version - left.version || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
  }

  async getLatestVersion(trackId: string, artifact: ArtifactRevision["artifact"]): Promise<number> {
    const revisions = await this.listByTrack(trackId, artifact);
    return revisions[0]?.version ?? 0;
  }

  update(revision: ArtifactRevision): Promise<void> {
    return this.repository.update(revision);
  }
}

export class FileApprovalRequestRepository implements ApprovalRequestRepository {
  private readonly repository: JsonFileRepository<ApprovalRequest>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<ApprovalRequest>(getStatePaths(rootDir).approvalRequestsDir);
  }

  create(request: ApprovalRequest): Promise<void> {
    return this.repository.create(request);
  }

  getById(requestId: string): Promise<ApprovalRequest | null> {
    return this.repository.getById(requestId);
  }

  async listByTrack(trackId: string, artifact?: ApprovalRequest["artifact"]): Promise<ApprovalRequest[]> {
    const requests = await this.repository.list();
    return requests
      .filter((request) => request.trackId === trackId)
      .filter((request) => (artifact ? request.artifact === artifact : true))
      .sort(
        (left, right) =>
          right.requestedAt.localeCompare(left.requestedAt) || right.id.localeCompare(left.id),
      );
  }

  update(request: ApprovalRequest): Promise<void> {
    return this.repository.update(request);
  }
}

export class JsonlEventStore implements EventStore {
  private readonly eventsDir: string;

  constructor(rootDir: string) {
    this.eventsDir = getStatePaths(rootDir).eventsDir;
  }

  async append(event: ExecutionEvent): Promise<void> {
    const filePath = path.join(this.eventsDir, `${event.executionId}.jsonl`);
    await ensureDir(path.dirname(filePath));
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async listByExecution(executionId: string): Promise<ExecutionEvent[]> {
    const filePath = path.join(this.eventsDir, `${executionId}.jsonl`);

    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ExecutionEvent);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}
