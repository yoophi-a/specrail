import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Execution, ExecutionEvent, SpecRailService, Track } from "@specrail/core";

import { SpecRailAcpServer } from "../server.js";

function assertJsonIncludes(value: unknown, expected: string, label: string): void {
  const serialized = JSON.stringify(value) ?? "undefined";
  const snapshot = serialized.length > 4_000 ? `${serialized.slice(0, 4_000)}...<truncated>` : serialized;
  assert.ok(
    serialized.includes(expected),
    `${label} missing expected JSON fragment:\n${expected}\n\nActual ${label} snapshot:\n${snapshot}`,
  );
}

function assertAcpError(
  response: unknown,
  expected: { code?: number; message?: RegExp; reason?: string },
  label: string,
): void {
  const payload = response as { error?: { code?: number; message?: string; data?: { reason?: string } } } | null | undefined;
  const snapshot = JSON.stringify(response) ?? "undefined";
  const error = payload?.error;
  assert.ok(error, `${label} missing JSON-RPC error. Actual response:\n${snapshot}`);
  if (expected.code !== undefined) {
    assert.equal(error.code, expected.code, `${label} error code mismatch. Actual response:\n${snapshot}`);
  }
  if (expected.message !== undefined) {
    assert.match(error.message ?? "", expected.message, `${label} error message mismatch. Actual response:\n${snapshot}`);
  }
  if (expected.reason !== undefined) {
    assert.equal(error.data?.reason, expected.reason, `${label} error reason mismatch. Actual response:\n${snapshot}`);
  }
}

