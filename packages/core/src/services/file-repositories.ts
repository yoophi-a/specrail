import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Execution, ExecutionEvent, HeartbeatState, Project, Track } from "../domain/types.js";
import type {
  EventStore,
  ExecutionRepository,
  GitHubRunCommentSyncStore,
  HeartbeatStateStore,
  ProjectRepository,
  TrackRepository,
} from "./ports.js";
import type { GitHubRunCommentSyncState } from "../domain/types.js";

interface FileStatePaths {
  projectsDir: string;
  tracksDir: string;
  executionsDir: string;
  eventsDir: string;
  githubRunCommentSyncDir: string;
  automationDir: string;
}

export function getStatePaths(rootDir: string): FileStatePaths {
  return {
    projectsDir: path.join(rootDir, "projects"),
    tracksDir: path.join(rootDir, "tracks"),
    executionsDir: path.join(rootDir, "executions"),
    eventsDir: path.join(rootDir, "events"),
    githubRunCommentSyncDir: path.join(rootDir, "github-run-comment-sync"),
    automationDir: path.join(rootDir, "automation"),
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

export class FileGitHubRunCommentSyncStore implements GitHubRunCommentSyncStore {
  private readonly repository: JsonFileRepository<GitHubRunCommentSyncState>;

  constructor(rootDir: string) {
    this.repository = new JsonFileRepository<GitHubRunCommentSyncState>(getStatePaths(rootDir).githubRunCommentSyncDir);
  }

  getByTrackId(trackId: string): Promise<GitHubRunCommentSyncState | null> {
    return this.repository.getById(trackId);
  }

  upsert(state: GitHubRunCommentSyncState): Promise<void> {
    return this.repository.update(state);
  }
}

export class FileHeartbeatStateStore implements HeartbeatStateStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(getStatePaths(rootDir).automationDir, "heartbeat-state.json");
  }

  get(): Promise<HeartbeatState | null> {
    return readJsonFile<HeartbeatState>(this.filePath);
  }

  put(state: HeartbeatState): Promise<void> {
    return writeJsonFile(this.filePath, state);
  }
}
