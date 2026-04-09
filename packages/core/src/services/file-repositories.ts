import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Execution, ExecutionEvent, Project, Track } from "../domain/types.js";
import type {
  EventStore,
  ExecutionRepository,
  ProjectRepository,
  TrackRepository,
} from "./ports.js";

interface FileStatePaths {
  projectsDir: string;
  tracksDir: string;
  executionsDir: string;
  eventsDir: string;
}

function getStatePaths(rootDir: string): FileStatePaths {
  return {
    projectsDir: path.join(rootDir, "projects"),
    tracksDir: path.join(rootDir, "tracks"),
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

    const existing = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "";
      }

      throw error;
    });

    await writeFile(filePath, `${existing}${JSON.stringify(event)}\n`, "utf8");
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