function createFakeService(options: { workspaceRoot?: string; trackId?: string; projectId?: string } = {}) {
  const track: Track = {
    id: options.trackId ?? "track-1",
    projectId: options.projectId ?? "project-default",
    title: "ACP edge adapter",
    description: "add ACP edge adapter",
    status: "planned",
    specStatus: "approved",
    planStatus: "approved",
    priority: "high",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  };

  const tracks = new Map<string, Track>([[track.id, track]]);
  const runs = new Map<string, Execution>();
  const events = new Map<string, ExecutionEvent[]>();
  let runCounter = 1;
  let eventCounter = 0;

  const pushEvent = (runId: string, event: Omit<ExecutionEvent, "id"> & { id?: string }) => {
    const nextEvent: ExecutionEvent = {
      ...event,
      id: event.id ?? `${runId}-evt-${++eventCounter}`,
    };
    events.set(runId, [...(events.get(runId) ?? []), nextEvent]);
    return nextEvent;
  };

  const service = {
    async createTrack(input: { title: string; description: string; priority?: "low" | "medium" | "high"; projectId?: string }) {
      const created: Track = {
        id: `track-${tracks.size + 1}`,
        projectId: input.projectId ?? "project-default",
        title: input.title,
        description: input.description,
        status: "planned",
        specStatus: "pending",
        planStatus: "pending",
        priority: input.priority ?? "medium",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      };
      tracks.set(created.id, created);
      return created;
    },
    async getTrack(trackId: string) {
      return tracks.get(trackId) ?? null;
    },
    async startRun(input: { trackId: string; prompt: string; backend?: string; profile?: string; planningSessionId?: string }) {
      const runId = `run-${runCounter++}`;
      const requiresApproval = /approval/i.test(input.prompt);
      const created: Execution = {
        id: runId,
        trackId: input.trackId,
        backend: input.backend ?? "codex",
        profile: input.profile ?? "default",
        workspacePath: path.join(options.workspaceRoot ?? "/tmp", runId),
        branchName: `specrail/${runId}`,
        sessionRef: `session:${runId}`,
        planningSessionId: input.planningSessionId,
        status: requiresApproval ? "waiting_approval" : "completed",
        createdAt: "2026-04-13T00:00:00.000Z",
        startedAt: "2026-04-13T00:00:00.000Z",
        finishedAt: requiresApproval ? undefined : "2026-04-13T00:00:01.000Z",
      };
      runs.set(runId, created);
      events.set(runId, []);
      pushEvent(runId, {
        executionId: runId,
        type: "task_status_changed",
        timestamp: "2026-04-13T00:00:00.000Z",
        source: "executor",
        summary: `Started ${runId}`,
        payload: { status: "running" },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "tool_call",
        timestamp: "2026-04-13T00:00:00.500Z",
        source: "executor",
        summary: `Running tests for ${runId}`,
        payload: { toolName: "shell", toolUseId: `tool-call-${runId}` },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "tool_result",
        timestamp: "2026-04-13T00:00:00.750Z",
        source: "executor",
        summary: `Tests passed for ${runId}`,
        payload: { toolName: "shell", toolUseId: `tool-call-${runId}`, exitCode: 0, status: "completed" },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "shell_command",
        timestamp: "2026-04-13T00:00:00.800Z",
        source: "executor",
        summary: `pnpm test for ${runId}`,
        payload: { command: "pnpm test", exitCode: 0, status: "completed" },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "file_change",
        timestamp: "2026-04-13T00:00:00.850Z",
        source: "executor",
        summary: `Updated README for ${runId}`,
        payload: { path: "README.md", operation: "modified" },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "test_result",
        timestamp: "2026-04-13T00:00:00.900Z",
        source: "executor",
        summary: `Tests passed for ${runId}`,
        payload: { status: "passed", passed: 12, failed: 0 },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "message",
        subtype: "assistant_text",
        timestamp: "2026-04-13T00:00:00.950Z",
        source: "executor",
        summary: `Implementation note for ${runId}`,
        payload: { role: "assistant" },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "message",
        timestamp: "2026-04-13T00:00:00.970Z",
        source: "codex",
        summary: `STDOUT ${runId}`,
        payload: { sessionRef: `codex-session-${runId}`, stream: "stdout" },
      });
      pushEvent(runId, {
        executionId: runId,
        type: "summary",
        subtype: "claude_result_success",
        timestamp: "2026-04-13T00:00:00.980Z",
        source: "claude_code",
        summary: `Claude result ${runId}`,
        payload: {
          providerSessionId: `claude-session-${runId}`,
          providerInvocationId: `claude-invocation-${runId}`,
          providerEventType: "result",
          providerEventSubtype: "success",
          model: "sonnet",
          status: "completed",
          durationMs: 1200,
          durationApiMs: 800,
          totalCostUsd: 0.012,
          numTurns: 2,
          isError: false,
        },
      });
      if (requiresApproval) {
        pushEvent(runId, {
          id: `${runId}-approval-request`,
          executionId: runId,
          type: "approval_requested",
          timestamp: "2026-04-13T00:00:01.000Z",
          source: "executor",
          summary: `Approval needed for ${runId}`,
          payload: {
            toolName: "Bash",
            toolUseId: `tool-${runId}`,
            toolInput: { command: "git push origin HEAD" },
            error: "Permission denied",
          },
        });
      } else {
        pushEvent(runId, {
          executionId: runId,
          type: "summary",
          timestamp: "2026-04-13T00:00:01.000Z",
          source: "executor",
          summary: `Completed ${runId}`,
          payload: { status: "completed" },
        });
      }
      return created;
    },
    async resumeRun(input: { runId: string }) {
      const run = runs.get(input.runId);
      if (!run) {
        throw new Error(`missing run ${input.runId}`);
      }
      const resumed: Execution = {
        ...run,
        status: "completed",
        finishedAt: "2026-04-13T00:00:02.000Z",
      };
      runs.set(run.id, resumed);
      pushEvent(run.id, {
        id: `${run.id}-resume-status`,
        executionId: run.id,
        type: "task_status_changed",
        timestamp: "2026-04-13T00:00:02.000Z",
        source: "executor",
        summary: `Resumed ${run.id}`,
        payload: { status: "completed" },
      });
      pushEvent(run.id, {
        id: `${run.id}-resume-summary`,
        executionId: run.id,
        type: "summary",
        timestamp: "2026-04-13T00:00:02.001Z",
        source: "executor",
        summary: `Completed ${run.id}`,
      });
      return resumed;
    },
    async cancelRun(input: { runId: string }) {
      const run = runs.get(input.runId);
      if (!run) {
        throw new Error(`missing run ${input.runId}`);
      }
      const cancelled: Execution = {
        ...run,
        status: "cancelled",
        finishedAt: "2026-04-13T00:00:03.000Z",
      };
      runs.set(run.id, cancelled);
      return cancelled;
    },
    async getRun(runId: string) {
      return runs.get(runId) ?? null;
    },
    async listRunEvents(runId: string) {
      return events.get(runId) ?? [];
    },
    async recordExecutionEvent(event: ExecutionEvent) {
      pushEvent(event.executionId, event);
      const run = runs.get(event.executionId);
      if (!run) {
        return;
      }

      const status = event.payload?.status;
      if (status === "running" || status === "waiting_approval" || status === "completed" || status === "failed" || status === "cancelled") {
        runs.set(event.executionId, {
          ...run,
          status,
          finishedAt: status === "completed" || status === "failed" || status === "cancelled" ? event.timestamp : run.finishedAt,
        });
      }
    },
    async resolveRuntimeApprovalRequest(input: {
      runId: string;
      requestId: string;
      outcome: "approved" | "rejected";
      decidedBy: "user" | "agent" | "system";
      comment?: string;
    }) {
      const runEvents = events.get(input.runId) ?? [];
      const requestedEvent = runEvents.find((event) => event.type === "approval_requested" && event.id === input.requestId);
      if (!requestedEvent) {
        throw new Error(`missing approval request ${input.requestId}`);
      }

      const event: ExecutionEvent = {
        id: `${input.runId}-approval-resolved`,
        executionId: input.runId,
        type: "approval_resolved",
        timestamp: "2026-04-13T00:00:01.500Z",
        source: "specrail",
        summary: `Approved runtime approval request ${input.requestId}`,
        payload: {
          status: input.outcome === "approved" ? "running" : "cancelled",
          requestId: input.requestId,
          outcome: input.outcome,
          decidedBy: input.decidedBy,
          comment: input.comment,
        },
      };
      await service.recordExecutionEvent(event);
      return { event, callback: { status: "unsupported" as const, events: [] } };
    },
  } satisfies Pick<
    SpecRailService,
    | "createTrack"
    | "getTrack"
    | "startRun"
    | "resumeRun"
    | "cancelRun"
    | "getRun"
    | "listRunEvents"
    | "recordExecutionEvent"
    | "resolveRuntimeApprovalRequest"
  >;

  return service;
}

