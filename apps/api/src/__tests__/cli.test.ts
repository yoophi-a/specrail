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

test("CLI inspects track and run payloads", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-inspection-"));
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  const service = new SpecRailService(dependencies.serviceDependencies);

  const track = await service.createTrack({
    title: "CLI full inspection",
    description: "Track and run inspection payloads",
    githubIssue: { number: 48, url: "https://github.com/yoophi-a/specrail/issues/48" },
  });

  const run = {
    id: "run_cli_inspect",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: path.join(rootDir, "data", "workspaces", "run_cli_inspect"),
    branchName: "specrail/run_cli_inspect",
    sessionRef: "session:run_cli_inspect",
    command: {
      command: "codex",
      args: ["exec", "inspect"],
      cwd: path.join(rootDir, "repo-visible"),
      prompt: "Inspect CLI payloads",
    },
    summary: {
      eventCount: 2,
      lastEventSummary: "Waiting for approval",
      lastEventAt: "2026-04-10T00:20:00.000Z",
    },
    status: "waiting_approval" as const,
    createdAt: "2026-04-10T00:10:00.000Z",
    startedAt: "2026-04-10T00:12:00.000Z",
  };
  await dependencies.serviceDependencies.executionRepository.create(run);
  await dependencies.serviceDependencies.githubRunCommentSyncStore?.upsert({
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T00:25:00.000Z",
    comments: [
      {
        target: { kind: "issue", number: 48, url: "https://github.com/yoophi-a/specrail/issues/48" },
        commentId: 4801,
        lastRunId: run.id,
        lastRunStatus: "waiting_approval",
        lastPublishedAt: "2026-04-10T00:20:00.000Z",
        lastSyncStatus: "success",
      },
    ],
  });

  const env = {
    ...process.env,
    SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
    SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
  };
  const cwd = path.resolve(import.meta.dirname, "../..");

  const trackInspectResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "tracks", "inspect", "--track-id", track.id],
    { cwd, env },
  );
  assert.match(trackInspectResult.stdout, /Track inspection for/);
  assert.match(trackInspectResult.stdout, /CLI full inspection/);
  assert.match(trackInspectResult.stdout, /githubRunCommentSync: 1 comment target/);

  const integrationsInspectResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "tracks", "inspect", "integrations", "--track-id", track.id, "--json"],
    { cwd, env },
  );
  const integrationsPayload = JSON.parse(integrationsInspectResult.stdout) as {
    result: {
      trackId: string;
      github: { issue?: { number: number }; summary: { linkedTargetCount: number; syncedTargetCount: number } };
      openSpec: { imports: { meta: { total: number } } };
    };
  };
  assert.equal(integrationsPayload.result.trackId, track.id);
  assert.equal(integrationsPayload.result.github.issue?.number, 48);
  assert.equal(integrationsPayload.result.github.summary.linkedTargetCount, 1);
  assert.equal(integrationsPayload.result.github.summary.syncedTargetCount, 1);
  assert.equal(integrationsPayload.result.openSpec.imports.meta.total, 0);

  const runInspectResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "inspect", "--run-id", run.id],
    { cwd, env },
  );
  assert.match(runInspectResult.stdout, /Run inspection for run_cli_inspect/);
  assert.match(runInspectResult.stdout, /status: waiting_approval/);
  assert.match(runInspectResult.stdout, /githubRunCommentSyncForRun: 1 matching target/);
});

test("CLI lists tracks and runs with filters, pagination, sorting, and json output", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-listing-"));
  const service = await createService(rootDir);

  const trackAlpha = await service.createTrack({
    title: "Alpha track",
    description: "First track",
    priority: "high",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const trackBravo = await service.createTrack({
    title: "Bravo track",
    description: "Second track",
    priority: "low",
  });
  await service.updateTrack({ trackId: trackBravo.id, status: "ready" });

  const runAlpha = await service.startRun({ trackId: trackAlpha.id, prompt: "Run alpha", profile: "default" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const runBravo = await service.startRun({ trackId: trackBravo.id, prompt: "Run bravo", profile: "default" });
  await service.cancelRun({ runId: runBravo.id });

  const env = {
    ...process.env,
    SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
    SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
  };
  const cwd = path.resolve(import.meta.dirname, "../..");

  const trackListResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "tracks", "list", "--status", "blocked", "--sort-by", "title", "--sort-order", "asc"],
    { cwd, env },
  );
  assert.match(trackListResult.stdout, /Tracks \(page 1\/1, total 1\)/);
  assert.match(trackListResult.stdout, new RegExp(trackBravo.id));
  assert.doesNotMatch(trackListResult.stdout, new RegExp(trackAlpha.id));

  const trackListJsonResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "tracks", "list", "--page-size", "1", "--sort-by", "title", "--sort-order", "asc", "--json"],
    { cwd, env },
  );
  const trackListJsonPayload = JSON.parse(trackListJsonResult.stdout) as {
    result: { tracks: Array<{ id: string; title: string }>; meta: { total: number; totalPages: number; page: number; pageSize: number } };
  };
  assert.deepEqual(trackListJsonPayload.result.tracks.map((track) => track.title), ["Alpha track"]);
  assert.deepEqual(trackListJsonPayload.result.meta, {
    page: 1,
    pageSize: 1,
    total: 2,
    totalPages: 2,
    hasNextPage: true,
    hasPrevPage: false,
  });

  const runListResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "list", "--status", "cancelled", "--track-id", trackBravo.id],
    { cwd, env },
  );
  assert.match(runListResult.stdout, /Runs \(page 1\/1, total 1\)/);
  assert.match(runListResult.stdout, new RegExp(runBravo.id));
  assert.doesNotMatch(runListResult.stdout, new RegExp(runAlpha.id));

  const runListJsonResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "list", "--page-size", "1", "--sort-by", "createdAt", "--sort-order", "asc", "--json"],
    { cwd, env },
  );
  const runListJsonPayload = JSON.parse(runListJsonResult.stdout) as {
    result: { runs: Array<{ id: string }>; meta: { total: number; totalPages: number; page: number; pageSize: number } };
  };
  assert.deepEqual(runListJsonPayload.result.runs.map((run) => run.id), [runAlpha.id]);
  assert.deepEqual(runListJsonPayload.result.meta, {
    page: 1,
    pageSize: 1,
    total: 2,
    totalPages: 2,
    hasNextPage: true,
    hasPrevPage: false,
  });
});
