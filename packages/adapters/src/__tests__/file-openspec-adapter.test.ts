import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Track } from "@specrail/core";

import { FileOpenSpecAdapter, type OpenSpecTrackPackage } from "../index.js";

function createTrack(): Track {
  return {
    id: "track-openspec-1",
    projectId: "project-default",
    title: "OpenSpec adapter boundary",
    description: "Ship a first import/export scaffold.",
    status: "planned",
    specStatus: "approved",
    planStatus: "pending",
    priority: "high",
    githubIssue: { number: 35, url: "https://github.com/yoophi-a/specrail/issues/35" },
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
  };
}

function createPackage(): OpenSpecTrackPackage {
  return {
    metadata: {
      version: 1,
      format: "specrail.openspec.bundle",
      exportedAt: "2026-04-10T00:00:00.000Z",
      generatedBy: "specrail",
    },
    track: createTrack(),
    files: {
      spec: "spec.md",
      plan: "plan.md",
      tasks: "tasks.md",
    },
    artifacts: {
      spec: "# Spec\n\nProblem statement\n",
      plan: "# Plan\n\n1. Define contracts\n",
      tasks: "# Tasks\n\n- [ ] Add adapter\n",
    },
  };
}

test("FileOpenSpecAdapter exports a file bundle with manifest and artifacts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-openspec-export-"));
  const targetDir = path.join(rootDir, "bundle");
  const adapter = new FileOpenSpecAdapter({ now: () => "2026-04-10T01:02:03.000Z" });

  const result = await adapter.exportPackage({
    package: createPackage(),
    target: { kind: "file", path: targetDir },
  });

  assert.equal(result.package.metadata.exportedAt, "2026-04-10T01:02:03.000Z");

  const manifest = JSON.parse(await readFile(path.join(targetDir, "openspec.json"), "utf8")) as {
    metadata: { format: string; exportedAt: string };
    track: { id: string };
    files: { spec: string; plan: string; tasks: string };
  };

  assert.equal(manifest.metadata.format, "specrail.openspec.bundle");
  assert.equal(manifest.metadata.exportedAt, "2026-04-10T01:02:03.000Z");
  assert.equal(manifest.track.id, "track-openspec-1");
  assert.equal(await readFile(path.join(targetDir, manifest.files.spec), "utf8"), createPackage().artifacts.spec);
  assert.equal(await readFile(path.join(targetDir, manifest.files.plan), "utf8"), createPackage().artifacts.plan);
  assert.equal(await readFile(path.join(targetDir, manifest.files.tasks), "utf8"), createPackage().artifacts.tasks);
});

test("FileOpenSpecAdapter imports a file bundle back into a typed package", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-openspec-import-"));
  const bundleDir = path.join(rootDir, "bundle");
  const adapter = new FileOpenSpecAdapter();
  const pkg = createPackage();

  await adapter.exportPackage({
    package: pkg,
    target: { kind: "file", path: bundleDir },
  });

  const result = await adapter.importPackage({ source: { kind: "file", path: bundleDir } });

  assert.equal(result.package.track.id, pkg.track.id);
  assert.equal(result.package.track.githubIssue?.number, 35);
  assert.equal(result.package.artifacts.spec, pkg.artifacts.spec);
  assert.equal(result.package.artifacts.plan, pkg.artifacts.plan);
  assert.equal(result.package.artifacts.tasks, pkg.artifacts.tasks);
  assert.equal(result.package.files.spec, "spec.md");
});

test("FileOpenSpecAdapter rejects invalid manifests", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-openspec-invalid-"));
  await writeFile(
    path.join(rootDir, "openspec.json"),
    JSON.stringify({ metadata: { version: 1, format: "nope" }, track: { id: "track-1" }, files: {} }),
    "utf8",
  );

  const adapter = new FileOpenSpecAdapter();

  await assert.rejects(
    () => adapter.importPackage({ source: { kind: "file", path: rootDir } }),
    /Invalid OpenSpec package manifest format/,
  );
});

test("FileOpenSpecAdapter does not overwrite an existing export target unless requested", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-openspec-overwrite-"));
  const targetDir = path.join(rootDir, "bundle");
  const adapter = new FileOpenSpecAdapter();

  await adapter.exportPackage({
    package: createPackage(),
    target: { kind: "file", path: targetDir },
  });

  await assert.rejects(
    () =>
      adapter.exportPackage({
        package: createPackage(),
        target: { kind: "file", path: targetDir },
      }),
    /already exists/,
  );

  const overwriteResult = await adapter.exportPackage({
    package: createPackage(),
    target: { kind: "file", path: targetDir, overwrite: true },
  });

  assert.equal(overwriteResult.target.overwrite, true);
});