test("ACP server initializes and maps session/new + prompt to SpecRail run lifecycle", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService({ projectId: "project/default", trackId: "track/1" }) as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const notifications: unknown[] = [];

  const initializeResponse = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, (payload) => {
    notifications.push(payload);
  });
  assert.equal(initializeResponse?.error, undefined);
  assert.equal((initializeResponse?.result as { protocolVersion: number }).protocolVersion, 1);

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            projectId: " project/default ",
            trackId: "track/1",
            planningSessionId: " plan/acp ",
            backend: "codex",
            profile: "default",
          },
        },
      },
    },
    (payload) => {
      notifications.push(payload);
    },
  );

  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  assert.ok(sessionId);

  const promptResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Start the ACP edge adapter" }],
      },
    },
    (payload) => {
      notifications.push(payload);
    },
  );

  assert.deepEqual(promptResponse?.result, { stopReason: "end_turn" });
  assertJsonIncludes(notifications, "session_info_update", "ACP notifications");
  assertJsonIncludes(notifications, "Completed run-1", "ACP notifications");
  assertJsonIncludes(notifications, '"projectId":"project/default"', "ACP notifications");
  assertJsonIncludes(notifications, '"trackId":"track/1"', "ACP notifications");
  assertJsonIncludes(notifications, '"planningSessionId":"plan/acp"', "ACP notifications");
  assertJsonIncludes(notifications, '"backend":"codex"', "ACP notifications");
  assertJsonIncludes(notifications, '"profile":"default"', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"task_status_changed","status":"running"}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"tool_call","toolName":"shell","toolUseId":"tool-call-run-1"}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"tool_result","toolName":"shell","toolUseId":"tool-call-run-1","exitCode":0,"status":"completed"}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"shell_command","command":"pnpm test","exitCode":0,"status":"completed"}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"file_change","path":"README.md","operation":"modified"}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"test_result","status":"passed","passed":12,"failed":0}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"message","subtype":"assistant_text","role":"assistant"}', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"message","provider":{"kind":"codex","sessionRef":"codex-session-run-1","stream":"stdout"', "ACP notifications");
  assertJsonIncludes(notifications, '"eventProjection":{"kind":"summary","subtype":"claude_result_success","status":"completed","provider":{"kind":"claude_code"', "ACP notifications");
  assertJsonIncludes(notifications, '"providerSessionId":"claude-session-run-1"', "ACP notifications");
  assertJsonIncludes(notifications, '"providerEventType":"result"', "ACP notifications");
  assertJsonIncludes(notifications, '"totalCostUsd":0.012', "ACP notifications");

  const listResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 4, method: "session/list", params: { cwd: " /tmp/specrail " } },
    () => {},
  );
  const listPayload = listResponse?.result as {
    sessions: Array<{
      sessionId: string;
      _meta: {
        specrail: {
          projectId?: string;
          trackId?: string;
          planningSessionId?: string;
          backend?: string;
          profile?: string;
          runId: string;
          status?: string;
          pendingPermissionRequest?: unknown;
        };
      };
    }>;
  };
  assert.equal(listPayload.sessions[0]?.sessionId, sessionId);
  assert.equal(listPayload.sessions[0]?._meta.specrail.projectId, "project/default");
  assert.equal(listPayload.sessions[0]?._meta.specrail.trackId, "track/1");
  assert.equal(listPayload.sessions[0]?._meta.specrail.planningSessionId, "plan/acp");
  assert.equal(listPayload.sessions[0]?._meta.specrail.backend, "codex");
  assert.equal(listPayload.sessions[0]?._meta.specrail.profile, "default");
  assert.equal(listPayload.sessions[0]?._meta.specrail.runId, "run-1");
  assert.equal(listPayload.sessions[0]?._meta.specrail.status, "completed");
  assert.equal(listPayload.sessions[0]?._meta.specrail.pendingPermissionRequest, undefined);

  const loadNotifications: unknown[] = [];
  const loadResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId, cwd: " /tmp/specrail " } },
    (payload) => {
      loadNotifications.push(payload);
    },
  );
  assert.equal(loadResponse?.error, undefined);
  assertJsonIncludes(loadNotifications, "Started run-1", "ACP load notifications");
});

