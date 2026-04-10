import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpecRailService } from "@specrail/core";

import { createSpecRailHttpServer } from "../index.js";
import { createDependencies } from "../runtime.js";

const execFileAsync = promisify(execFile);

async function waitForStdout(proc: ReturnType<typeof spawn>, matcher: (output: string) => boolean): Promise<string> {
  if (!proc.stdout) {
    throw new Error("spawned process did not expose stdout");
  }
  const stdout = proc.stdout;

  let output = "";

  if (matcher(output)) {
    return output;
  }

  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: string | Buffer): void => {
      output += chunk.toString();
      if (matcher(output)) {
        cleanup();
        resolve(output);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`process exited before matcher was satisfied: ${output}`));
    };
    const cleanup = (): void => {
      stdout.off("data", onData);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };

    stdout.on("data", onData);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

async function createService(rootDir: string): Promise<SpecRailService> {
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  return new SpecRailService(dependencies.serviceDependencies);
}

async function stopProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGINT"): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }

  proc.kill(signal);
  const exitPromise = once(proc, "exit");
  await Promise.race([
    exitPromise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`process did not exit after ${signal}`));
      }, 1500);
    }),
  ]).catch(async () => {
    await exitPromise;
  });
}

async function withServer(rootDir: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  const server = createSpecRailHttpServer({
    service: new SpecRailService(dependencies.serviceDependencies),
    artifactRoot: dependencies.artifactRoot,
    eventLogDir: dependencies.eventLogDir,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to resolve test server address");
    }

    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
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
  assert.match(runInspectResult.stdout, /completionVerification: not_applicable/);
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

test("CLI updates track workflow state locally through admin commands", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-track-update-"));
  const service = await createService(rootDir);

  const track = await service.createTrack({
    title: "CLI track update",
    description: "Exercise local track workflow update commands",
  });

  const env = {
    ...process.env,
    SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
    SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
  };
  const cwd = path.resolve(import.meta.dirname, "../..");

  const updateResult = await execFileAsync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "tracks",
      "update",
      "--track-id",
      track.id,
      "--status",
      "review",
      "--spec-status",
      "approved",
      "--plan-status",
      "pending",
      "--github-issue-number",
      "55",
      "--github-issue-url",
      "https://github.com/yoophi-a/specrail/issues/55",
      "--github-pr-number",
      "77",
      "--github-pr-url",
      "https://github.com/yoophi-a/specrail/pull/77",
      "--json",
    ],
    { cwd, env },
  );
  const updatePayload = JSON.parse(updateResult.stdout) as {
    result: {
      track: {
        id: string;
        status: string;
        specStatus: string;
        planStatus: string;
        githubIssue?: { number: number; url: string };
        githubPullRequest?: { number: number; url: string };
      };
      meta: { action: string; source: string };
    };
  };
  assert.equal(updatePayload.result.track.id, track.id);
  assert.equal(updatePayload.result.track.status, "review");
  assert.equal(updatePayload.result.track.specStatus, "approved");
  assert.equal(updatePayload.result.track.planStatus, "pending");
  assert.deepEqual(updatePayload.result.track.githubIssue, {
    number: 55,
    url: "https://github.com/yoophi-a/specrail/issues/55",
  });
  assert.deepEqual(updatePayload.result.track.githubPullRequest, {
    number: 77,
    url: "https://github.com/yoophi-a/specrail/pull/77",
  });
  assert.equal(updatePayload.result.meta.action, "update");
  assert.equal(updatePayload.result.meta.source, "local");

  const statusResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "tracks", "status", "--track-id", track.id, "--status", "blocked"],
    { cwd, env },
  );
  assert.match(statusResult.stdout, /Track .* updated \(status, local\)/);
  assert.match(statusResult.stdout, /status: blocked/);

  const specStatusResult = await execFileAsync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "tracks",
      "spec-status",
      "--track-id",
      track.id,
      "--spec-status",
      "draft",
      "--json",
    ],
    { cwd, env },
  );
  const specStatusPayload = JSON.parse(specStatusResult.stdout) as {
    result: { track: { specStatus: string }; meta: { action: string; source: string } };
  };
  assert.equal(specStatusPayload.result.track.specStatus, "draft");
  assert.equal(specStatusPayload.result.meta.action, "spec-status");
  assert.equal(specStatusPayload.result.meta.source, "local");

  const planStatusResult = await execFileAsync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "tracks",
      "plan-status",
      "--track-id",
      track.id,
      "--plan-status",
      "approved",
      "--json",
    ],
    { cwd, env },
  );
  const planStatusPayload = JSON.parse(planStatusResult.stdout) as {
    result: { track: { planStatus: string }; meta: { action: string; source: string } };
  };
  assert.equal(planStatusPayload.result.track.planStatus, "approved");
  assert.equal(planStatusPayload.result.meta.action, "plan-status");
  assert.equal(planStatusPayload.result.meta.source, "local");

  const persisted = await service.getTrack(track.id);
  assert.equal(persisted?.status, "blocked");
  assert.equal(persisted?.specStatus, "draft");
  assert.equal(persisted?.planStatus, "approved");
  assert.deepEqual(persisted?.githubIssue, {
    number: 55,
    url: "https://github.com/yoophi-a/specrail/issues/55",
  });
  assert.deepEqual(persisted?.githubPullRequest, {
    number: 77,
    url: "https://github.com/yoophi-a/specrail/pull/77",
  });
});

