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

export interface MaterializeTrackArtifactsInput {
  rootDir: string;
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

  return trackPaths;
}