test("ACP server trims session list cursors before pagination", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  let nowCall = 0;
  const server = new SpecRailAcpServer({
    service: createFakeService() as unknown as SpecRailService,
    stateDir,
    now: () => `2026-04-13T12:00:0${nowCall++}.000Z`,
    pageSize: 1,
  });

  const firstResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/specrail" } },
    () => {},
  );
  const secondResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp/specrail" } },
    () => {},
  );
  const firstSessionId = (firstResponse?.result as { sessionId: string }).sessionId;
  const secondSessionId = (secondResponse?.result as { sessionId: string }).sessionId;

  const firstPageResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "session/list", params: { cwd: "/tmp/specrail", cursor: "   " } },
    () => {},
  );
  const firstPage = firstPageResponse?.result as { sessions: Array<{ sessionId: string }>; nextCursor?: string };
  assert.equal(firstPage.sessions[0]?.sessionId, secondSessionId);
  assert.ok(firstPage.nextCursor);

  const nextPageResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 4, method: "session/list", params: { cwd: "/tmp/specrail", cursor: ` ${firstPage.nextCursor} ` } },
    () => {},
  );
  const nextPage = nextPageResponse?.result as { sessions: Array<{ sessionId: string }>; nextCursor?: string };
  assert.equal(nextPage.sessions[0]?.sessionId, firstSessionId);
  assert.equal(nextPage.nextCursor, undefined);
});

