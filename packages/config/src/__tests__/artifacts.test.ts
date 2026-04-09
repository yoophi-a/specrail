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

import { getProjectArtifactPaths, materializeTrackArtifacts } from "../artifacts.js";

test("materializeTrackArtifacts creates concrete .specrail files for a track", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "specrail-artifacts-"));
  const rootDir = path.join(tempRoot, ".specrail");
  const templateDir = path.resolve(process.cwd(), ".specrail-template");

  const trackPaths = await materializeTrackArtifacts({
    rootDir,
    templateDir,
    projectName: "SpecRail",
    trackId: "track-api-bootstrap",
    trackTitle: "Track API bootstrap",
    trackDescription: "Create the first deterministic control-plane artifacts.",
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
  const [indexContent, specContent, metadataContent, eventsContent] = await Promise.all([
    readFile(projectPaths.indexPath, "utf8"),
    readFile(trackPaths.specPath, "utf8"),
    readFile(trackPaths.metadataPath, "utf8"),
    readFile(trackPaths.eventsPath, "utf8"),
  ]);

  assert.match(indexContent, /Project\n- Name: SpecRail/);
  assert.match(specContent, /# Spec — Track API bootstrap/);
  assert.deepEqual(JSON.parse(metadataContent), {
    id: "track-api-bootstrap",
    title: "Track API bootstrap",
    description: "Create the first deterministic control-plane artifacts.",
    artifactRoot: path.join("tracks", "track-api-bootstrap"),
  });
  assert.equal(eventsContent, "");
});