test("CLI lists run event history and tail output", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-run-events-"));
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  const service = new SpecRailService(dependencies.serviceDependencies);

  const track = await service.createTrack({
    title: "CLI run events",
    description: "Inspect run event history from the shell",
  });
  const run = {
    id: "run_cli_events",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: path.join(rootDir, "data", "workspaces", "run_cli_events"),
    branchName: "specrail/run_cli_events",
    status: "running" as const,
    createdAt: "2026-04-10T00:00:00.000Z",
    startedAt: "2026-04-10T00:00:00.500Z",
  };
  await dependencies.serviceDependencies.executionRepository.create(run);

  await service.recordExecutionEvent({
    id: `${run.id}_event_1`,
    executionId: run.id,
    type: "message",
    timestamp: "2026-04-10T00:00:01.000Z",
    source: "agent",
    summary: "Started planning",
    payload: { step: 1 },
  });
  await service.recordExecutionEvent({
    id: `${run.id}_event_2`,
    executionId: run.id,
    type: "tool_call",
    timestamp: "2026-04-10T00:00:02.000Z",
    source: "agent",
    summary: "Called listRuns",
  });
  await service.recordExecutionEvent({
    id: `${run.id}_event_3`,
    executionId: run.id,
    type: "summary",
    timestamp: "2026-04-10T00:00:03.000Z",
    source: "system",
    summary: "Run completed",
  });

  const env = {
    ...process.env,
    SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
    SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
  };
  const cwd = path.resolve(import.meta.dirname, "../..");

  const historyResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "events", "--run-id", run.id, "--after", "2026-04-10T00:00:02.000Z", "--type", "summary"],
    { cwd, env },
  );
  assert.match(historyResult.stdout, new RegExp(`Run event history for ${run.id}`));
  assert.match(historyResult.stdout, /Run completed/);
  assert.doesNotMatch(historyResult.stdout, /Started planning/);

  const tailJsonResult = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "tail", "--run-id", run.id, "--limit", "2", "--json"],
    { cwd, env },
  );
  const tailJsonPayload = JSON.parse(tailJsonResult.stdout) as {
    result: {
      run: { id: string };
      events: Array<{ summary: string; type: string }>;
      meta: { mode: string; total: number; limit: number | null };
    };
  };
  assert.equal(tailJsonPayload.result.run.id, run.id);
  assert.deepEqual(tailJsonPayload.result.events.map((event) => event.summary), ["Called listRuns", "Run completed"]);
  assert.equal(tailJsonPayload.result.meta.mode, "tail");
  assert.equal(tailJsonPayload.result.meta.total, 2);
  assert.equal(tailJsonPayload.result.meta.limit, 2);
});