test("ACP server reads linked run workspace paths through scoped capability", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-workspace-"));
  const server = new SpecRailAcpServer({
    service: createFakeService({ workspaceRoot }) as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/specrail", _meta: { specrail: { trackId: "track-1" } } },
    },
    () => {},
  );
  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;

  const missingRunResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 2, method: "specrail/workspace/read", params: { sessionId, path: "." } },
    () => {},
  );
  assertAcpError(missingRunResponse, { reason: "missing_run" }, "ACP workspace read before run");

  await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Start workspace read test" }] },
    },
    () => {},
  );

  const runWorkspace = path.join(workspaceRoot, "run-1");
  await mkdir(path.join(runWorkspace, "notes"), { recursive: true });
  await writeFile(path.join(runWorkspace, "notes", "summary.md"), "# Summary\nDone.\n");
  await writeFile(path.join(runWorkspace, "notes", "long.txt"), "x".repeat(64_005));
  const outsideFile = path.join(workspaceRoot, "outside-secret.txt");
  await writeFile(outsideFile, "outside\n");
  await symlink(outsideFile, path.join(runWorkspace, "notes", "outside-link.txt"));
  await mkdir(path.join(runWorkspace, "unsorted"), { recursive: true });
  await writeFile(path.join(runWorkspace, "unsorted", "beta.txt"), "beta\n");
  await writeFile(path.join(runWorkspace, "unsorted", "alpha.txt"), "alpha\n");
  await writeFile(path.join(runWorkspace, "unsorted", "charlie.txt"), "charlie\n");
  await mkdir(path.join(runWorkspace, "many"), { recursive: true });
  for (let index = 100; index >= 0; index -= 1) {
    await writeFile(path.join(runWorkspace, "many", `${index.toString().padStart(3, "0")}.txt`), `${index}\n`);
  }

  const fileResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 4, method: "specrail/workspace/read", params: { sessionId, path: "notes/summary.md" } },
    () => {},
  );
  assert.equal(fileResponse?.error, undefined);
  assert.deepEqual((fileResponse?.result as { kind: string; path: string; content: string }).kind, "file");
  assert.equal((fileResponse?.result as { path: string }).path, "notes/summary.md");
  assert.match((fileResponse?.result as { content: string }).content, /# Summary/);
  const fileCapability = (fileResponse?.result as {
    _meta: {
      specrail: {
        workspaceCapability: {
          runId: string;
          workspacePath: string;
          allowedOperations: string[];
          cleanupBlocked: boolean;
        };
      };
    };
  })._meta.specrail.workspaceCapability;
  assert.deepEqual(fileCapability, {
    runId: "run-1",
    workspacePath: runWorkspace,
    allowedOperations: ["read"],
    cleanupBlocked: false,
  });

  const directoryResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 5, method: "specrail/workspace/read", params: { sessionId, path: "notes" } },
    () => {},
  );
  assert.equal(directoryResponse?.error, undefined);
  assertJsonIncludes(directoryResponse?.result, '"summary.md"', "ACP workspace directory result");

  const sortedDirectoryResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 12, method: "specrail/workspace/read", params: { sessionId, path: "unsorted" } },
    () => {},
  );
  assert.equal(sortedDirectoryResponse?.error, undefined);
  const sortedDirectory = sortedDirectoryResponse?.result as { entries: Array<{ name: string }> };
  assert.deepEqual(
    sortedDirectory.entries.map((entry) => entry.name),
    ["alpha.txt", "beta.txt", "charlie.txt"],
  );

  const truncatedDirectoryResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 6, method: "specrail/workspace/read", params: { sessionId, path: "many" } },
    () => {},
  );
  assert.equal(truncatedDirectoryResponse?.error, undefined);
  const truncatedDirectory = truncatedDirectoryResponse?.result as { entries: Array<{ name: string }>; truncated: boolean };
  assert.equal(truncatedDirectory.entries.length, 100);
  assert.equal(truncatedDirectory.entries[0]?.name, "000.txt");
  assert.equal(truncatedDirectory.entries.at(-1)?.name, "099.txt");
  assert.equal(truncatedDirectory.truncated, true);

  const truncatedFileResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 7, method: "specrail/workspace/read", params: { sessionId, path: "notes/long.txt" } },
    () => {},
  );
  assert.equal(truncatedFileResponse?.error, undefined);
  const truncatedFile = truncatedFileResponse?.result as { content: string; truncated: boolean };
  assert.equal(truncatedFile.content.length, 64_000);
  assert.equal(truncatedFile.truncated, true);

  const missingPathResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 8, method: "specrail/workspace/read", params: { sessionId, path: "notes/missing.md" } },
    () => {},
  );
  assertAcpError(missingPathResponse, { reason: "path_not_found" }, "ACP workspace read missing path");

  const outsideResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 9, method: "specrail/workspace/read", params: { sessionId, path: "../secret.txt" } },
    () => {},
  );
  assertAcpError(outsideResponse, { reason: "path_outside_workspace" }, "ACP workspace read parent escape");

  const absolutePathResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 10, method: "specrail/workspace/read", params: { sessionId, path: path.join(runWorkspace, "notes", "summary.md") } },
    () => {},
  );
  assertAcpError(absolutePathResponse, { reason: "path_outside_workspace" }, "ACP workspace read absolute path");

  const symlinkEscapeResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 11, method: "specrail/workspace/read", params: { sessionId, path: "notes/outside-link.txt" } },
    () => {},
  );
  assertAcpError(symlinkEscapeResponse, { reason: "path_outside_workspace" }, "ACP workspace read symlink escape");
});

