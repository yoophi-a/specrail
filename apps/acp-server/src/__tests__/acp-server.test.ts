import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Execution, ExecutionEvent, SpecRailService, Track } from "@specrail/core";

import { SpecRailAcpServer } from "../server.js";

function createFakeService() {
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
    async getTrack(trackId: string) {
      return trackId === track.id ? track : null;
    },
    async startRun(input: { trackId: string; prompt: string; backend?: string; profile?: string; planningSessionId?: string }) {
      const runId = `run-${runCounter++}`;
      const requiresApproval = /approval/i.test(input.prompt);
      const created: Execution = {
        id: runId,
        trackId: input.trackId,
        backend: input.backend ?? "codex",
        profile: input.profile ?? "default",
        workspacePath: path.join("/tmp", runId),
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
  } satisfies Pick<SpecRailService, "getTrack" | "startRun" | "resumeRun" | "cancelRun" | "getRun" | "listRunEvents" | "recordExecutionEvent">;

  return service;
}

test("ACP server initializes and maps session/new + prompt to SpecRail run lifecycle", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService() as SpecRailService,
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

test("ACP server emits richer permission request and resolution updates", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "specrail-acp-state-"));
  const server = new SpecRailAcpServer({
    service: createFakeService() as SpecRailService,
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
  assert.ok(resumeNotifications.some((payload) => JSON.stringify(payload).includes('"status":"running"')));
  assert.ok(resumeNotifications.some((payload) => JSON.stringify(payload).includes('"status":"completed"')));
});
