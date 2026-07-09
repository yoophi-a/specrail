import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  appendRunEvents,
  bootstrapTerminalState,
  createExecutionActionDraft,
  createEmptyRunEventFeedState,
  editTextWithTerminalEditor,
  exportRevisionDiffPatch,
  loadRevisionDiffExportManifest,
  loadTerminalPreferences,
  isTerminalEntrypoint,
  parsePlanningMessageTemplatesJson,
  renderAppShell,
  renderRevisionDiffLines,
  renderRevisionDiffPatch,
  refreshTerminalState,
  resolveTrackDefaultWorkspacePath,
  runTerminalApp,
  runTerminalCommand,
  saveTerminalPreferences,
  SpecRailTerminalApiClient,
  setRunFilter,
  selectNextItem,
  syncRunEventSelection,
  type TerminalAppState,
} from "../index.js";

test("isTerminalEntrypoint compares argv paths through file URLs", () => {
  const pathWithSpecialCharacters = "/tmp/specrail #terminal/index.js";
  assert.equal(isTerminalEntrypoint(pathToFileURL(pathWithSpecialCharacters).href, pathWithSpecialCharacters), true);
  assert.equal(isTerminalEntrypoint(pathToFileURL("/tmp/specrail-other/index.js").href, pathWithSpecialCharacters), false);
  assert.equal(isTerminalEntrypoint(pathToFileURL(pathWithSpecialCharacters).href, undefined), false);
});

