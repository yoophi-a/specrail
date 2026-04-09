import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpecRailService } from "@specrail/core";

import { createDependencies } from "../runtime.js";

const execFileAsync = promisify(execFile);

async function createService(rootDir: string): Promise<SpecRailService> {
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  return new SpecRailService(dependencies.serviceDependencies);
}

test("CLI exports OpenSpec bundles and lists import/export history", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-openspec-export-"));
  const service = await createService(rootDir);

  const track = await service.createTrack({
    title: "CLI export source",
    description: "Source track for CLI export",
  });

  const bundleDir = path.join(rootDir, "bundle");
  const exportResult = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "export", "--track-id", track.id, "--path", bundleDir, "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
    },
  });
  const exportPayload = JSON.parse(exportResult.stdout) as {
    result: { target: { path: string }; package: { track: { id: string } } };
  };
  assert.equal(exportPayload.result.package.track.id, track.id);
  assert.equal(exportPayload.result.target.path, bundleDir);

  const exportHistoryResult = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "exports", "--track-id", track.id, "--page-size", "1", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
    },
  });
  const exportHistoryPayload = JSON.parse(exportHistoryResult.stdout) as {
    result: { items: Array<{ trackId: string; exportRecord: { target: { path: string } } }>; meta: { total: number; pageSize: number } };
  };
  assert.equal(exportHistoryPayload.result.items.length, 1);
  assert.equal(exportHistoryPayload.result.items[0]?.trackId, track.id);
  assert.equal(exportHistoryPayload.result.items[0]?.exportRecord.target.path, bundleDir);
  assert.equal(exportHistoryPayload.result.meta.total, 1);
  assert.equal(exportHistoryPayload.result.meta.pageSize, 1);

  await service.importTrackFromOpenSpec({
    source: { kind: "file", path: bundleDir },
    conflictPolicy: "resolve",
    resolutionPreset: "policyDefaults",
  });

  const historyResult = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "imports", "--track-id", track.id, "--page-size", "1", "--filter-conflict-policy", "resolve", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
    },
  });
  const historyPayload = JSON.parse(historyResult.stdout) as {
    result: {
      items: Array<{ trackId: string; provenance: { source: { path: string }; resolutionPreset?: string } }>;
      meta: { total: number; pageSize: number };
    };
  };
  assert.equal(historyPayload.result.items.length, 1);
  assert.equal(historyPayload.result.items[0]?.trackId, track.id);
  assert.equal(historyPayload.result.items[0]?.provenance.source.path, bundleDir);
  assert.equal(historyPayload.result.items[0]?.provenance.resolutionPreset, "policyDefaults");
  assert.equal(historyPayload.result.meta.total, 1);
  assert.equal(historyPayload.result.meta.pageSize, 1);
});

test("CLI previews and applies guided OpenSpec imports", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-openspec-"));
  const sourceService = await createService(path.join(rootDir, "source"));
  const targetService = await createService(path.join(rootDir, "target"));

  const track = await sourceService.createTrack({
    title: "CLI import source",
    description: "Source track for CLI import",
  });

  const bundleDir = path.join(rootDir, "bundle");
  await sourceService.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: bundleDir },
  });

  const preview = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "import", "--path", bundleDir, "--preset", "policyDefaults", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "target", "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "target", "repo-visible"),
    },
  });
  const previewPayload = JSON.parse(preview.stdout) as {
    result: { applied: boolean; conflictPolicy: string; operatorGuide: { selectedPreset: { name: string } | null } };
  };
  assert.equal(previewPayload.result.applied, false);
  assert.equal(previewPayload.result.conflictPolicy, "reject");
  assert.equal(previewPayload.result.operatorGuide.selectedPreset?.name, "policyDefaults");

  const apply = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "import", "--path", bundleDir, "--apply", "--preset", "policyDefaults", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "target", "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "target", "repo-visible"),
    },
  });
  const applyPayload = JSON.parse(apply.stdout) as {
    result: { applied: boolean; conflictPolicy: string; track: { id: string; openSpecImport?: { resolutionPreset?: string } } };
  };
  assert.equal(applyPayload.result.applied, true);
  assert.equal(applyPayload.result.conflictPolicy, "resolve");
  assert.equal(applyPayload.result.track.openSpecImport?.resolutionPreset, "policyDefaults");

  const importedTrack = await targetService.getTrack(track.id);
  assert.equal(importedTrack?.title, "CLI import source");

  const spec = await readFile(path.join(rootDir, "target", "data", "artifacts", "tracks", track.id, "spec.md"), "utf8");
  assert.ok(spec.includes("CLI import source"));
});