test("CLI follows appended run events in human and json modes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-run-follow-"));
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  const service = new SpecRailService(dependencies.serviceDependencies);

  const track = await service.createTrack({
    title: "CLI run follow",
    description: "Follow appended run events from the shell",
  });
  const run = {
    id: "run_cli_follow",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: path.join(rootDir, "data", "workspaces", "run_cli_follow"),
    branchName: "specrail/run_cli_follow",
    status: "running" as const,
    createdAt: "2026-04-10T00:00:00.000Z",
    startedAt: "2026-04-10T00:00:00.500Z",
  };
  await dependencies.serviceDependencies.executionRepository.create(run);

  await service.recordExecutionEvent({
    id: `${run.id}_event_1`,
    executionId: run.id,
    type: "message",
    timestamp: "2026-04-10T00:00:01.000Z",
    source: "agent",
    summary: "Queued initial work",
  });

  const env = {
    ...process.env,
    SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
    SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
  };
  const cwd = path.resolve(import.meta.dirname, "../..");

  const humanFollow = spawn(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "tail", "--run-id", run.id, "--limit", "1", "--follow"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const initialHumanOutput = await waitForStdout(humanFollow, (output) => output.includes("Queued initial work"));
  assert.match(initialHumanOutput, /Run event tail for run_cli_follow live/);

  await service.recordExecutionEvent({
    id: `${run.id}_event_2`,
    executionId: run.id,
    type: "summary",
    timestamp: "2026-04-10T00:00:02.000Z",
    source: "system",
    summary: "Completed follow-up work",
  });

  const finalHumanOutput = await waitForStdout(humanFollow, (output) => output.includes("Completed follow-up work"));
  assert.match(finalHumanOutput, /Completed follow-up work/);
  humanFollow.kill("SIGINT");
  await once(humanFollow, "exit");

  const jsonFollow = spawn(
    "pnpm",
    ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "runs", "tail", "--run-id", run.id, "--limit", "1", "--follow", "--json"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const initialJsonOutput = await waitForStdout(jsonFollow, (output) => output.includes("Completed follow-up work"));
  const initialJsonLines = initialJsonOutput.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { mode: string; event: { summary: string } });
  assert.equal(initialJsonLines.at(-1)?.mode, "follow");
  assert.equal(initialJsonLines.at(-1)?.event.summary, "Completed follow-up work");

  await service.recordExecutionEvent({
    id: `${run.id}_event_3`,
    executionId: run.id,
    type: "tool_result",
    timestamp: "2026-04-10T00:00:03.000Z",
    source: "agent",
    summary: "Captured final output",
  });

  const finalJsonOutput = await waitForStdout(jsonFollow, (output) => output.includes("Captured final output"));
  const finalJsonLines = finalJsonOutput.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { mode: string; event: { summary: string } });
  assert.equal(finalJsonLines.at(-1)?.event.summary, "Captured final output");
  jsonFollow.kill("SIGINT");
  await once(jsonFollow, "exit");
});