test("SpecRailTerminalApiClient loads a summary snapshot", async () => {
  const requests: string[] = [];
  const client = new SpecRailTerminalApiClient("http://example.test/specrail", async (input) => {
    const url = String(input);
    requests.push(url);

    if (url === "http://example.test/specrail/projects") {
      return new Response(JSON.stringify({ projects: [{ id: "project-1", name: "SpecRail" }] }), { status: 200 });
    }

    if (url === "http://example.test/specrail/tracks?page=1&pageSize=20&projectId=project-1") {
      return new Response(JSON.stringify({ tracks: [{ id: "track-1", projectId: "project-1", title: "Terminal shell", status: "ready" }] }), { status: 200 });
    }

    if (url === "http://example.test/specrail/runs?page=1&pageSize=20") {
      return new Response(JSON.stringify({ runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }] }), {
        status: 200,
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const summary = await client.loadSummary("project-1");
  assert.equal(summary.projects?.[0]?.id, "project-1");
  assert.equal(summary.tracks[0]?.id, "track-1");
  assert.equal(summary.runs[0]?.id, "run-1");
  assert.deepEqual(requests, [
    "http://example.test/specrail/projects",
    "http://example.test/specrail/tracks?page=1&pageSize=20&projectId=project-1",
    "http://example.test/specrail/runs?page=1&pageSize=20",
  ]);
});

test("resolveTrackDefaultWorkspacePath prefers the selected project's local repo path", () => {
  assert.equal(
    resolveTrackDefaultWorkspacePath({
      track: { projectId: "project-1" },
      projects: [{ id: "project-1", name: "SpecRail", localRepoPath: "/workspace/specrail" }],
      fallbackPath: "/tmp/current-shell",
    }),
    "/workspace/specrail",
  );

  assert.equal(
    resolveTrackDefaultWorkspacePath({
      track: { projectId: "project-2" },
      projects: [{ id: "project-1", name: "SpecRail", localRepoPath: "/workspace/specrail" }],
      fallbackPath: "/tmp/current-shell",
    }),
    "/tmp/current-shell",
  );
});

test("SpecRailTerminalApiClient loads planning workspace details for a track", async () => {
  const requests: string[] = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push(url);

    if (url === "http://example.test/tracks/track%2F1" && !init?.method) {
      return new Response(
        JSON.stringify({
          track: { id: "track/1", title: "Terminal shell", status: "review", planStatus: "pending" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { planningSessionId: "planning/session-1", hasPendingChanges: true, updatedAt: "2026-04-10T12:00:00.000Z" },
        }),
        { status: 200 },
      );
    }

    if (url === "http://example.test/tracks/track%2F1/planning-sessions") {
      return new Response(JSON.stringify({ planningSessions: [{ id: "planning/session-1", trackId: "track/1", status: "active", updatedAt: "2026-04-10T12:00:00.000Z" }] }), { status: 200 });
    }

    if (url === "http://example.test/planning-sessions/planning%2Fsession-1/messages") {
      return new Response(JSON.stringify({ messages: [{ id: "msg-1", planningSessionId: "planning/session-1", authorType: "user", kind: "question", relatedArtifact: "plan", body: "Need approval?", createdAt: "2026-04-10T12:01:00.000Z" }] }), { status: 200 });
    }

    if (url === "http://example.test/tracks/track%2F1/artifacts/spec") {
      return new Response(JSON.stringify({ revisions: [], approvalRequests: [] }), { status: 200 });
    }

    if (url === "http://example.test/tracks/track%2F1/artifacts/plan") {
      return new Response(JSON.stringify({
        revisions: [{ id: "rev-1", trackId: "track/1", artifact: "plan", version: 1, createdBy: "agent", content: "# Plan v1", approvalRequestId: "approval-1", createdAt: "2026-04-10T12:00:30.000Z" }],
        approvalRequests: [{ id: "approval-1", trackId: "track/1", artifact: "plan", revisionId: "rev-1", status: "pending", requestedBy: "agent", createdAt: "2026-04-10T12:00:31.000Z" }],
      }), { status: 200 });
    }

    if (url === "http://example.test/tracks/track%2F1/artifacts/tasks") {
      return new Response(JSON.stringify({ revisions: [], approvalRequests: [] }), { status: 200 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const detail = await client.loadTrackDetail("track/1");
  assert.equal(detail.planningWorkspace?.planningSessions[0]?.id, "planning/session-1");
  assert.equal(detail.planningWorkspace?.planningMessages[0]?.body, "Need approval?");
  assert.equal(detail.planningWorkspace?.approvalRequests.plan[0]?.id, "approval-1");
  assert.equal(detail.planningWorkspace?.selectedApprovalRequestId, "approval-1");
  assert.deepEqual(requests, [
    "http://example.test/tracks/track%2F1",
    "http://example.test/tracks/track%2F1/planning-sessions",
    "http://example.test/planning-sessions/planning%2Fsession-1/messages",
    "http://example.test/tracks/track%2F1/artifacts/spec",
    "http://example.test/tracks/track%2F1/artifacts/plan",
    "http://example.test/tracks/track%2F1/artifacts/tasks",
  ]);
});

test("SpecRailTerminalApiClient surfaces API validation details for execution actions", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);

    if (url.endsWith("/runs") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            message: "request validation failed",
            details: [{ field: "prompt", message: "must not be empty" }],
          },
        }),
        { status: 422 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  await assert.rejects(() => client.startRun({ trackId: "track-1", prompt: "" }), /request validation failed \(prompt: must not be empty\)/);
});

test("SpecRailTerminalApiClient loads Markdown run reports", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test/specrail", async (input) => {
    const url = String(input);

    if (url === "http://example.test/specrail/runs/run%2F1/report.md") {
      return new Response("# Run Report — run/1\n", { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  assert.equal(await client.loadRunReportMarkdown("run/1"), "# Run Report — run/1\n");
});

test("SpecRailTerminalApiClient encodes opaque run ids for run-scoped actions", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test/specrail", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url === "http://example.test/specrail/runs/run%2F1") {
      return new Response(JSON.stringify({ run: { id: "run/1", trackId: "track-1", status: "running" } }), { status: 200 });
    }

    if (url === "http://example.test/specrail/runs/run%2F1/events") {
      return new Response(JSON.stringify({ events: [{ id: "event-1", executionId: "run/1", type: "summary", timestamp: "2026-04-10T12:00:00.000Z", source: "codex", summary: "Started" }] }), { status: 200 });
    }

    if (url === "http://example.test/specrail/runs/run%2F1/resume" && init?.method === "POST") {
      return new Response(JSON.stringify({ run: { id: "run/1", trackId: "track-1", status: "running" } }), { status: 200 });
    }

    if (url === "http://example.test/specrail/runs/run%2F1/cancel" && init?.method === "POST") {
      return new Response(JSON.stringify({ run: { id: "run/1", trackId: "track-1", status: "cancelled" } }), { status: 200 });
    }

    if (url === "http://example.test/specrail/runs/run%2F1/workspace-cleanup/preview") {
      return new Response(JSON.stringify({ cleanupPlan: { dryRun: true, eligible: false, operations: [], refusalReasons: ["run is active"] } }), { status: 200 });
    }

    if (url === "http://example.test/specrail/runs/run%2F1/workspace-cleanup/apply" && init?.method === "POST") {
      return new Response(JSON.stringify({ cleanupResult: { applied: false, status: "refused", operations: [], refusalReasons: ["run is active"] }, expectedConfirmation: "cleanup run/1" }), { status: 200 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  await client.loadRunDetail("run/1");
  await client.loadRunEvents("run/1");
  await client.resumeRun({ runId: "run/1", prompt: "Continue", backend: "codex", profile: "default" });
  await client.cancelRun("run/1");
  await client.previewWorkspaceCleanup("run/1");
  await client.applyWorkspaceCleanup("run/1", "cleanup run/1");

  assert.deepEqual(requests, [
    { url: "http://example.test/specrail/runs/run%2F1", method: undefined, body: undefined },
    { url: "http://example.test/specrail/runs/run%2F1/events", method: undefined, body: undefined },
    { url: "http://example.test/specrail/runs/run%2F1/resume", method: "POST", body: JSON.stringify({ prompt: "Continue", backend: "codex", profile: "default" }) },
    { url: "http://example.test/specrail/runs/run%2F1/cancel", method: "POST", body: undefined },
    { url: "http://example.test/specrail/runs/run%2F1/workspace-cleanup/preview", method: undefined, body: undefined },
    { url: "http://example.test/specrail/runs/run%2F1/workspace-cleanup/apply", method: "POST", body: JSON.stringify({ confirm: "cleanup run/1" }) },
  ]);
});

test("SpecRailTerminalApiClient supports folder session discovery, preview, and fork", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url === "http://example.test/runs?page=1&pageSize=10&workspacePath=%2Fworkspace%2Fapp") {
      return new Response(JSON.stringify({ runs: [{ id: "run-folder", trackId: "track-1", status: "completed", workspacePath: "/workspace/app", backend: "codex" }] }), { status: 200 });
    }

    if (url === "http://example.test/runs/run-folder/session-preview?eventLimit=5") {
      return new Response(JSON.stringify({ execution: { id: "run-folder", trackId: "track-1", status: "completed" }, session: { sessionRef: "run-folder-codex" }, capabilities: { supportsResume: true, supportsProviderFork: false, supportsContextCopyFork: true }, events: [{ id: "evt-1", executionId: "run-folder", type: "summary", timestamp: "2026-04-10T12:00:00.000Z", source: "codex", summary: "Run completed" }], reportPath: "/runs/run-folder/report.md" }), { status: 200 });
    }

    if (url === "http://example.test/runs/run-folder/fork" && init?.method === "POST") {
      assert.equal(init.body?.toString(), JSON.stringify({ prompt: "Continue from folder", backend: "codex", profile: "default" }));
      return new Response(JSON.stringify({ run: { id: "run-fork", trackId: "track-1", status: "running", parentExecutionId: "run-folder", backend: "codex" } }), { status: 201 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const runs = await client.listRunsByWorkspacePath("/workspace/app");
  assert.equal(runs[0]?.id, "run-folder");
  const preview = await client.loadRunSessionPreview("run-folder");
  assert.equal(preview.session?.sessionRef, "run-folder-codex");
  const fork = await client.forkRun({ runId: "run-folder", prompt: "Continue from folder", backend: "codex", profile: "default" });
  assert.equal(fork.run.id, "run-fork");
  assert.equal(requests.length, 3);
});

test("runTerminalCommand writes report command output to stdout", async () => {
  const writes: string[] = [];
  const handled = await runTerminalCommand({
    argv: ["report", "run/1"],
    env: { SPECRAIL_API_BASE_URL: "http://example.test/specrail" },
    stdout: { write: (chunk) => writes.push(chunk) },
    fetchImpl: async (input) => {
      assert.equal(String(input), "http://example.test/specrail/runs/run%2F1/report.md");
      return new Response("# Run Report — run/1", { status: 200 });
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(writes, ["# Run Report — run/1\n"]);
});

test("runTerminalCommand prints command help", async () => {
  const writes: string[] = [];

  assert.equal(
    await runTerminalCommand({
      argv: ["--help"],
      stdout: { write: (chunk) => writes.push(chunk) },
    }),
    true,
  );

  const output = writes.join("");
  assert.match(output, /Usage: specrail-terminal \[command\]/);
  assert.match(output, /report <runId> \[--output <file>\|-o <file>\]/);
  assert.match(output, /diff-exports \[--json\] \[--limit <n>\] \[--track <trackId>\] \[--artifact <kind>\]/);
  assert.match(output, /diff-export <index> \[--track <trackId>\] \[--artifact <kind>\] \[--output <file>\|-o <file>\]/);
  assert.match(output, /message-templates \[--json\] \[--output <file>\|-o <file>\]/);
});

test("runTerminalCommand writes report command output to an explicit file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-report-output-test-"));
  const outputPath = join(directory, "nested", "run-1-report.md");
  const writes: string[] = [];

  try {
    const handled = await runTerminalCommand({
      argv: ["report", " run-1 ", "--output", outputPath],
      env: { SPECRAIL_API_BASE_URL: "http://example.test" },
      stdout: { write: (chunk) => writes.push(chunk) },
      fetchImpl: async (input) => {
        assert.equal(String(input), "http://example.test/runs/run-1/report.md");
        return new Response("# Run Report — run-1", { status: 200 });
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(writes, []);
    assert.equal(await readFile(outputPath, "utf8"), "# Run Report — run-1\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand ignores non-report commands and validates report usage", async () => {
  assert.equal(await runTerminalCommand({ argv: ["interactive"] }), false);
  await assert.rejects(() => runTerminalCommand({ argv: ["report"] }), /Usage: specrail-terminal report <runId>/);
  await assert.rejects(() => runTerminalCommand({ argv: ["report", "run-1", "--output"] }), /Usage: specrail-terminal report <runId>/);
  await assert.rejects(() => runTerminalCommand({ argv: ["report", "run-1", "--output", "--bogus"] }), /Usage: specrail-terminal report <runId>/);
  await assert.rejects(() => runTerminalCommand({ argv: ["report", "run-1", "--bogus"] }), /Usage: specrail-terminal report <runId>/);
});

test("runTerminalCommand lists revision diff export manifest entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-diff-exports-command-test-"));
  const manifestPath = join(directory, "specrail-revision-diff-exports.jsonl");
  const olderEntry = {
    exportedAt: "2026-04-10T12:05:00.000Z",
    filePath: join(directory, "specrail-revision-diff-track-1-spec-v1-rev-1.patch"),
    trackId: "track-1",
    artifact: "spec",
    revisionId: "rev-1",
    version: 1,
  };
  const entry = {
    exportedAt: "2026-04-10T12:10:00.000Z",
    filePath: join(directory, "specrail-revision-diff-track-1-plan-v2-rev-2.patch"),
    trackId: "track-1",
    artifact: "plan",
    revisionId: "rev-2",
    version: 2,
  };
  const plainWrites: string[] = [];
  const jsonWrites: string[] = [];

  try {
    await writeFile(manifestPath, `${JSON.stringify(olderEntry)}\n${JSON.stringify(entry)}\n`, "utf8");

    assert.deepEqual(await loadRevisionDiffExportManifest(directory), [olderEntry, entry]);
    assert.equal(
      await runTerminalCommand({
        argv: ["diff-exports"],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => plainWrites.push(chunk) },
      }),
      true,
    );
    assert.match(plainWrites.join(""), /2026-04-10T12:10:00.000Z\ttrack-1\tplan\tv2\trev-2/);
    assert.ok(plainWrites.join("").indexOf("rev-2") < plainWrites.join("").indexOf("rev-1"));

    assert.equal(
      await runTerminalCommand({
        argv: ["diff-exports", "--json", "--limit", "1"],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => jsonWrites.push(chunk) },
      }),
      true,
    );
    assert.deepEqual(JSON.parse(jsonWrites.join("")), [entry]);
    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-exports", "--limit", "0"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /Usage: specrail-terminal diff-exports/,
    );
    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-exports", "--limit", "1e1"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /Usage: specrail-terminal diff-exports/,
    );
    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-exports", "--track", "--artifact", "plan"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /Usage: specrail-terminal diff-exports/,
    );
    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-exports", "--bogus"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /Usage: specrail-terminal diff-exports/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand filters revision diff export manifest entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-diff-exports-filter-test-"));
  const manifestPath = join(directory, "specrail-revision-diff-exports.jsonl");
  const plainWrites: string[] = [];
  const jsonWrites: string[] = [];

  try {
    await writeFile(
      manifestPath,
      [
        JSON.stringify({ exportedAt: "2026-04-10T12:05:00.000Z", filePath: "/tmp/spec.patch", trackId: "track-1", artifact: "spec", revisionId: "rev-1", version: 1 }),
        JSON.stringify({ exportedAt: "2026-04-10T12:10:00.000Z", filePath: "/tmp/plan.patch", trackId: "track-1", artifact: "plan", revisionId: "rev-2", version: 2 }),
        JSON.stringify({ exportedAt: "2026-04-10T12:15:00.000Z", filePath: "/tmp/tasks.patch", trackId: "track-2", artifact: "tasks", revisionId: "rev-3", version: 3 }),
      ].join("\n"),
      "utf8",
    );

    assert.equal(
      await runTerminalCommand({
        argv: ["diff-exports", "--track", "track-1", "--artifact", "plan"],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => plainWrites.push(chunk) },
      }),
      true,
    );
    assert.equal(plainWrites.join(""), "2026-04-10T12:10:00.000Z\ttrack-1\tplan\tv2\trev-2\t/tmp/plan.patch\n");

    assert.equal(
      await runTerminalCommand({
        argv: ["diff-exports", "--artifact", " Tasks ", "--limit", "1", "--json"],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => jsonWrites.push(chunk) },
      }),
      true,
    );
    assert.deepEqual(JSON.parse(jsonWrites.join("")), [
      { exportedAt: "2026-04-10T12:15:00.000Z", filePath: "/tmp/tasks.patch", trackId: "track-2", artifact: "tasks", revisionId: "rev-3", version: 3 },
    ]);

    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-exports", "--artifact", "notes"] }),
      /Usage: specrail-terminal diff-exports/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand handles missing revision diff export manifests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-diff-exports-empty-test-"));
  const writes: string[] = [];

  try {
    assert.deepEqual(await loadRevisionDiffExportManifest(directory), []);
    assert.equal(
      await runTerminalCommand({
        argv: ["diff-exports"],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => writes.push(chunk) },
      }),
      true,
    );
    assert.equal(writes.join(""), "No revision diff exports found.\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand prints revision diff export patch content by index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-diff-export-detail-test-"));
  const olderPatch = join(directory, "older.patch");
  const newerPatch = join(directory, "newer.patch");
  const manifestPath = join(directory, "specrail-revision-diff-exports.jsonl");
  const writes: string[] = [];

  try {
    await writeFile(olderPatch, "older patch\n", "utf8");
    await writeFile(newerPatch, "newer patch", "utf8");
    await writeFile(
      manifestPath,
      [
        JSON.stringify({ exportedAt: "2026-04-10T12:05:00.000Z", filePath: olderPatch, trackId: "track-1", artifact: "spec", revisionId: "rev-1", version: 1 }),
        JSON.stringify({ exportedAt: "2026-04-10T12:10:00.000Z", filePath: newerPatch, trackId: "track-1", artifact: "plan", revisionId: "rev-2", version: 2 }),
      ].join("\n"),
      "utf8",
    );

    assert.equal(
      await runTerminalCommand({
        argv: ["diff-export", "1"],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => writes.push(chunk) },
      }),
      true,
    );
    assert.equal(writes.join(""), "newer patch\n");

    await assert.rejects(() => runTerminalCommand({ argv: ["diff-export", "0"] }), /Usage: specrail-terminal diff-export <positive-index>/);
    await assert.rejects(() => runTerminalCommand({ argv: ["diff-export", "1e1"] }), /Usage: specrail-terminal diff-export <positive-index>/);
    await assert.rejects(() => runTerminalCommand({ argv: ["diff-export", "1", "--output", "--bogus"] }), /Usage: specrail-terminal diff-export <positive-index>/);
    await assert.rejects(() => runTerminalCommand({ argv: ["diff-export", "1", "--bogus"] }), /Usage: specrail-terminal diff-export <positive-index>/);
    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-export", "3"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /No revision diff export found at index 3/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand applies revision diff export filters before detail selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-diff-export-detail-filter-test-"));
  const specPatch = join(directory, "spec.patch");
  const planPatch = join(directory, "plan.patch");
  const taskPatch = join(directory, "task.patch");
  const manifestPath = join(directory, "specrail-revision-diff-exports.jsonl");
  const writes: string[] = [];

  try {
    await writeFile(specPatch, "spec patch\n", "utf8");
    await writeFile(planPatch, "plan patch\n", "utf8");
    await writeFile(taskPatch, "task patch\n", "utf8");
    await writeFile(
      manifestPath,
      [
        JSON.stringify({ exportedAt: "2026-04-10T12:05:00.000Z", filePath: specPatch, trackId: "track-1", artifact: "spec", revisionId: "rev-1", version: 1 }),
        JSON.stringify({ exportedAt: "2026-04-10T12:10:00.000Z", filePath: planPatch, trackId: "track-1", artifact: "plan", revisionId: "rev-2", version: 2 }),
        JSON.stringify({ exportedAt: "2026-04-10T12:15:00.000Z", filePath: taskPatch, trackId: "track-2", artifact: "tasks", revisionId: "rev-3", version: 3 }),
      ].join("\n"),
      "utf8",
    );

    assert.equal(
      await runTerminalCommand({
        argv: ["diff-export", "1", "--track", "track-1", "--artifact", " Spec "],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => writes.push(chunk) },
      }),
      true,
    );
    assert.equal(writes.join(""), "spec patch\n");

    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-export", "1", "--artifact", "none"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /Usage: specrail-terminal diff-export/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand writes revision diff export patch content to an explicit file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-diff-export-output-test-"));
  const patchPath = join(directory, "selected.patch");
  const outputPath = join(directory, "nested", "copied.patch");
  const manifestPath = join(directory, "specrail-revision-diff-exports.jsonl");
  const writes: string[] = [];

  try {
    await writeFile(patchPath, "selected patch", "utf8");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ exportedAt: "2026-04-10T12:05:00.000Z", filePath: patchPath, trackId: "track-1", artifact: "spec", revisionId: "rev-1", version: 1 })}\n`,
      "utf8",
    );

    assert.equal(
      await runTerminalCommand({
        argv: ["diff-export", "1", "-o", outputPath],
        env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory },
        stdout: { write: (chunk) => writes.push(chunk) },
      }),
      true,
    );

    assert.deepEqual(writes, []);
    assert.equal(await readFile(outputPath, "utf8"), "selected patch\n");
    await assert.rejects(
      () => runTerminalCommand({ argv: ["diff-export", "1", "--output"], env: { SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: directory } }),
      /Usage: specrail-terminal diff-export/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand lists planning message templates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-message-templates-command-test-"));
  const templatesPath = join(directory, "message-templates.json");
  const template = {
    name: "Team handoff",
    kind: "note",
    relatedArtifact: "tasks",
    body: "Team handoff:\n- State:\n- Owner:",
  };
  const plainWrites: string[] = [];
  const jsonWrites: string[] = [];

  try {
    await writeFile(templatesPath, JSON.stringify([template]), "utf8");

    assert.equal(
      await runTerminalCommand({
        argv: ["message-templates"],
        env: { SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: templatesPath },
        stdout: { write: (chunk) => plainWrites.push(chunk) },
      }),
      true,
    );
    assert.equal(plainWrites.join(""), "1\tTeam handoff\tnote\ttasks\n");

    assert.equal(
      await runTerminalCommand({
        argv: ["message-templates", "--json"],
        env: { SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: templatesPath },
        stdout: { write: (chunk) => jsonWrites.push(chunk) },
      }),
      true,
    );
    assert.deepEqual(JSON.parse(jsonWrites.join("")), [template]);

    await assert.rejects(
      () => runTerminalCommand({ argv: ["message-templates", "--bogus"], env: { SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: templatesPath } }),
      /Usage: specrail-terminal message-templates/,
    );
    await assert.rejects(
      () => runTerminalCommand({ argv: ["message-templates", "--output", "--json"], env: { SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: templatesPath } }),
      /Usage: specrail-terminal message-templates/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand surfaces invalid planning message template files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-message-templates-invalid-test-"));
  const templatesPath = join(directory, "message-templates.json");

  try {
    await writeFile(templatesPath, JSON.stringify([{ name: "Broken", kind: "memo", relatedArtifact: "plan", body: "Body" }]), "utf8");
    await assert.rejects(
      () => runTerminalCommand({ argv: ["message-templates"], env: { SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: templatesPath } }),
      /kind must be one of message, question, decision, note/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runTerminalCommand exports planning message templates to a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-message-templates-export-test-"));
  const templatesPath = join(directory, "message-templates.json");
  const outputPath = join(directory, "nested", "starter-templates.json");
  const template = {
    name: "Team question",
    kind: "question",
    relatedArtifact: "spec",
    body: "Question:\n- Context:\n- Decision needed:",
  };
  const writes: string[] = [];

  try {
    await writeFile(templatesPath, JSON.stringify([template]), "utf8");
    assert.equal(
      await runTerminalCommand({
        argv: ["message-templates", "--output", outputPath],
        env: { SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: templatesPath },
        stdout: { write: (chunk) => writes.push(chunk) },
      }),
      true,
    );

    assert.deepEqual(writes, []);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), [template]);
    await assert.rejects(
      () => runTerminalCommand({ argv: ["message-templates", "--output"] }),
      /Usage: specrail-terminal message-templates/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SpecRailTerminalApiClient submits artifact revision proposals and approval decisions", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url === "http://example.test/tracks/track%2F1/artifacts/plan" && init?.method === "POST") {
      assert.equal(init.body?.toString(), JSON.stringify({ content: "# Plan v2", summary: "Tighten milestones", createdBy: "user" }));
      return new Response(
        JSON.stringify({
          revision: { id: "rev-2", trackId: "track/1", artifact: "plan", version: 2, createdBy: "user", content: "# Plan v2", createdAt: "2026-04-13T11:00:00.000Z" },
          approvalRequest: { id: "approval/2", trackId: "track/1", artifact: "plan", revisionId: "rev-2", status: "pending", requestedBy: "user", createdAt: "2026-04-13T11:00:01.000Z" },
        }),
        { status: 201 },
      );
    }

    if (url === "http://example.test/approval-requests/approval%2F2/approve" && init?.method === "POST") {
      assert.equal(init.body?.toString(), JSON.stringify({ decidedBy: "terminal" }));
      return new Response(JSON.stringify({ approvalRequest: { id: "approval/2" } }), { status: 200 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await client.proposeArtifactRevision({
    trackId: "track/1",
    artifact: "plan",
    content: "# Plan v2",
    summary: "Tighten milestones",
    createdBy: "user",
  });

  assert.equal(result.revision.id, "rev-2");
  assert.equal(result.approvalRequest.id, "approval/2");
  await client.decideApprovalRequest("approval/2", "approve");
  assert.deepEqual(requests, [
    { url: "http://example.test/tracks/track%2F1/artifacts/plan", method: "POST", body: JSON.stringify({ content: "# Plan v2", summary: "Tighten milestones", createdBy: "user" }) },
    { url: "http://example.test/approval-requests/approval%2F2/approve", method: "POST", body: JSON.stringify({ decidedBy: "terminal" }) },
  ]);
});

test("SpecRailTerminalApiClient appends planning messages", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url.endsWith("/planning-sessions/plan-1/messages") && init?.method === "POST") {
      assert.equal(init.body?.toString(), JSON.stringify({
        authorType: "user",
        kind: "decision",
        body: "Proceed with the approved plan.",
        relatedArtifact: "plan",
      }));
      return new Response(
        JSON.stringify({
          message: {
            id: "msg-2",
            planningSessionId: "plan-1",
            authorType: "user",
            kind: "decision",
            relatedArtifact: "plan",
            body: "Proceed with the approved plan.",
            createdAt: "2026-04-13T11:30:00.000Z",
          },
        }),
        { status: 201 },
      );
    }

    if (url.endsWith("/planning-sessions/plan-2/messages") && init?.method === "POST") {
      assert.equal(init.body?.toString(), JSON.stringify({
        authorType: "agent",
        kind: "note",
        body: "No artifact focus yet.",
      }));
      return new Response(
        JSON.stringify({
          message: {
            id: "msg-3",
            planningSessionId: "plan-2",
            authorType: "agent",
            kind: "note",
            body: "No artifact focus yet.",
            createdAt: "2026-04-13T11:31:00.000Z",
          },
        }),
        { status: 201 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const message = await client.appendPlanningMessage({
    planningSessionId: "plan-1",
    authorType: "user",
    kind: "decision",
    body: "Proceed with the approved plan.",
    relatedArtifact: "plan",
  });

  const note = await client.appendPlanningMessage({
    planningSessionId: "plan-2",
    authorType: "agent",
    kind: "note",
    body: "No artifact focus yet.",
  });

  assert.equal(message.id, "msg-2");
  assert.equal(message.relatedArtifact, "plan");
  assert.equal(note.id, "msg-3");
  assert.equal(note.relatedArtifact, undefined);
  assert.equal(requests[0]?.url, "http://example.test/planning-sessions/plan-1/messages");
  assert.equal(requests[1]?.body?.includes("relatedArtifact"), false);
});

test("SpecRailTerminalApiClient updates planning session status", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url.endsWith("/planning-sessions/plan-1") && init?.method === "PATCH") {
      assert.equal(init.body?.toString(), JSON.stringify({ status: "waiting_agent" }));
      return new Response(JSON.stringify({ planningSession: { id: "plan-1", trackId: "track-1", status: "waiting_agent" } }), { status: 200 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const planningSession = await client.updatePlanningSession("plan-1", "waiting_agent");

  assert.equal(planningSession.status, "waiting_agent");
  assert.equal(requests[0]?.url, "http://example.test/planning-sessions/plan-1");
  assert.equal(requests[0]?.method, "PATCH");
});

test("parsePlanningMessageTemplatesJson validates custom templates", () => {
  assert.deepEqual(
    parsePlanningMessageTemplatesJson(JSON.stringify([{ name: "Team handoff", kind: "note", relatedArtifact: "plan", body: "Team handoff:\n- State:" }]), "templates.json"),
    [{ name: "Team handoff", kind: "note", relatedArtifact: "plan", body: "Team handoff:\n- State:" }],
  );

  assert.deepEqual(
    parsePlanningMessageTemplatesJson(JSON.stringify([{ name: "Team question", kind: " Question ", relatedArtifact: " Plan ", body: "Question:\n- Context:" }]), "templates.json"),
    [{ name: "Team question", kind: "question", relatedArtifact: "plan", body: "Question:\n- Context:" }],
  );

  assert.throws(
    () => parsePlanningMessageTemplatesJson(JSON.stringify([{ name: "Broken", kind: "memo", relatedArtifact: "plan", body: "Body" }]), "templates.json"),
    /kind must be one of message, question, decision, note/,
  );
});

test("editTextWithTerminalEditor seeds and reads editor temp file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "specrail-editor-test-"));
  const editorPath = join(directory, "editor.mjs");

  try {
    await writeFile(editorPath, "import { writeFile } from 'node:fs/promises';\nawait writeFile(process.argv.at(-1), 'Edited from editor\\nSecond line', 'utf8');\n", "utf8");
    const edited = await editTextWithTerminalEditor("Initial body", `node ${editorPath}`);

    assert.equal(edited, "Edited from editor\nSecond line");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SpecRailTerminalApiClient previews and applies workspace cleanup with explicit confirmation", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url.endsWith("/runs/run-cleanup-a/workspace-cleanup/preview") && !init?.method) {
      return new Response(
        JSON.stringify({
          cleanupPlan: {
            dryRun: true,
            eligible: true,
            operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
            refusalReasons: [],
          },
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/runs/run-cleanup-a/workspace-cleanup/apply") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          cleanupResult: {
            applied: true,
            status: "applied",
            operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a", status: "applied" }],
            refusalReasons: [],
          },
          expectedConfirmation: "apply workspace cleanup for run-cleanup-a",
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const preview = await client.previewWorkspaceCleanup("run-cleanup-a");
  assert.equal(preview.cleanupPlan.eligible, true);
  assert.equal(preview.cleanupPlan.operations[0]?.kind, "remove_directory");

  const apply = await client.applyWorkspaceCleanup("run-cleanup-a", "apply workspace cleanup for run-cleanup-a");
  assert.equal(apply.cleanupResult.status, "applied");
  assert.equal(apply.expectedConfirmation, "apply workspace cleanup for run-cleanup-a");
  assert.equal(requests[1]?.body, JSON.stringify({ confirm: "apply workspace cleanup for run-cleanup-a" }));
});

test("SpecRailTerminalApiClient preserves server refusal details for workspace cleanup apply", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);

    if (url.endsWith("/runs/run-cleanup-a/workspace-cleanup/apply") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          cleanupResult: {
            applied: false,
            status: "refused",
            operations: [],
            refusalReasons: ["Workspace cleanup apply requires explicit confirmation"],
          },
          expectedConfirmation: "apply workspace cleanup for run-cleanup-a",
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await client.applyWorkspaceCleanup("run-cleanup-a", "cleanup");
  assert.equal(result.cleanupResult.status, "refused");
  assert.deepEqual(result.cleanupResult.refusalReasons, ["Workspace cleanup apply requires explicit confirmation"]);
  assert.equal(result.expectedConfirmation, "apply workspace cleanup for run-cleanup-a");
});

test("SpecRailTerminalApiClient loads run events for post-action refresh", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input) => {
    const url = String(input);

    if (url.endsWith("/runs/run-cleanup-a/events")) {
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "run-cleanup-a:workspace-cleanup:2026-05-03T00:00:00.000Z",
              executionId: "run-cleanup-a",
              type: "summary",
              timestamp: "2026-05-03T00:00:00.000Z",
              source: "specrail",
              summary: "Workspace cleanup applied for execution run-cleanup-a",
              payload: { status: "applied" },
            },
          ],
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const events = await client.loadRunEvents("run-cleanup-a");
  assert.equal(events[0]?.summary, "Workspace cleanup applied for execution run-cleanup-a");
  assert.equal(events[0]?.payload?.status, "applied");
});

test("SpecRailTerminalApiClient parses SSE frames from run event streams", async () => {
  const encoder = new TextEncoder();
  const requests: string[] = [];
  const chunks = [
    encoder.encode('data: {"id":"evt-1","executionId":"run-1","type":"task_status_changed","timestamp":"2026-04-10T12:00:00.000Z","source":"codex","summary":"Run started","payload":{"status":"running"}}\n\n'),
    encoder.encode('data: {"id":"evt-2","executionId":"run-1","type":"task_status_changed","subtype":"codex_completed","timestamp":"2026-04-10T12:02:00.000Z","source":"codex","summary":"Run completed","payload":{"status":"completed"}}\n\n'),
  ];

  const client = new SpecRailTerminalApiClient("http://example.test/specrail", async (input) => {
    requests.push(String(input));
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });

  const events = [] as Array<{ id: string; type: string; summary: string; subtype?: string }>;
  for await (const event of client.streamRunEvents("run-1")) {
    events.push({ id: event.id, type: event.type, summary: event.summary, subtype: event.subtype });
  }

  assert.deepEqual(events, [
    { id: "evt-1", type: "task_status_changed", summary: "Run started", subtype: undefined },
    { id: "evt-2", type: "task_status_changed", summary: "Run completed", subtype: "codex_completed" },
  ]);
  assert.deepEqual(requests, ["http://example.test/specrail/runs/run-1/events/stream"]);
});

test("terminal preferences load and save local UI defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "specrail-terminal-prefs-"));
  const path = join(dir, "nested", "preferences.json");

  try {
    assert.deepEqual(await loadTerminalPreferences(path), {});

    await saveTerminalPreferences(path, { selectedProjectId: "project-1", runFilter: "terminal", liveTailPaused: true, showRunEventDetail: true, refreshIntervalMs: 15000 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { selectedProjectId: "project-1", runFilter: "terminal", liveTailPaused: true, showRunEventDetail: true, refreshIntervalMs: 15000 });
    assert.deepEqual(await loadTerminalPreferences(path), { selectedProjectId: "project-1", runFilter: "terminal", liveTailPaused: true, showRunEventDetail: true, refreshIntervalMs: 15000 });

    await writeFile(path, JSON.stringify({ selectedProjectId: " project-2 ", runFilter: " ALL ", refreshIntervalMs: 999.4 }), "utf8");
    assert.deepEqual(await loadTerminalPreferences(path), { selectedProjectId: "project-2", runFilter: "all", refreshIntervalMs: 999 });

    await writeFile(path, "{not json", "utf8");
    assert.deepEqual(await loadTerminalPreferences(path), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrapTerminalState initializes detail selections for tracks and runs", async () => {
  const state = await bootstrapTerminalState(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      initialScreen: "home",
      initialProjectId: "project-1",
      initialRunFilter: "active",
      preferencePath: null,
    },
    {
      async loadSummary(projectId) {
        assert.equal(projectId, "project-1");
        return {
          tracks: [{ id: "track-1", title: "Terminal shell", status: "ready", priority: "high" }],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:00:00.000Z",
        };
      },
      async loadTrackDetail() {
        return {
          track: { id: "track-1", title: "Terminal shell", status: "ready", priority: "high" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { hasPendingChanges: false },
        };
      },
      async loadRunDetail() {
        return {
          run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        };
      },
    },
  );

  assert.equal(state.screen, "home");
  assert.match(state.statusLine, /Loaded 1 tracks and 1 runs/);
  assert.equal(state.selectedProjectId, "project-1");
  assert.equal(state.tracks.selectedId, "track-1");
  assert.equal(state.runs.selectedId, "run-1");
  assert.equal(state.runFilter, "active");
  assert.equal(state.runEvents.runId, "run-1");
});

test("renderAppShell renders track list and selected detail preview", () => {
  const rendered = renderAppShell({
    screen: "tracks",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        track: {
          id: "track-1",
          title: "Terminal shell",
          status: "ready",
          priority: "high",
          specStatus: "approved",
          planStatus: "pending",
        },
        artifacts: {
          spec: "# Spec\nTerminal shell",
          plan: "# Plan\nAdd navigation\nKeep brief\nOld outro",
          tasks: "# Tasks\n- Build it",
        },
        planningContext: { planningSessionId: "plan-1", hasPendingChanges: true },
        planningWorkspace: {
          planningSessions: [
            { id: "plan-1", trackId: "track-1", status: "active", updatedAt: "2026-04-10T12:00:00.000Z" },
            { id: "plan-2", trackId: "track-1", status: "archived", updatedAt: "2026-04-10T12:05:00.000Z" },
            { id: "plan-3", trackId: "track-1", status: "archived", updatedAt: "2026-04-10T12:06:00.000Z" },
            { id: "plan-4", trackId: "track-1", status: "archived", updatedAt: "2026-04-10T12:07:00.000Z" },
          ],
          planningMessages: [{ id: "msg-1", planningSessionId: "plan-1", authorType: "user", kind: "question", relatedArtifact: "plan", body: "Need approval?", createdAt: "2026-04-10T12:01:00.000Z" }],
          revisions: {
            spec: [],
            plan: [
              { id: "rev-2", trackId: "track-1", artifact: "plan", version: 2, createdBy: "user", content: "# Plan\nShip it", approvalRequestId: "approval-2", approvedAt: "2026-04-10T12:10:00.000Z", createdAt: "2026-04-10T12:09:30.000Z" },
              { id: "rev-1", trackId: "track-1", artifact: "plan", version: 1, createdBy: "agent", content: "# Plan\nAdd keyboard navigation\nCapture risks\nNew outro", approvalRequestId: "approval-1", createdAt: "2026-04-10T12:00:30.000Z" },
            ],
            tasks: [],
          },
          approvalRequests: {
            spec: [],
            plan: [{ id: "approval-1", trackId: "track-1", artifact: "plan", revisionId: "rev-1", status: "pending", requestedBy: "agent", createdAt: "2026-04-10T12:00:31.000Z" }],
            tasks: [],
          },
          selectedPlanningSessionId: "plan-1",
          selectedArtifact: "plan",
          selectedRevisionId: "rev-1",
          selectedApprovalRequestId: "approval-1",
        },
      },
    },
    runs: {
      selectedId: null,
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runFilter: "all",
    runEvents: createEmptyRunEventFeedState(),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready", priority: "high" }],
      runs: [],
    },
  });

  assert.match(rendered, /SpecRail Terminal/);
  assert.match(rendered, /\[TRACKS\]/);
  assert.match(rendered, /> track-1 \| project\? \| ready \| high \| Terminal shell/);
  assert.match(rendered, /planning session: plan-1 \(1\/4\)/);
  assert.match(rendered, /pending planning changes: yes/);
  assert.match(rendered, /execution context signal: new approvals needed before new runs/);
  assert.match(rendered, /planning sessions:/);
  assert.match(rendered, /\.\.\. 1 more sessions, press M to cycle/);
  assert.match(rendered, /Need approval\?/);
  assert.match(rendered, /revision focus \(plan 2\/2\): v1 by agent/);
  assert.match(rendered, /revision approval: pending via approval-1/);
  assert.match(rendered, /revision diff: \+3 -3 changed lines vs current \(2 more hidden, press u to expand\)/);
  assert.match(rendered, /- Add navigation/);
  assert.match(rendered, /- Keep brief/);
  assert.match(rendered, /\+ Add keyboard navigation/);
  assert.match(rendered, /\+ Capture risks/);
  assert.doesNotMatch(rendered, /^  - Old outro$/m);
  assert.match(rendered, /pending approvals: plan -> rev-1 requested by agent/);
  assert.match(rendered, /planning actions: h\/l switches artifact focus, \[\/\] cycles revisions, u toggles expanded diff, U exports diff patch, M opens planning-session chooser, N opens planning-session create composer, T cycles selected session status, v proposes a new revision for plan/);
  assert.match(rendered, /press a to approve or x to reject selected pending request/);
  assert.match(rendered, /execution actions: press s to start a run for this track/);
  assert.match(rendered, /spec preview: # Spec Terminal shell/);
  assert.match(rendered, /Keys: 1 home, 2 tracks, 3 runs, 4 settings, j\/k or ↑\/↓ select, P project scope, \+\/- refresh, h\/l artifact, \[\/\] revision, u diff, U export diff, M session, N new session, T session status, v propose, m message, f run filter, d event detail, Space tail pause\/resume, s start, e resume, c cancel, w cleanup, a approve, x reject, r refresh, q quit/);
  assert.match(rendered, /Help: tracks — P cycles project scope, h\/l switches artifact, \[\/\] cycles revisions, u toggles expanded diff, U exports diff patch, M opens planning-session chooser, N creates session, T cycles selected session status, v proposes, m appends planning message, a\/x approves or rejects pending revisions, s starts run composer with folder-session discovery\./);
});

test("renderRevisionDiffLines supports compact and expanded changed-line views", () => {
  const compact = renderRevisionDiffLines("A\nB\nC\nD", "A\nB2\nC2\nD2");
  const expanded = renderRevisionDiffLines("A\nB\nC\nD", "A\nB2\nC2\nD2", true);

  assert.deepEqual(compact, [
    "- revision diff: +3 -3 changed lines vs current (2 more hidden, press u to expand)",
    "  - B",
    "  - C",
    "  + B2",
    "  + C2",
  ]);
  assert.deepEqual(expanded, [
    "- revision diff (expanded): +3 -3 changed lines vs current (press u to collapse)",
    "  - B",
    "  - C",
    "  - D",
    "  + B2",
    "  + C2",
    "  + D2",
  ]);
});

test("renderRevisionDiffPatch and exportRevisionDiffPatch write patch metadata and changes", async () => {
  const revision = {
    id: "rev/patch:1",
    trackId: "track/patch",
    artifact: "plan" as const,
    version: 3,
    createdBy: "agent",
    content: "# Plan\nNew step\nKeep",
    createdAt: "2026-04-10T12:00:00.000Z",
  };
  const patch = renderRevisionDiffPatch({
    trackId: "track/patch",
    artifact: "plan",
    revision,
    currentContent: "# Plan\nOld step\nKeep",
  });

  assert.match(patch, /track: track\/patch/);
  assert.match(patch, /revision: rev\/patch:1/);
  assert.match(patch, /--- current\/plan/);
  assert.match(patch, /\+\+\+ revision\/plan@rev\/patch:1/);
  assert.match(patch, /@@ line 2 @@/);
  assert.match(patch, /^-Old step$/m);
  assert.match(patch, /^\+New step$/m);

  const directory = await mkdtemp(join(tmpdir(), "specrail-patch-export-test-"));
  const outputDirectory = join(directory, "nested", "diffs");
  try {
    const filePath = await exportRevisionDiffPatch({
      trackId: "track/patch",
      artifact: "plan",
      revision,
      currentContent: "# Plan\nOld step\nKeep",
      outputDirectory,
      writeManifest: true,
      exportedAt: "2026-04-10T12:10:00.000Z",
    });
    const exported = await readFile(filePath, "utf8");
    const manifest = await readFile(join(outputDirectory, "specrail-revision-diff-exports.jsonl"), "utf8");
    const manifestEntry = JSON.parse(manifest.trim()) as Record<string, unknown>;

    assert.ok(filePath.startsWith(outputDirectory));
    assert.match(filePath, /specrail-revision-diff-track-patch-plan-v3-rev-patch-1\.patch$/);
    assert.equal(exported, patch);
    assert.deepEqual(manifestEntry, {
      exportedAt: "2026-04-10T12:10:00.000Z",
      filePath,
      trackId: "track/patch",
      artifact: "plan",
      revisionId: "rev/patch:1",
      version: 3,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderAppShell renders start composer folder session discovery controls", () => {
  const action = createExecutionActionDraft({
    kind: "start",
    scope: "track",
    trackId: "track-1",
    planningSessionId: "plan-1",
    backend: "codex",
    profile: "default",
    prompt: "Continue selected work",
    workspacePath: "/workspace/app",
  });
  action.folderSessions = [{ id: "run-folder", trackId: "track-1", status: "completed", workspacePath: "/workspace/app", backend: "codex", continuityMode: "fresh", summary: { eventCount: 3, lastEventSummary: "Run completed" } }];
  action.folderSessionPreview = {
    execution: action.folderSessions[0]!,
    session: { sessionRef: "run-folder-codex" },
    capabilities: { supportsResume: true, supportsProviderFork: false, supportsContextCopyFork: true },
    events: [{ id: "evt-1", executionId: "run-folder", type: "summary", timestamp: "2026-04-10T12:00:00.000Z", source: "codex", summary: "Run completed" }],
    reportPath: "/runs/run-folder/report.md",
  };

  const rendered = renderAppShell({
    screen: "tracks",
    statusLine: "Composing run start for track-1.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: { selectedId: "track-1", selectedIndex: 0, loading: false, error: null, data: null },
    runs: { selectedId: null, selectedIndex: 0, loading: false, error: null, data: null },
    runFilter: "all",
    runEvents: createEmptyRunEventFeedState(),
    pendingTrackAction: null,
    pendingExecutionAction: action,
    pendingProposalAction: null,
    summary: { fetchedAt: "2026-04-10T12:00:00.000Z", tracks: [{ id: "track-1", title: "Terminal shell" }], runs: [] },
  });

  assert.match(rendered, /folder path: \/workspace\/app/);
  assert.match(rendered, /folder sessions \(1, selected 1\/1/);
  assert.match(rendered, /> run-folder \| completed \| codex \| fresh \| Run completed/);
  assert.match(rendered, /selected session: run-folder-codex/);
  assert.match(rendered, /selected workspace: \/workspace\/app/);
  assert.match(rendered, /selected report: \/runs\/run-folder\/report\.md/);
  assert.match(rendered, /selected capabilities: resume=true, providerFork=false, contextCopyFork=true/);
  assert.match(rendered, /Ctrl\+F previews folder sessions; Ctrl\+R resumes selected session; Ctrl\+K forks selected session/);
  assert.match(rendered, /Help: start composer — type edits prompt\/folder, Tab switches field, Ctrl\+F previews folder sessions, Ctrl\+R resumes selected session, Ctrl\+K forks selected session, Enter starts fresh, Esc aborts\./);
});

test("renderAppShell renders planning message composer state", () => {
  const rendered = renderAppShell({
    screen: "tracks",
    statusLine: "Composing planning message for plan-1.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: { selectedId: "track-1", selectedIndex: 0, loading: false, error: null, data: null },
    runs: { selectedId: null, selectedIndex: 0, loading: false, error: null, data: null },
    runFilter: "all",
    runEvents: createEmptyRunEventFeedState(),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    pendingPlanningMessageAction: {
      trackId: "track-1",
      planningSessionId: "plan-1",
      authorType: "agent",
      kind: "note",
      relatedArtifact: "tasks",
      body: "Capture handoff context.\nInclude next action.",
      templateIndex: 1,
      submitting: false,
      message: "Ready to append.",
    },
    summary: { fetchedAt: "2026-04-10T12:00:00.000Z", tracks: [], runs: [] },
  });

  assert.match(rendered, /Planning message action: session plan-1 for track track-1/);
  assert.match(rendered, /author: agent \(press g to cycle\)/);
  assert.match(rendered, /kind: note \(press y to cycle\)/);
  assert.match(rendered, /related artifact: tasks \(press h\/l to cycle\)/);
  assert.match(rendered, /template: question \(press Ctrl\+T to apply\/cycle\)/);
  assert.match(rendered, /- body:/);
  assert.match(rendered, /  Capture handoff context\./);
  assert.match(rendered, /  Include next action\./);
  assert.match(rendered, /newline: Ctrl\+N, editor: Ctrl\+E/);
  assert.match(rendered, /Help: planning message composer.*Ctrl\+E opens \$EDITOR/);
});

test("renderAppShell renders run event monitor details", () => {
  const rendered = renderAppShell({
    screen: "runs",
    statusLine: "Streaming run events.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: {
          id: "run-1",
          trackId: "track-1",
          status: "failed",
          backend: "claude_code",
          profile: "sonnet",
          planningSessionId: "plan-1",
          planningContextStale: true,
          planningContextStaleReason: "plan changed after launch",
          summary: { eventCount: 9, lastEventSummary: "Failed Claude Code session run-1-claude" },
          startedAt: "2026-04-10T12:00:00.000Z",
          finishedAt: "2026-04-10T12:05:00.000Z",
        },
      },
    },
    runFilter: "terminal",
    runEvents: appendRunEvents(
      {
        ...createEmptyRunEventFeedState("run-1"),
        connection: "reconnecting",
        reconnectAttempts: 2,
      },
      [
        {
          id: "evt-tool",
          executionId: "run-1",
          type: "tool_call",
          subtype: "claude_tool_call",
          timestamp: "2026-04-10T12:02:30.000Z",
          source: "claude_code",
          summary: "Claude requested tool Bash",
          payload: { toolName: "Bash", toolUseId: "toolu-1", toolInput: { command: "pnpm test -- --runInBand" } },
        },
        {
          id: "evt-approval",
          executionId: "run-1",
          type: "approval_requested",
          subtype: "claude_permission_denial",
          timestamp: "2026-04-10T12:02:45.000Z",
          source: "claude_code",
          summary: "Claude requested approval for Bash",
          payload: { requestId: "approval-1", toolName: "Bash" },
        },
        {
          id: "evt-0",
          executionId: "run-1",
          type: "message",
          timestamp: "2026-04-10T12:03:00.000Z",
          source: "claude_code",
          summary: "STDERR run-1-claude",
          payload: { stream: "stderr", text: "first line\nsecond line with detailed provider output that should stay bounded in the terminal tail" },
        },
        {
          id: "evt-1",
          executionId: "run-1",
          type: "task_status_changed",
          timestamp: "2026-04-10T12:04:00.000Z",
          source: "claude_code",
          summary: "Failed Claude Code session run-1-claude",
          payload: { status: "failed", exitCode: 1 },
        },
      ],
    ),
    showRunEventDetail: true,
    runEventDetailIndex: 0,
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:06:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "failed" }],
      runs: [{ id: "run-1", trackId: "track-1", status: "failed", backend: "claude_code" }],
    },
  });

  assert.match(rendered, /event summary: 4 events, last at 2026-04-10T12:04:00.000Z/);
  assert.match(rendered, /failure focus: Failed Claude Code session run-1-claude \(exit 1\)/);
  assert.match(rendered, /Runs \(1\/1, filter=terminal\)/);
  assert.match(rendered, /stream: reconnecting \(attempt 2\)/);
  assert.match(rendered, /report: \/runs\/run-1\/report\.md/);
  assert.match(rendered, /operator actions: press e to resume this run, w to preview workspace cleanup, Space to pause tail/);
  assert.match(rendered, /Help: runs — f cycles filters, Space pauses live tail, d toggles event detail, p\/n selects event detail, e resumes terminal runs, c cancels active runs, w previews workspace cleanup\./);
  assert.match(rendered, /recent activity:/);
  assert.match(rendered, /tool_call \| claude_tool_call \| Claude requested tool Bash — tool=Bash, id=toolu-1, input=\{\"command\":\"pnpm test -- --runInBand\"\}/);
  assert.match(rendered, /approval_requested \| claude_permission_denial \| Claude requested approval for Bash — request=approval-1, tool=Bash/);
  assert.match(rendered, /message \| stream=stderr \| STDERR run-1-claude — first line second line with detailed provider output/);
  assert.match(rendered, /task_status_changed \| status=failed \| Failed Claude Code session run-1-claude/);
  assert.match(rendered, /event detail \(1\/4\):/);
  assert.match(rendered, /id: evt-tool/);
  assert.match(rendered, /type: tool_call \/ claude_tool_call/);
  assert.match(rendered, /highlights:/);
  assert.match(rendered, /tool call: Bash \(toolu-1\)/);
  assert.match(rendered, /input: \{"command":"pnpm test -- --runInBand"\}/);
  assert.match(rendered, /"toolUseId": "toolu-1"/);
});

test("renderAppShell renders guarded workspace cleanup preview and confirmation state", () => {
  const rendered = renderAppShell({
    screen: "runs",
    statusLine: "Cleanup preview ready for run-cleanup-a.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-cleanup-a",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: { id: "run-cleanup-a", trackId: "track-1", status: "cancelled", backend: "codex" },
      },
    },
    runFilter: "terminal",
    runEvents: createEmptyRunEventFeedState("run-cleanup-a"),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    pendingWorkspaceCleanupAction: {
      runId: "run-cleanup-a",
      phase: "confirmation_ready",
      submitting: false,
      message: "Server confirmation phrase received. Press Enter again to apply cleanup with that exact phrase.",
      preview: {
        cleanupPlan: {
          dryRun: true,
          eligible: true,
          operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
          refusalReasons: [],
        },
      },
      result: {
        expectedConfirmation: "apply workspace cleanup for run-cleanup-a",
        cleanupResult: {
          applied: false,
          status: "refused",
          operations: [],
          refusalReasons: ["Workspace cleanup apply requires explicit confirmation"],
        },
      },
    },
    summary: {
      fetchedAt: "2026-04-10T12:06:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "failed" }],
      runs: [{ id: "run-cleanup-a", trackId: "track-1", status: "cancelled", backend: "codex" }],
    },
  });

  assert.match(rendered, /Workspace cleanup: run-cleanup-a/);
  assert.match(rendered, /eligible: yes/);
  assert.match(rendered, /remove_directory \/tmp\/specrail-workspaces\/run-cleanup-a/);
  assert.match(rendered, /server confirmation: apply workspace cleanup for run-cleanup-a/);
  assert.match(rendered, /result: refused/);
  assert.match(rendered, /Press Enter again to apply cleanup with that exact phrase/);
  assert.match(rendered, /Help: workspace cleanup — Enter requests confirmation\/applies when ready, Esc aborts, r refreshes selected run\./);
});

test("selectNextItem advances run selection on runs screen", () => {
  const state = selectNextItem({
    screen: "runs",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
      },
    },
    runFilter: "all",
    runEvents: appendRunEvents(createEmptyRunEventFeedState("run-1"), [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
    ]),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }],
      runs: [
        { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        { id: "run-2", trackId: "track-1", status: "completed", backend: "claude_code" },
      ],
    },
  } satisfies TerminalAppState);

  assert.equal(state.runs.selectedId, "run-2");
  assert.equal(state.runs.selectedIndex, 1);
  assert.equal(state.runs.data, null);
  assert.equal(state.runEvents.runId, "run-2");
  assert.deepEqual(state.runEvents.items, []);
});

test("refreshTerminalState preserves selection and surfaces detail load errors", async () => {
  const nextState = await refreshTerminalState(
    {
      screen: "tracks",
      statusLine: "Loaded terminal snapshot.",
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      loading: false,
      error: null,
      tracks: {
        selectedId: "track-2",
        selectedIndex: 1,
        loading: false,
        error: null,
        data: null,
      },
      runs: {
        selectedId: "run-1",
        selectedIndex: 0,
        loading: false,
        error: null,
        data: null,
      },
      runFilter: "all",
      runEvents: createEmptyRunEventFeedState("run-1"),
      pendingTrackAction: null,
      pendingExecutionAction: null,
      pendingProposalAction: null,
      summary: {
        fetchedAt: "2026-04-10T12:00:00.000Z",
        tracks: [
          { id: "track-1", title: "A", status: "ready" },
          { id: "track-2", title: "B", status: "blocked" },
        ],
        runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
      },
    },
    {
      async loadSummary() {
        return {
          tracks: [
            { id: "track-1", title: "A", status: "ready" },
            { id: "track-2", title: "B", status: "blocked" },
          ],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:05:00.000Z",
        };
      },
      async loadTrackDetail(trackId: string) {
        if (trackId === "track-2") {
          throw new Error("boom");
        }

        return {
          track: { id: trackId, title: "A", status: "ready" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { hasPendingChanges: false },
        };
      },
      async loadRunDetail() {
        return {
          run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        };
      },
    },
  );

  assert.equal(nextState.tracks.selectedId, "track-2");
  assert.equal(nextState.tracks.selectedIndex, 1);
  assert.equal(nextState.tracks.error, "boom");
  assert.match(nextState.statusLine, /Refreshed 2 tracks and 1 runs/);
});

test("appendRunEvents deduplicates by event id and syncRunEventSelection resets mismatched feeds", () => {
  const feed = appendRunEvents(
    appendRunEvents(createEmptyRunEventFeedState("run-1"), [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
    ]),
    [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
      {
        id: "evt-2",
        executionId: "run-1",
        type: "summary",
        timestamp: "2026-04-10T12:01:00.000Z",
        source: "codex",
        summary: "Planning context updated",
      },
    ],
  );

  assert.equal(feed.items.length, 2);
  assert.equal(feed.lastEventAt, "2026-04-10T12:01:00.000Z");

  const reset = syncRunEventSelection({
    screen: "runs",
    statusLine: "ok",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: { selectedId: null, selectedIndex: 0, loading: false, error: null, data: null },
    runs: { selectedId: "run-2", selectedIndex: 1, loading: false, error: null, data: null },
    runFilter: "all",
    runEvents: { ...feed, runId: "run-1", connection: "live", paused: false },
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:02:00.000Z",
      tracks: [],
      runs: [{ id: "run-2", trackId: "track-1", status: "running" }],
    },
  });

  assert.equal(reset.runEvents.runId, "run-2");
  assert.deepEqual(reset.runEvents.items, []);
  assert.equal(reset.runEvents.connection, "idle");

  const filtered = setRunFilter({
    ...reset,
    summary: {
      fetchedAt: "2026-04-10T12:02:00.000Z",
      tracks: [],
      runs: [
        { id: "run-2", trackId: "track-1", status: "running" },
        { id: "run-3", trackId: "track-1", status: "completed" },
      ],
    },
    runs: { ...reset.runs, selectedId: "run-2", selectedIndex: 0 },
    runEvents: { ...reset.runEvents, runId: "run-2", paused: true, connection: "paused" },
  }, "terminal");

  assert.equal(filtered.runFilter, "terminal");
  assert.equal(filtered.runs.selectedId, "run-3");
  assert.equal(filtered.runEvents.runId, "run-3");
  assert.equal(filtered.runEvents.paused, true);
});

test("runTerminalApp drives cleanup preview, confirmation, apply, and refresh through keypresses", async () => {
  const applyBodies: unknown[] = [];
  const requests: string[] = [];
  const preferenceDir = await mkdtemp(join(tmpdir(), "specrail-terminal-run-view-prefs-"));
  const preferencePath = join(preferenceDir, "preferences.json");

  const server = createServer(async (request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/projects") {
      sendJson(response, { projects: [{ id: "project-default", name: "SpecRail" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks") {
      sendJson(response, { tracks: [{ id: "track-cleanup-a", projectId: "project-default", title: "Cleanup track", status: "ready" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      sendJson(response, {
        runs: [
          {
            id: "run-cleanup-a",
            trackId: "track-cleanup-a",
            status: "completed",
            backend: "codex",
            profile: "default",
            workspacePath: "/tmp/specrail-workspaces/run-cleanup-a",
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run-cleanup-a") {
      sendJson(response, {
        run: {
          id: "run-cleanup-a",
          trackId: "track-cleanup-a",
          status: "completed",
          backend: "codex",
          profile: "default",
          workspacePath: "/tmp/specrail-workspaces/run-cleanup-a",
          summary: { eventCount: applyBodies.length >= 2 ? 1 : 0 },
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run-cleanup-a/workspace-cleanup/preview") {
      sendJson(response, {
        cleanupPlan: {
          dryRun: true,
          eligible: true,
          operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
          refusalReasons: [],
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/runs/run-cleanup-a/workspace-cleanup/apply") {
      const body = await readRequestJson(request);
      applyBodies.push(body);
      const confirm = typeof body === "object" && body !== null && "confirm" in body ? String(body.confirm) : "";
      const expectedConfirmation = "apply workspace cleanup for run-cleanup-a";
      sendJson(response, {
        cleanupResult: confirm === expectedConfirmation
          ? {
              applied: true,
              status: "applied",
              operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a", status: "applied" }],
              refusalReasons: [],
            }
          : {
              applied: false,
              status: "refused",
              operations: [],
              refusalReasons: ["Workspace cleanup apply requires explicit confirmation"],
            },
        expectedConfirmation,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run-cleanup-a/events") {
      sendJson(response, {
        events: [
          {
            id: "run-cleanup-a:workspace-cleanup:2026-05-03T00:00:00.000Z",
            executionId: "run-cleanup-a",
            type: "summary",
            timestamp: "2026-05-03T00:00:00.000Z",
            source: "specrail",
            summary: "Workspace cleanup applied for execution run-cleanup-a",
            payload: { status: "applied" },
          },
        ],
      });
      return;
    }

    sendJson(response, { error: { message: `Unexpected request: ${request.method} ${url.pathname}` } }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address);
  const { port } = address as AddressInfo;

  const stdin = new FakeTerminalStdin();
  const stdout = new FakeTerminalStdout();
  const app = runTerminalApp(
    { apiBaseUrl: `http://127.0.0.1:${port}`, refreshIntervalMs: 0, initialScreen: "runs", initialProjectId: null, initialRunFilter: "all", preferencePath },
    { stdin, stdout } as never,
  );

  try {
    await waitFor(() => stdout.output.includes("run-cleanup-a"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    stdin.key("d");
    stdin.key(" ", "space");
    stdin.key("+");
    await waitFor(async () => {
      try {
        const preferences = JSON.parse(await readFile(preferencePath, "utf8")) as Record<string, unknown>;
        return preferences.liveTailPaused === true && preferences.showRunEventDetail === true && preferences.refreshIntervalMs === 1000;
      } catch {
        return false;
      }
    });

    stdin.key("w");
    await waitFor(() => stdout.output.includes("Cleanup preview ready for run-cleanup-a."));
    assert.equal(applyBodies.length, 0);

    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Workspace cleanup confirmation ready for run-cleanup-a."));
    assert.deepEqual(applyBodies, [{ confirm: "" }]);

    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Workspace cleanup applied for run-cleanup-a; detail and events refreshed."));
    assert.deepEqual(applyBodies[1], { confirm: "apply workspace cleanup for run-cleanup-a" });
    assert(stdout.output.includes("Workspace cleanup applied for execution run-cleanup-a"));
    assert(requests.includes("GET /runs/run-cleanup-a/events"));
  } finally {
    stdin.key("q");
    await app;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(preferenceDir, { recursive: true, force: true });
  }
});