test("CLI exposes import help in JSON mode", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-openspec-help-"));

  const result = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "import", "help", "--preset", "policyDefaults", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
    },
  });

  const payload = JSON.parse(result.stdout) as {
    operatorGuide: { selectedPreset: { name: string } | null; examples: Array<{ id: string }> };
  };
  assert.equal(payload.operatorGuide.selectedPreset?.name, "policyDefaults");
  assert.ok(payload.operatorGuide.examples.some((example) => example.id === "preset-with-override"));
});

test("CLI inspects paginated track-scoped OpenSpec history", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-openspec-inspect-"));
  const service = await createService(rootDir);

  const track = await service.createTrack({
    title: "CLI inspect source",
    description: "Source track for CLI inspection",
  });

  const importBundleA = path.join(rootDir, "import-a");
  const importBundleB = path.join(rootDir, "import-b");
  const exportBundleA = path.join(rootDir, "export-a");
  const exportBundleB = path.join(rootDir, "export-b");

  await service.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: importBundleA },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: importBundleB },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.importTrackFromOpenSpec({
    source: { kind: "file", path: importBundleA },
    conflictPolicy: "overwrite",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.importTrackFromOpenSpec({
    source: { kind: "file", path: importBundleB },
    conflictPolicy: "resolve",
    resolutionPreset: "policyDefaults",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: exportBundleA },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: exportBundleB },
  });

  const env = {
    ...process.env,
    SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
    SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
  };
  const cwd = path.resolve(import.meta.dirname, "../..");

  const inspectResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "inspect", "--track-id", track.id, "--page-size", "1", "--export-page", "2", "--json"],
    { cwd, env },
  );
  const inspectPayload = JSON.parse(inspectResult.stdout) as {
    result: {
      trackId: string;
      imports: { items: Array<{ provenance: { source: { path: string } } }>; meta: { total: number; totalPages: number } };
      exports: { items: Array<{ exportRecord: { target: { path: string } } }>; meta: { total: number; totalPages: number } };
    };
  };
  assert.equal(inspectPayload.result.trackId, track.id);
  assert.equal(inspectPayload.result.imports.items.length, 1);
  assert.equal(inspectPayload.result.imports.meta.total, 2);
  assert.equal(inspectPayload.result.imports.meta.totalPages, 2);
  assert.equal(inspectPayload.result.exports.items.length, 1);
  assert.equal(inspectPayload.result.exports.meta.total, 3);
  assert.equal(inspectPayload.result.exports.meta.totalPages, 3);
  assert.ok([
    importBundleB,
    exportBundleA,
  ].includes(inspectPayload.result.exports.items[0]?.exportRecord.target.path ?? ""));

  const importInspectResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "inspect", "imports", "--track-id", track.id, "--page", "2", "--page-size", "1", "--json"],
    { cwd, env },
  );
  const importInspectPayload = JSON.parse(importInspectResult.stdout) as {
    result: {
      trackId: string;
      imports: { items: Array<{ provenance: { source: { path: string } } }>; meta: { total: number; totalPages: number } };
    };
  };
  assert.equal(importInspectPayload.result.trackId, track.id);
  assert.equal(importInspectPayload.result.imports.items.length, 1);
  assert.equal(importInspectPayload.result.imports.meta.total, 2);
  assert.equal(importInspectPayload.result.imports.items[0]?.provenance.source.path, importBundleA);

  const exportInspectResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "inspect", "exports", "--track-id", track.id, "--page", "2", "--page-size", "1"],
    { cwd, env },
  );
  assert.match(exportInspectResult.stdout, /OpenSpec track export inspection/);
  assert.match(exportInspectResult.stdout, /page 2\/3/);
  assert.match(exportInspectResult.stdout, /export-a/);
});
