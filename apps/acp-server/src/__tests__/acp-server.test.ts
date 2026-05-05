import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Execution, ExecutionEvent, SpecRailService, Track } from "@specrail/core";

import { SpecRailAcpServer } from "../server.js";

function createFakeService(options: { workspaceRoot?: string } = {}) {
  const track: Track = {
    id: "track-1",
    projectId: "project-default",
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
    service: createFakeService() as unknown as SpecRailService,
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
            trackId: "track-1",
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
  assert.ok(
    notifications.some((payload) => JSON.stringify(payload).includes("session_info_update")),
  );
  assert.ok(
    notifications.some((payload) => JSON.stringify(payload).includes("Completed run-1")),
  );
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"task_status_changed","status":"running"}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"tool_call","toolName":"shell","toolUseId":"tool-call-run-1"}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"tool_result","toolName":"shell","toolUseId":"tool-call-run-1","exitCode":0,"status":"completed"}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"shell_command","command":"pnpm test","exitCode":0,"status":"completed"}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"file_change","path":"README.md","operation":"modified"}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"test_result","status":"passed","passed":12,"failed":0}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"message","subtype":"assistant_text","role":"assistant"}'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"message","provider":{"kind":"codex","sessionRef":"codex-session-run-1","stream":"stdout"'));
  assert.ok(JSON.stringify(notifications).includes('"eventProjection":{"kind":"summary","subtype":"claude_result_success","status":"completed","provider":{"kind":"claude_code"'));
  assert.ok(JSON.stringify(notifications).includes('"providerSessionId":"claude-session-run-1"'));
  assert.ok(JSON.stringify(notifications).includes('"providerEventType":"result"'));
  assert.ok(JSON.stringify(notifications).includes('"totalCostUsd":0.012'));

  const listResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 4, method: "session/list", params: { cwd: "/tmp/specrail" } },
    () => {},
  );
  const listPayload = listResponse?.result as { sessions: Array<{ sessionId: string; _meta: { specrail: { runId: string } } }> };
  assert.equal(listPayload.sessions[0]?.sessionId, sessionId);
  assert.equal(listPayload.sessions[0]?._meta.specrail.runId, "run-1");

  const loadNotifications: unknown[] = [];
  const loadResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId, cwd: "/tmp/specrail" } },
    (payload) => {
      loadNotifications.push(payload);
    },
  );
  assert.equal(loadResponse?.error, undefined);
  assert.ok(loadNotifications.some((payload) => JSON.stringify(payload).includes("Started run-1")));
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
  await server.handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Start workspace read test" }] },
    },
    () => {},
  );

  const runWorkspace = path.join(workspaceRoot, "run-1");
  await mkdir(path.join(runWorkspace, "notes"), { recursive: true });
  await writeFile(path.join(runWorkspace, "notes", "summary.md"), "# Summary\nDone.\n");

  const fileResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "specrail/workspace/read", params: { sessionId, path: "notes/summary.md" } },
    () => {},
  );
  assert.equal(fileResponse?.error, undefined);
  assert.deepEqual((fileResponse?.result as { kind: string; path: string; content: string }).kind, "file");
  assert.equal((fileResponse?.result as { path: string }).path, "notes/summary.md");
  assert.match((fileResponse?.result as { content: string }).content, /# Summary/);
  assert.ok(JSON.stringify(fileResponse?.result).includes('"workspaceCapability"'));

  const directoryResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 4, method: "specrail/workspace/read", params: { sessionId, path: "notes" } },
    () => {},
  );
  assert.equal(directoryResponse?.error, undefined);
  assert.ok(JSON.stringify(directoryResponse?.result).includes('"summary.md"'));

  const outsideResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 5, method: "specrail/workspace/read", params: { sessionId, path: "../secret.txt" } },
    () => {},
  );
  assert.equal(outsideResponse?.error?.data && (outsideResponse.error.data as { reason?: string }).reason, "path_outside_workspace");
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
            projectId: "project-non-default",
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
  assert.ok(JSON.stringify(notifications).includes('"projectId":"project-non-default"'));
  assert.ok(JSON.stringify(notifications).includes('"trackId":"track-2"'));

  const listResponse = await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "session/list", params: { cwd: "/tmp/specrail" } },
    () => {},
  );
  assert.ok(JSON.stringify(listResponse?.result).includes('"projectId":"project-non-default"'));
  assert.ok(JSON.stringify(listResponse?.result).includes('"trackId":"track-2"'));
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
  assert.ok(infoUpdates.some((payload) => JSON.stringify(payload).includes('"status":"waiting_approval"')));
  assert.ok(JSON.stringify(startNotifications).includes('"eventProjection":{"kind":"approval_requested","requestId":"run-1-approval-request","toolName":"Bash","toolUseId":"tool-run-1"}'));

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
              requestId: "run-1-approval-request",
              outcome: "approved",
              decidedBy: "user",
              comment: "ok",
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
  assert.ok(resumeNotifications.some((payload) => JSON.stringify(payload).includes("approval_resolved")));
  assert.ok(JSON.stringify(resumeNotifications).includes('"eventProjection":{"kind":"approval_resolved","requestId":"run-1-approval-request","outcome":"approved","decidedBy":"user"}'));
  assert.ok(resumeNotifications.some((payload) => JSON.stringify(payload).includes('"status":"running"')));
  assert.ok(resumeNotifications.some((payload) => JSON.stringify(payload).includes('"status":"completed"')));
});