test("ACP server marks workspace cleanup blocked while the linked run is active", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-workspace-"));
  const server = new SpecRailAcpServer({
    service: createFakeService({ workspaceRoot }) as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/specrail", _meta: { specrail: { trackId: "track-1" } } },
    },
    () => {},
  );
  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Start workspace read test with approval" }] },
    },
    () => {},
  );

  const runWorkspace = path.join(workspaceRoot, "run-1");
  await mkdir(runWorkspace, { recursive: true });
  await writeFile(path.join(runWorkspace, "status.txt"), "waiting\n");

  const fileResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "specrail/workspace/read", params: { sessionId, path: "status.txt" } },
    () => {},
  );

  assert.equal(fileResponse?.error, undefined);
  const capability = (fileResponse?.result as {
    _meta: { specrail: { workspaceCapability: { cleanupBlocked: boolean } } };
  })._meta.specrail.workspaceCapability;
  assert.equal(capability.cleanupBlocked, true);
});

test("ACP server creates a project-scoped track when session/new omits trackId", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService() as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            projectId: " project/non-default ",
            title: "Non-default ACP work",
            backend: "codex",
          },
        },
      },
    },
    () => {},
  );

  assert.equal(newResponse?.error, undefined);
  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  const notifications: unknown[] = [];
  const promptResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Create a track in a non-default project" }],
      },
    },
    (payload) => notifications.push(payload),
  );

  assert.deepEqual(promptResponse?.result, { stopReason: "end_turn" });
  assertJsonIncludes(notifications, '"projectId":"project/non-default"', "ACP notifications");
  assertJsonIncludes(notifications, '"trackId":"track-2"', "ACP notifications");

  const listResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "session/list", params: { cwd: "/tmp/specrail" } },
    () => {},
  );
  assertJsonIncludes(listResponse?.result, '"projectId":"project/non-default"', "ACP session list result");
  assertJsonIncludes(listResponse?.result, '"trackId":"track-2"', "ACP session list result");
});

