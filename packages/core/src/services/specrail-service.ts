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
import type { Execution, ExecutionEvent, Project, Track } from "../domain/types.js";
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

export interface ResumeRunInput {
  runId: string;
  prompt: string;
}

export interface CancelRunInput {
  runId: string;
}

function buildExecutionSummary(events: ExecutionEvent[]): Execution["summary"] {
  const lastEvent = events.at(-1);

  return {
    eventCount: events.length,
    lastEventSummary: lastEvent?.summary,
    lastEventAt: lastEvent?.timestamp,
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

  async startRun(input: StartRunInput): Promise<Execution> {
    const track = await this.dependencies.trackRepository.getById(input.trackId);

    if (!track) {
      throw new Error(`Track not found: ${input.trackId}`);
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

    const execution: Execution = {
      id: executionId,
      trackId: track.id,
      backend: this.dependencies.executor.name,
      profile: input.profile ?? "default",
      workspacePath,
      branchName: `specrail/${executionId}`,
      sessionRef: launch.sessionRef,
      command: launch.command,
      summary: buildExecutionSummary(launch.events),
      status: "running",
      createdAt,
      startedAt: createdAt,
    };

    await this.dependencies.executionRepository.create(execution);

    for (const event of launch.events) {
      await this.dependencies.eventStore.append(event);
    }

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

    const nextEvents = [...(await this.dependencies.eventStore.listByExecution(execution.id)), ...launch.events];
    const resumedExecution: Execution = {
      ...execution,
      command: launch.command,
      summary: buildExecutionSummary(nextEvents),
      status: "running",
      startedAt: execution.startedAt ?? this.now(),
    };

    await this.dependencies.executionRepository.update(resumedExecution);

    for (const event of launch.events) {
      await this.dependencies.eventStore.append(event);
    }

    return resumedExecution;
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

    const nextEvents = [...(await this.dependencies.eventStore.listByExecution(execution.id)), cancellationEvent];
    const cancelledExecution: Execution = {
      ...execution,
      summary: buildExecutionSummary(nextEvents),
      status: "cancelled",
      finishedAt: this.now(),
    };

    await this.dependencies.executionRepository.update(cancelledExecution);
    await this.dependencies.eventStore.append(cancellationEvent);

    return cancelledExecution;
  }

  getRun(runId: string): Promise<Execution | null> {
    return this.dependencies.executionRepository.getById(runId);
  }

  listRunEvents(runId: string): Promise<ExecutionEvent[]> {
    return this.dependencies.eventStore.listByExecution(runId);
  }

  private async requireRun(runId: string): Promise<Execution> {
    const execution = await this.dependencies.executionRepository.getById(runId);

    if (!execution) {
      throw new Error(`Run not found: ${runId}`);
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
