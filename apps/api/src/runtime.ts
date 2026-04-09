import { CodexAdapter, FileOpenSpecAdapter, GitHubRunCommentGhPublisher } from "@specrail/adapters";
import { loadConfig, materializeTrackArtifacts } from "@specrail/config";
import {
  FileExecutionRepository,
  FileGitHubRunCommentSyncStore,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
  SpecRailService,
  getStatePaths,
  type SpecRailServiceDependencies,
} from "@specrail/core";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DefaultDependencies {
  artifactRoot: string;
  eventLogDir: string;
  serviceDependencies: SpecRailServiceDependencies;
}

async function readTrackArtifacts(artifactRoot: string, trackId: string): Promise<{
  spec: string;
  plan: string;
  tasks: string;
}> {
  const { readFile } = await import("node:fs/promises");
  const paths = {
    spec: path.join(artifactRoot, "tracks", trackId, "spec.md"),
    plan: path.join(artifactRoot, "tracks", trackId, "plan.md"),
    tasks: path.join(artifactRoot, "tracks", trackId, "tasks.md"),
  };

  const [spec, plan, tasks] = await Promise.all([
    readFile(paths.spec, "utf8"),
    readFile(paths.plan, "utf8"),
    readFile(paths.tasks, "utf8"),
  ]);

  return { spec, plan, tasks };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function createDependencies(dataDir: string, repoArtifactRoot: string, githubPublishEnabled = false): DefaultDependencies {
  const stateDir = path.join(dataDir, "state");
  const artifactRoot = path.join(dataDir, "artifacts");
  const workspaceRoot = path.join(dataDir, "workspaces");
  const sessionsDir = path.join(dataDir, "sessions");
  const templateDir = path.join(repoRoot, ".specrail-template");

  const eventStore = new JsonlEventStore(stateDir);
  const githubRunCommentSyncStore = new FileGitHubRunCommentSyncStore(stateDir);
  const projectRepository = new FileProjectRepository(stateDir);
  const trackRepository = new FileTrackRepository(stateDir);
  const executionRepository = new FileExecutionRepository(stateDir);
  let service: SpecRailService | null = null;

  const serviceDependencies: SpecRailServiceDependencies = {
    projectRepository,
    trackRepository,
    executionRepository,
    eventStore,
    artifactWriter: {
      async write(input) {
        await materializeTrackArtifacts({
          rootDir: artifactRoot,
          repoVisibleRootDir: repoArtifactRoot,
          templateDir,
          trackId: input.track.id,
          projectName: input.project.name,
          trackTitle: input.track.title,
          trackDescription: input.track.description,
          openSpecImport: input.track.openSpecImport,
          specContent: input.specContent,
          planContent: input.planContent,
          tasksContent: input.tasksContent,
        });
      },
    },
    artifactReader: {
      async read(trackId) {
        return readTrackArtifacts(artifactRoot, trackId);
      },
    },
    executor: new CodexAdapter({
      sessionsDir,
      onEvent: async (event) => {
        if (service) {
          await service.recordExecutionEvent(event);
          return;
        }

        await eventStore.append(event);
      },
    }),
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
      repoUrl: "https://github.com/yoophi-a/specrail",
      localRepoPath: repoRoot,
      defaultWorkflowPolicy: "artifact-first-mvp",
    },
    workspaceRoot,
    openSpecAdapter: new FileOpenSpecAdapter(),
    githubRunCommentPublisher: githubPublishEnabled ? new GitHubRunCommentGhPublisher() : undefined,
    githubRunCommentSyncStore,
  };

  service = new SpecRailService(serviceDependencies);

  return {
    artifactRoot,
    eventLogDir: getStatePaths(stateDir).eventsDir,
    serviceDependencies,
  };
}

export function createDefaultService(): SpecRailService {
  const config = loadConfig();
  const dependencies = createDependencies(config.dataDir, config.repoArtifactDir, config.githubPublishEnabled);
  return new SpecRailService(dependencies.serviceDependencies);
}
