import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderPlanDocument,
  renderSpecDocument,
  renderTaskDocument,
} from "@specrail/core";

import {
  getProjectArtifactPaths,
  getRepoArtifactPaths,
  getRepoTrackArtifactPaths,
  materializeTrackArtifacts,
} from "../artifacts.js";

test("materializeTrackArtifacts creates runtime and repo-visible .specrail files for a track", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "specrail-artifacts-"));
  const rootDir = path.join(tempRoot, ".specrail-data", "artifacts");
  const repoVisibleRootDir = path.join(tempRoot, ".specrail");
  const templateDir = path.resolve(process.cwd(), ".specrail-template");

  const trackPaths = await materializeTrackArtifacts({
    rootDir,
    repoVisibleRootDir,
    templateDir,
    projectName: "SpecRail",
    trackId: "track-api-bootstrap",
    trackTitle: "Track API bootstrap",
    trackDescription: "Create the first deterministic control-plane artifacts.",
    openSpecImport: {
      source: { kind: "file", path: "/tmp/specrail/bundles/bootstrap" },
      importedAt: "2026-04-10T05:00:00.000Z",
      conflictPolicy: "overwrite",
      bundle: {
        version: 1,
        format: "specrail.openspec.bundle",
        exportedAt: "2026-04-10T04:50:00.000Z",
        generatedBy: "specrail",
      },
    },
    specContent: renderSpecDocument({
      title: "Track API bootstrap",
      problem: "The project needs deterministic track artifacts.",
      goals: ["Write spec.md", "Write plan.md", "Write tasks.md"],
      nonGoals: ["DB migrations"],
      constraints: ["Artifact-first MVP"],
      acceptanceCriteria: ["Track directory is fully materialized"],
    }),
    planContent: renderPlanDocument({
      objective: "Create the first track artifact tree",
      approvalStatus: "draft",
      steps: [{ title: "Write files", detail: "Persist markdown and metadata" }],
      risks: ["Format drift"],
      testStrategy: ["Node tests with a temp directory"],
    }),
    tasksContent: renderTaskDocument({
      trackTitle: "Track API bootstrap",
      tasks: [{ id: "task-1", title: "Materialize artifacts", status: "todo", priority: "high" }],
    }),
  });

  const projectPaths = getProjectArtifactPaths(rootDir);
  const repoPaths = getRepoArtifactPaths(repoVisibleRootDir);
  const repoTrackPaths = getRepoTrackArtifactPaths(repoVisibleRootDir, "track-api-bootstrap");

  const [indexContent, specContent, metadataContent, eventsContent, projectContent, repoSpecContent, syncContent] = await Promise.all([
    readFile(projectPaths.indexPath, "utf8"),
    readFile(trackPaths.specPath, "utf8"),
    readFile(trackPaths.metadataPath, "utf8"),
    readFile(trackPaths.eventsPath, "utf8"),
    readFile(repoPaths.projectPath, "utf8"),
    readFile(repoTrackPaths.specPath, "utf8"),
    readFile(repoTrackPaths.syncPath, "utf8"),
  ]);

  assert.match(indexContent, /Project\n- Name: SpecRail/);
  assert.match(specContent, /# Spec — Track API bootstrap/);
  assert.deepEqual(JSON.parse(metadataContent), {
    id: "track-api-bootstrap",
    title: "Track API bootstrap",
    description: "Create the first deterministic control-plane artifacts.",
    artifactRoot: path.join("tracks", "track-api-bootstrap"),
    openSpecImport: {
      source: { kind: "file", path: "/tmp/specrail/bundles/bootstrap" },
      importedAt: "2026-04-10T05:00:00.000Z",
      conflictPolicy: "overwrite",
      bundle: {
        version: 1,
        format: "specrail.openspec.bundle",
        exportedAt: "2026-04-10T04:50:00.000Z",
        generatedBy: "specrail",
      },
    },
  });
  assert.equal(eventsContent, "");

  assert.match(projectContent, /version: 1/);
  assert.match(projectContent, /managedBy: specrail/);
  assert.equal(repoSpecContent, specContent);

  const syncMetadata = JSON.parse(syncContent) as {
    trackId: string;
    source: { runtimeArtifactRoot: string; runtimeDataRoot: string };
    files: { spec: string; plan: string; tasks: string };
    syncedAt: string;
  };

  assert.equal(syncMetadata.trackId, "track-api-bootstrap");
  assert.equal(syncMetadata.source.runtimeArtifactRoot, path.join("..", ".specrail-data", "artifacts", "tracks", "track-api-bootstrap"));
  assert.equal(syncMetadata.source.runtimeDataRoot, path.join("..", ".specrail-data", "artifacts"));
  assert.deepEqual(syncMetadata.files, {
    spec: path.join("tracks", "track-api-bootstrap", "spec.md"),
    plan: path.join("tracks", "track-api-bootstrap", "plan.md"),
    tasks: path.join("tracks", "track-api-bootstrap", "tasks.md"),
  });
  assert.match(syncMetadata.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
});
