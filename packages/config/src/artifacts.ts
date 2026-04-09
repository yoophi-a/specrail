import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProjectArtifactPaths {
  rootDir: string;
  indexPath: string;
  workflowPath: string;
  tracksIndexPath: string;
  tracksDir: string;
}

export interface TrackArtifactPaths {
  trackDir: string;
  metadataPath: string;
  specPath: string;
  planPath: string;
  tasksPath: string;
  eventsPath: string;
}

export interface RepoArtifactPaths {
  rootDir: string;
  projectPath: string;
  tracksDir: string;
}

export interface RepoTrackArtifactPaths {
  trackDir: string;
  specPath: string;
  planPath: string;
  tasksPath: string;
  syncPath: string;
}

export interface MaterializeTrackArtifactsInput {
  rootDir: string;
  repoVisibleRootDir?: string;
  trackId: string;
  projectName: string;
  trackTitle: string;
  trackDescription: string;
  templateDir: string;
  specContent: string;
  planContent: string;
  tasksContent: string;
}

export function getProjectArtifactPaths(rootDir: string): ProjectArtifactPaths {
  return {
    rootDir,
    indexPath: path.join(rootDir, "index.md"),
    workflowPath: path.join(rootDir, "workflow.md"),
    tracksIndexPath: path.join(rootDir, "tracks.md"),
    tracksDir: path.join(rootDir, "tracks"),
  };
}

export function getTrackArtifactPaths(rootDir: string, trackId: string): TrackArtifactPaths {
  const trackDir = path.join(rootDir, "tracks", trackId);

  return {
    trackDir,
    metadataPath: path.join(trackDir, "track.json"),
    specPath: path.join(trackDir, "spec.md"),
    planPath: path.join(trackDir, "plan.md"),
    tasksPath: path.join(trackDir, "tasks.md"),
    eventsPath: path.join(trackDir, "events.jsonl"),
  };
}

export function getRepoArtifactPaths(rootDir: string): RepoArtifactPaths {
  return {
    rootDir,
    projectPath: path.join(rootDir, "project.yaml"),
    tracksDir: path.join(rootDir, "tracks"),
  };
}

export function getRepoTrackArtifactPaths(rootDir: string, trackId: string): RepoTrackArtifactPaths {
  const trackDir = path.join(rootDir, "tracks", trackId);

  return {
    trackDir,
    specPath: path.join(trackDir, "spec.md"),
    planPath: path.join(trackDir, "plan.md"),
    tasksPath: path.join(trackDir, "tasks.md"),
    syncPath: path.join(trackDir, "sync.json"),
  };
}

async function readTemplate(templateDir: string, fileName: string): Promise<string> {
  return readFile(path.join(templateDir, fileName), "utf8");
}

async function ensureProjectArtifacts(rootDir: string, templateDir: string, projectName: string): Promise<void> {
  const projectPaths = getProjectArtifactPaths(rootDir);

  await mkdir(projectPaths.tracksDir, { recursive: true });

  const indexTemplate = await readTemplate(templateDir, "index.md");
  const workflowTemplate = await readTemplate(templateDir, "workflow.md");
  const tracksTemplate = await readTemplate(templateDir, "tracks.md");

  await Promise.all([
    writeFile(projectPaths.indexPath, `${indexTemplate}\n\n## Project\n- Name: ${projectName}\n`, "utf8"),
    writeFile(projectPaths.workflowPath, workflowTemplate, "utf8"),
    writeFile(projectPaths.tracksIndexPath, tracksTemplate, "utf8"),
  ]);
}

async function ensureRepoArtifacts(rootDir: string, projectName: string): Promise<void> {
  const repoPaths = getRepoArtifactPaths(rootDir);

  await mkdir(repoPaths.tracksDir, { recursive: true });
  await writeFile(
    repoPaths.projectPath,
    [`version: 1`, `project: ${JSON.stringify(projectName)}`, `managedBy: specrail`, ``].join("\n"),
    "utf8",
  );
}

export async function materializeTrackArtifacts(input: MaterializeTrackArtifactsInput): Promise<TrackArtifactPaths> {
  const projectPaths = getProjectArtifactPaths(input.rootDir);
  const trackPaths = getTrackArtifactPaths(input.rootDir, input.trackId);

  await ensureProjectArtifacts(input.rootDir, input.templateDir, input.projectName);
  await mkdir(trackPaths.trackDir, { recursive: true });

  const trackMetadata = {
    id: input.trackId,
    title: input.trackTitle,
    description: input.trackDescription,
    artifactRoot: path.relative(projectPaths.rootDir, trackPaths.trackDir),
  };

  await Promise.all([
    writeFile(trackPaths.metadataPath, `${JSON.stringify(trackMetadata, null, 2)}\n`, "utf8"),
    writeFile(trackPaths.specPath, input.specContent, "utf8"),
    writeFile(trackPaths.planPath, input.planContent, "utf8"),
    writeFile(trackPaths.tasksPath, input.tasksContent, "utf8"),
    writeFile(trackPaths.eventsPath, "", "utf8"),
  ]);

  if (input.repoVisibleRootDir) {
    const repoTrackPaths = getRepoTrackArtifactPaths(input.repoVisibleRootDir, input.trackId);
    const repoPaths = getRepoArtifactPaths(input.repoVisibleRootDir);

    await ensureRepoArtifacts(input.repoVisibleRootDir, input.projectName);
    await mkdir(repoTrackPaths.trackDir, { recursive: true });

    const syncMetadata = {
      version: 1,
      trackId: input.trackId,
      syncedAt: new Date().toISOString(),
      source: {
        runtimeArtifactRoot: path.relative(input.repoVisibleRootDir, trackPaths.trackDir),
        runtimeDataRoot: path.relative(input.repoVisibleRootDir, input.rootDir),
      },
      files: {
        spec: path.relative(repoPaths.rootDir, repoTrackPaths.specPath),
        plan: path.relative(repoPaths.rootDir, repoTrackPaths.planPath),
        tasks: path.relative(repoPaths.rootDir, repoTrackPaths.tasksPath),
      },
    };

    await Promise.all([
      writeFile(repoTrackPaths.specPath, input.specContent, "utf8"),
      writeFile(repoTrackPaths.planPath, input.planContent, "utf8"),
      writeFile(repoTrackPaths.tasksPath, input.tasksContent, "utf8"),
      writeFile(repoTrackPaths.syncPath, `${JSON.stringify(syncMetadata, null, 2)}\n`, "utf8"),
    ]);
  }

  return trackPaths;
}