test("runTerminalApp appends planning messages from the tracks screen", async () => {
  const messageBodies: unknown[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "specrail-terminal-templates-"));
  const templatesPath = join(tempRoot, "message-templates.json");
  await writeFile(templatesPath, JSON.stringify([{ name: "Team handoff", kind: "note", relatedArtifact: "tasks", body: "Team handoff:\n- State:\n- Owner:" }]), "utf8");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/projects") {
      sendJson(response, { projects: [{ id: "project-default", name: "SpecRail" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks") {
      sendJson(response, { tracks: [{ id: "track-msg", projectId: "project-default", title: "Planning track", status: "ready" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      sendJson(response, { runs: [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks/track-msg") {
      sendJson(response, {
        track: { id: "track-msg", title: "Planning track", status: "ready" },
        artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
        planningContext: { planningSessionId: "plan-msg", planRevisionId: "plan-rev-1", hasPendingChanges: false },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks/track-msg/planning-sessions") {
      sendJson(response, { planningSessions: [
        { id: "plan-msg", trackId: "track-msg", status: "active", updatedAt: "2026-04-10T12:00:00.000Z" },
        { id: "plan-msg-next", trackId: "track-msg", status: "active", updatedAt: "2026-04-10T12:05:00.000Z" },
      ] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/planning-sessions/plan-msg/messages") {
      sendJson(response, { messages: [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/planning-sessions/plan-msg-next/messages") {
      sendJson(response, { messages: [{ id: "msg-next", planningSessionId: "plan-msg-next", authorType: "agent", kind: "note", relatedArtifact: "tasks", body: "Alternate context", createdAt: "2026-04-10T12:06:00.000Z" }] });
      return;
    }

    if (request.method === "POST" && url.pathname === "/planning-sessions/plan-msg-next/messages") {
      const body = await readRequestJson(request);
      messageBodies.push(body);
      sendJson(response, {
        message: {
          id: "msg-terminal-1",
          planningSessionId: "plan-msg-next",
          authorType: "user",
          kind: "question",
          relatedArtifact: "plan",
          body: "Go",
          createdAt: "2026-04-10T12:10:00.000Z",
        },
      }, 201);
      return;
    }

    if (request.method === "GET" && /^\/tracks\/track-msg\/artifacts\/(spec|plan|tasks)$/.test(url.pathname)) {
      const artifact = url.pathname.split("/").at(-1);
      sendJson(response, {
        revisions: artifact === "plan" ? [{ id: "plan-rev-1", trackId: "track-msg", artifact: "plan", version: 1, createdBy: "agent", content: "# Plan", createdAt: "2026-04-10T12:00:00.000Z" }] : [],
        approvalRequests: [],
      });
      return;
    }

    sendJson(response, { error: { message: `Unexpected request: ${request.method} ${url.pathname}` } }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address);
  const { port } = address as AddressInfo;

  const stdin = new FakeTerminalStdin();
  const stdout = new FakeTerminalStdout();
  const app = runTerminalApp(
    { apiBaseUrl: `http://127.0.0.1:${port}`, refreshIntervalMs: 0, initialScreen: "tracks", initialProjectId: null, initialRunFilter: "all", preferencePath: null, messageTemplatesPath: templatesPath },
    { stdin, stdout } as never,
  );

  try {
    await waitFor(() => stdout.output.includes("track-msg"));
    stdin.key("M");
    await waitFor(() => stdout.output.includes("Planning session chooser"));
    assert.match(stdout.output, /> 1\. plan-msg .* current/);
    stdin.key("j");
    await waitFor(() => stdout.output.includes("Planning session plan-msg-next highlighted."));
    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Selected planning session plan-msg-next."));
    await waitFor(() => stdout.output.includes("agent/note/tasks: Alternate context"));
    stdin.key("m");
    await waitFor(() => stdout.output.includes("Composing planning message for plan-msg-next."));
    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Planning message body is required."));
    assert.deepEqual(messageBodies, []);
    stdin.key("", "t", true);
    await waitFor(() => stdout.output.includes("Applied Team handoff planning-message template."));
    assert.match(stdout.output, /kind: note/);
    assert.match(stdout.output, /Team handoff:/);
    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Appended planning message msg-terminal-1 to plan-msg-next."));
    assert.deepEqual(messageBodies, [{
      authorType: "user",
      kind: "note",
      body: "Team handoff:\n- State:\n- Owner:",
      relatedArtifact: "tasks",
    }]);
  } finally {
    stdin.key("q");
    await app;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runTerminalApp creates a planning session from the tracks screen", async () => {
  const createBodies: unknown[] = [];
  let planningSessions = [{ id: "plan-existing", trackId: "track-create", status: "active", updatedAt: "2026-04-10T12:00:00.000Z" }];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/projects") {
      sendJson(response, { projects: [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks") {
      sendJson(response, { tracks: [{ id: "track-create", title: "Create planning", status: "ready" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      sendJson(response, { runs: [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks/track-create") {
      sendJson(response, {
        track: { id: "track-create", title: "Create planning", status: "ready" },
        artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
        planningContext: { planningSessionId: "plan-existing", hasPendingChanges: false },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks/track-create/planning-sessions") {
      sendJson(response, { planningSessions });
      return;
    }

    if (request.method === "POST" && url.pathname === "/tracks/track-create/planning-sessions") {
      const body = await readRequestJson(request) as { status?: string };
      createBodies.push(body);
      planningSessions = [...planningSessions, { id: "plan-created", trackId: "track-create", status: body.status ?? "active", updatedAt: "2026-04-10T12:10:00.000Z" }];
      sendJson(response, { planningSession: planningSessions.at(-1) }, 201);
      return;
    }

    if (request.method === "GET" && /^\/planning-sessions\/(plan-existing|plan-created)\/messages$/.test(url.pathname)) {
      sendJson(response, { messages: [] });
      return;
    }

    if (request.method === "GET" && /^\/tracks\/track-create\/artifacts\/(spec|plan|tasks)$/.test(url.pathname)) {
      sendJson(response, { revisions: [], approvalRequests: [] });
      return;
    }

    sendJson(response, { error: { message: `Unexpected request: ${request.method} ${url.pathname}` } }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address);
  const { port } = address as AddressInfo;

  const stdin = new FakeTerminalStdin();
  const stdout = new FakeTerminalStdout();
  const app = runTerminalApp(
    { apiBaseUrl: `http://127.0.0.1:${port}`, refreshIntervalMs: 0, initialScreen: "tracks", initialProjectId: null, initialRunFilter: "all", preferencePath: null },
    { stdin, stdout } as never,
  );

  try {
    await waitFor(() => stdout.output.includes("track-create"));
    stdin.key("N");
    await waitFor(() => stdout.output.includes("Planning session create action"));
    assert.match(stdout.output, /status: active \(press y to cycle\)/);
    stdin.key("y");
    await waitFor(() => stdout.output.includes("Planning session status set to waiting_user."));
    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Created waiting_user planning session plan-created."));
    assert.deepEqual(createBodies, [{ status: "waiting_user" }]);
    assert.match(stdout.output, /planning session: plan-created \(2\/2\)/);
    assert.match(stdout.output, /> plan-created \| waiting_user/);
  } finally {
    stdin.key("q");
    await app;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

class FakeTerminalStdin extends EventEmitter {
  isTTY = true;

  setRawMode(_enabled: boolean): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  key(input: string, name = input, ctrl = false): void {
    this.emit("keypress", input, { name, ctrl });
  }
}

class FakeTerminalStdout {
  output = "";

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : null;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(await predicate(), true);
}