test("CLI supports remote run lifecycle/list/inspect/events across shared API mode", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-run-remote-"));

  await withServer(rootDir, async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "CLI remote run commands",
        description: "Exercise shared remote API mode",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const cwd = path.resolve(import.meta.dirname, "../..");
    const env = {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "missing-data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "missing-repo-visible"),
      SPECRAIL_API_BASE_URL: baseUrl,
    };

    const startResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "runs",
      "start",
      "--track-id",
      trackPayload.track.id,
      "--prompt",
      "Start remote shared mode test",
      "--profile",
      "default",
      "--json",
    ], { cwd, env });
    const startPayload = JSON.parse(startResult.stdout) as {
      result: { run: { id: string; trackId: string; profile: string; status: string }; meta: { action: string; source: string } };
    };
    assert.equal(startPayload.result.run.trackId, trackPayload.track.id);
    assert.equal(startPayload.result.run.profile, "default");
    assert.equal(startPayload.result.meta.action, "start");
    assert.equal(startPayload.result.meta.source, "remote");

    const resumeResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "runs",
      "resume",
      "--run-id",
      startPayload.result.run.id,
      "--prompt",
      "Resume remote shared mode test",
      "--json",
    ], { cwd, env });
    const resumePayload = JSON.parse(resumeResult.stdout) as {
      result: { run: { id: string; summary?: { eventCount: number; lastEventSummary?: string } }; meta: { action: string; source: string } };
    };
    assert.equal(resumePayload.result.run.id, startPayload.result.run.id);
    assert.equal(resumePayload.result.meta.action, "resume");
    assert.equal(resumePayload.result.meta.source, "remote");
    assert.ok((resumePayload.result.run.summary?.eventCount ?? 0) >= 2);

    const cancelResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "runs",
      "cancel",
      "--run-id",
      startPayload.result.run.id,
      "--json",
    ], { cwd, env });
    const cancelPayload = JSON.parse(cancelResult.stdout) as {
      result: { run: { id: string; status: string; summary?: { lastEventSummary?: string } }; meta: { action: string; source: string } };
    };
    assert.equal(cancelPayload.result.run.id, startPayload.result.run.id);
    assert.equal(cancelPayload.result.run.status, "cancelled");
    assert.equal(cancelPayload.result.meta.action, "cancel");
    assert.equal(cancelPayload.result.meta.source, "remote");
    assert.match(cancelPayload.result.run.summary?.lastEventSummary ?? "", /cancel/i);

    const listResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "runs",
      "list",
      "--track-id",
      trackPayload.track.id,
      "--json",
    ], { cwd, env });
    const listPayload = JSON.parse(listResult.stdout) as {
      result: { runs: Array<{ id: string; trackId: string }>; meta: { total: number; page: number; pageSize: number } };
    };
    assert.deepEqual(listPayload.result.runs.map((run) => run.id), [startPayload.result.run.id]);
    assert.equal(listPayload.result.runs[0]?.trackId, trackPayload.track.id);
    assert.equal(listPayload.result.meta.total, 1);
    assert.equal(listPayload.result.meta.page, 1);
    assert.equal(listPayload.result.meta.pageSize, 20);

    const inspectResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "runs",
      "inspect",
      "--run-id",
      startPayload.result.run.id,
      "--api-url",
      baseUrl,
      "--json",
    ], { cwd, env: { ...env, SPECRAIL_API_BASE_URL: undefined } });
    const inspectPayload = JSON.parse(inspectResult.stdout) as {
      result: { run: { id: string; trackId: string; summary?: { eventCount: number } } };
    };
    assert.equal(inspectPayload.result.run.id, startPayload.result.run.id);
    assert.equal(inspectPayload.result.run.trackId, trackPayload.track.id);
    assert.ok((inspectPayload.result.run.summary?.eventCount ?? 0) >= 1);

    const eventsResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "runs",
      "events",
      "--run-id",
      startPayload.result.run.id,
      "--limit",
      "1",
      "--json",
    ], { cwd, env });
    const eventsPayload = JSON.parse(eventsResult.stdout) as {
      result: { run: { id: string }; events: Array<{ executionId: string }>; meta: { mode: string; total: number; limit: number } };
    };
    assert.equal(eventsPayload.result.run.id, startPayload.result.run.id);
    assert.equal(eventsPayload.result.events.length, 1);
    assert.equal(eventsPayload.result.events[0]?.executionId, startPayload.result.run.id);
    assert.equal(eventsPayload.result.meta.mode, "history");
    assert.equal(eventsPayload.result.meta.limit, 1);
  });
});