test("ACP server emits richer permission request and resolution updates", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService() as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            trackId: "track-1",
            backend: "claude_code",
            profile: "sonnet",
          },
        },
      },
    },
    () => {},
  );

  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  const startNotifications: Array<Record<string, unknown>> = [];
  const promptResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Run with approval gate" }],
      },
    },
    (payload) => {
      startNotifications.push(payload as Record<string, unknown>);
    },
  );

  assert.deepEqual(promptResponse?.result, { stopReason: "end_turn" });
  assert.ok(startNotifications.some((payload) => payload.method === "session/request_permission"));

  const infoUpdates = startNotifications.filter((payload) => payload.method === "session/update");
  assertJsonIncludes(infoUpdates, '"status":"waiting_approval"', "ACP session info updates");
  assertJsonIncludes(startNotifications, '"eventProjection":{"kind":"approval_requested","requestId":"run-1-approval-request","toolName":"Bash","toolUseId":"tool-run-1"}', "ACP start notifications");

  const permissionRequest = startNotifications.find((payload) => payload.method === "session/request_permission") as
    | { params?: { toolName?: string; requestId?: string } }
    | undefined;
  assert.equal(permissionRequest?.params?.toolName, "Bash");
  assert.equal(permissionRequest?.params?.requestId, "run-1-approval-request");

  const resumeNotifications: Array<Record<string, unknown>> = [];
  const resumeResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Permission approved, keep going" }],
        _meta: {
          specrail: {
            permissionResolution: {
              requestId: " run-1-approval-request ",
              outcome: " approved ",
              decidedBy: " user ",
              comment: " ok ",
            },
          },
        },
      },
    },
    (payload) => {
      resumeNotifications.push(payload as Record<string, unknown>);
    },
  );

  assert.deepEqual(resumeResponse?.result, { stopReason: "end_turn" });
  assertJsonIncludes(resumeNotifications, "approval_resolved", "ACP resume notifications");
  assertJsonIncludes(resumeNotifications, '"eventProjection":{"kind":"approval_resolved","requestId":"run-1-approval-request","outcome":"approved","decidedBy":"user"}', "ACP resume notifications");
  assertJsonIncludes(resumeNotifications, '"status":"running"', "ACP resume notifications");
  assertJsonIncludes(resumeNotifications, '"status":"completed"', "ACP resume notifications");
});

test("ACP server projects rejected permission resolutions without resuming", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const service = createFakeService();
  const resumeRun = service.resumeRun;
  let resumeRunCalls = 0;
  service.resumeRun = async (input) => {
    resumeRunCalls += 1;
    return resumeRun(input);
  };
  const server = new SpecRailAcpServer({
    service: service as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            trackId: "track-1",
            backend: "claude_code",
            profile: "sonnet",
          },
        },
      },
    },
    () => {},
  );

  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Run with approval gate" }],
      },
    },
    () => {},
  );

  const rejectNotifications: Array<Record<string, unknown>> = [];
  const rejectResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Permission rejected, stop" }],
        _meta: {
          specrail: {
            permissionResolution: {
              requestId: "run-1-approval-request",
              outcome: "rejected",
              decidedBy: "user",
              comment: "not allowed",
            },
          },
        },
      },
    },
    (payload) => {
      rejectNotifications.push(payload as Record<string, unknown>);
    },
  );

  assert.deepEqual(rejectResponse?.result, { stopReason: "cancelled" });
  assertJsonIncludes(rejectNotifications, '"eventProjection":{"kind":"approval_resolved","requestId":"run-1-approval-request","outcome":"rejected","decidedBy":"user"}', "ACP reject notifications");
  assertJsonIncludes(rejectNotifications, '"status":"cancelled"', "ACP reject notifications");
  assert.equal(resumeRunCalls, 0);
});