test("CLI updates track workflow state through shared remote API mode", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-track-remote-"));

  await withServer(rootDir, async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "CLI remote track commands",
        description: "Exercise shared remote track update mode",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const cwd = path.resolve(import.meta.dirname, "../..");
    const env = {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "missing-data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "missing-repo-visible"),
      SPECRAIL_API_BASE_URL: baseUrl,
    };

    const workflowResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "tracks",
      "workflow",
      "--track-id",
      trackPayload.track.id,
      "--status",
      "review",
      "--spec-status",
      "approved",
      "--plan-status",
      "pending",
      "--github-issue-number",
      "55",
      "--github-issue-url",
      "https://github.com/yoophi-a/specrail/issues/55",
      "--json",
    ], { cwd, env });
    const workflowPayload = JSON.parse(workflowResult.stdout) as {
      result: {
        track: { id: string; status: string; specStatus: string; planStatus: string; githubIssue?: { number: number; url: string } };
        meta: { action: string; source: string };
      };
    };
    assert.equal(workflowPayload.result.track.id, trackPayload.track.id);
    assert.equal(workflowPayload.result.track.status, "review");
    assert.equal(workflowPayload.result.track.specStatus, "approved");
    assert.equal(workflowPayload.result.track.planStatus, "pending");
    assert.deepEqual(workflowPayload.result.track.githubIssue, {
      number: 55,
      url: "https://github.com/yoophi-a/specrail/issues/55",
    });
    assert.equal(workflowPayload.result.meta.action, "workflow");
    assert.equal(workflowPayload.result.meta.source, "remote");

    const statusResult = await execFileAsync("pnpm", [
      "exec",
      "tsx",
      "--tsconfig",
      "../../tsconfig.base.json",
      "src/cli.ts",
      "tracks",
      "status",
      "--track-id",
      trackPayload.track.id,
      "--status",
      "blocked",
      "--json",
    ], { cwd, env });
    const statusPayload = JSON.parse(statusResult.stdout) as {
      result: { track: { status: string }; meta: { action: string; source: string } };
    };
    assert.equal(statusPayload.result.track.status, "blocked");
    assert.equal(statusPayload.result.meta.action, "status");
    assert.equal(statusPayload.result.meta.source, "remote");

    const inspectResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    const inspectPayload = (await inspectResponse.json()) as {
      track: { status: string; specStatus: string; planStatus: string; githubIssue?: { number: number; url: string } };
    };
    assert.equal(inspectPayload.track.status, "blocked");
    assert.equal(inspectPayload.track.specStatus, "approved");
    assert.equal(inspectPayload.track.planStatus, "pending");
    assert.deepEqual(inspectPayload.track.githubIssue, {
      number: 55,
      url: "https://github.com/yoophi-a/specrail/issues/55",
    });
  });
});

test("CLI follows run events over remote SSE when api-url is provided", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-run-follow-remote-"));

  await withServer(rootDir, async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "CLI remote run follow",
        description: "Follow run events via HTTP/SSE",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const createRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Start remote follow test",
      }),
    });
    const runPayload = (await createRunResponse.json()) as { run: { id: string } };

    const env = {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "missing-data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "missing-repo-visible"),
    };
    const cwd = path.resolve(import.meta.dirname, "../..");

    const remoteFollow = spawn(
      "pnpm",
      [
        "exec",
        "tsx",
        "--tsconfig",
        "../../tsconfig.base.json",
        "src/cli.ts",
        "runs",
        "tail",
        "--run-id",
        runPayload.run.id,
        "--limit",
        "1",
        "--follow",
        "--api-url",
        baseUrl,
        "--json",
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    const initialOutput = await waitForStdout(remoteFollow, (output) => output.trim().split("\n").filter(Boolean).length >= 1);
    const initialLines = initialOutput.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { source?: string; event: { summary: string } });
    assert.equal(initialLines.at(-1)?.source, "remote");
    assert.ok((initialLines.at(-1)?.event.summary ?? "").length > 0);

    const resumeResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue remote follow test" }),
    });
    assert.equal(resumeResponse.status, 200);

    const finalOutput = await waitForStdout(remoteFollow, (output) => output.trim().split("\n").filter(Boolean).length >= initialLines.length + 1);
    const finalLines = finalOutput.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { source?: string; event: { summary: string } });
    assert.equal(finalLines.at(-1)?.source, "remote");
    assert.notEqual(finalLines.at(-1)?.event.summary, initialLines.at(-1)?.event.summary);

    await stopProcess(remoteFollow);
  });
});