test("ACP server rejects invalid permission resolution payloads", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService() as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            trackId: "track-1",
            backend: "claude_code",
            profile: "sonnet",
          },
        },
      },
    },
    () => {},
  );

  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Run with approval gate" }],
      },
    },
    () => {},
  );

  const mismatchResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Permission decision with mismatch" }],
        _meta: {
          specrail: {
            permissionResolution: {
              requestId: "different-request",
              outcome: "approved",
            },
          },
        },
      },
    },
    () => {},
  );

  assertAcpError(
    mismatchResponse,
    { code: -32602, message: /permissionResolution\.requestId does not match pending request/ },
    "ACP mismatched permission resolution",
  );

  const invalidOutcomeResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Permission decision with invalid outcome" }],
        _meta: {
          specrail: {
            permissionResolution: {
              requestId: "run-1-approval-request",
              outcome: "maybe",
            },
          },
        },
      },
    },
    () => {},
  );

  assertAcpError(
    invalidOutcomeResponse,
    { code: -32602, message: /permissionResolution\.outcome must be approved or rejected/ },
    "ACP invalid permission outcome",
  );

  const invalidDecidedByResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Permission decision with invalid actor" }],
        _meta: {
          specrail: {
            permissionResolution: {
              requestId: "run-1-approval-request",
              outcome: "approved",
              decidedBy: "admin",
            },
          },
        },
      },
    },
    () => {},
  );

  assertAcpError(
    invalidDecidedByResponse,
    { code: -32602, message: /permissionResolution\.decidedBy must be user, agent, or system/ },
    "ACP invalid permission actor",
  );
});

test("ACP server rejects permission resolutions before starting unlinked runs", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const service = createFakeService();
  const startRun = service.startRun;
  let startRunCalls = 0;
  service.startRun = async (input) => {
    startRunCalls += 1;
    return startRun(input);
  };
  const server = new SpecRailAcpServer({
    service: service as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            trackId: "track-1",
            backend: "claude_code",
            profile: "sonnet",
          },
        },
      },
    },
    () => {},
  );

  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  const response = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Permission decision before a run exists" }],
        _meta: {
          specrail: {
            permissionResolution: {
              requestId: "run-1-approval-request",
              outcome: "approved",
            },
          },
        },
      },
    },
    () => {},
  );

  assertAcpError(
    response,
    { code: -32602, message: /permissionResolution provided but there is no linked run/ },
    "ACP unlinked permission resolution",
  );
  assert.equal(startRunCalls, 0);
});

test("ACP server clears pending permission state on cancel", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService() as unknown as SpecRailService,
    stateDir,
    now: () => "2026-04-13T12:00:00.000Z",
    pollIntervalMs: 1,
  });

  const newResponse = await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/tmp/specrail",
        _meta: {
          specrail: {
            trackId: "track-1",
            backend: "claude_code",
            profile: "sonnet",
          },
        },
      },
    },
    () => {},
  );

  const sessionId = (newResponse?.result as { sessionId: string }).sessionId;
  await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Run with approval gate" }],
      },
    },
    () => {},
  );

  const cancelResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "session/cancel", params: { sessionId } },
    () => {},
  );
  assert.equal(cancelResponse?.error, undefined);

  const loadNotifications: Array<Record<string, unknown>> = [];
  const loadResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 4, method: "session/load", params: { sessionId, cwd: "/tmp/specrail" } },
    (payload) => {
      loadNotifications.push(payload as Record<string, unknown>);
    },
  );

  assert.equal(loadResponse?.error, undefined);
  const sessionInfoUpdate = loadNotifications.find((payload) => JSON.stringify(payload).includes("session_info_update"));
  const serializedSessionInfo = JSON.stringify(sessionInfoUpdate);
  assert.ok(serializedSessionInfo.includes('"status":"cancelled"'));
  assert.ok(!serializedSessionInfo.includes("pendingPermissionRequest"));

  const listResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 5, method: "session/list", params: { cwd: "/tmp/specrail" } },
    () => {},
  );
  const listPayload = listResponse?.result as {
    sessions: Array<{ _meta: { specrail: { status?: string; pendingPermissionRequest?: unknown } } }>;
  };
  assert.equal(listPayload.sessions[0]?._meta.specrail.status, "cancelled");
  assert.equal(listPayload.sessions[0]?._meta.specrail.pendingPermissionRequest, undefined);
});
