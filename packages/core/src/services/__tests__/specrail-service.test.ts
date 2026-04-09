import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExecutionEvent } from "../../domain/types.js";
import {
  FileGitHubRunCommentSyncStore,
  FileExecutionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
} from "../file-repositories.js";
import { SpecRailService } from "../specrail-service.js";

test("SpecRailService creates tracks, artifacts, runs, and execution events", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-"));
  const artifactRoot = path.join(rootDir, ".specrail");
  const workspaceRoot = path.join(rootDir, "workspaces");

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: {
      async write(input) {
        const trackDir = path.join(artifactRoot, input.track.id);
        await mkdir(trackDir, { recursive: true });
        await writeFile(path.join(trackDir, "spec.md"), input.specContent, "utf8");
        await writeFile(path.join(trackDir, "plan.md"), input.planContent, "utf8");
        await writeFile(path.join(trackDir, "tasks.md"), input.tasksContent, "utf8");
      },
    },
    executor: {
      name: "codex",
      async spawn(input) {
        const eventBase: Omit<ExecutionEvent, "id" | "type" | "summary" | "payload"> = {
          executionId: input.executionId,
          timestamp: "2026-04-09T03:00:00.000Z",
          source: "codex",
        };

        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", "--full-auto", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [
            {
              ...eventBase,
              id: `${input.executionId}:started`,
              type: "task_status_changed",
              summary: "Run started",
              payload: { status: "running" },
            },
            {
              ...eventBase,
              id: `${input.executionId}:shell`,
              type: "shell_command",
              summary: "Prepared Codex command",
              payload: { command: "codex" },
            },
          ],
        };
      },
      async resume(input) {
        return {
          sessionRef: input.sessionRef,
          command: {
            command: "codex",
            args: ["exec", "resume", input.sessionRef, input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
            resumeSessionRef: input.sessionRef,
          },
          events: [
            {
              id: `${input.executionId}:resumed`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T03:05:00.000Z",
              source: "codex",
              summary: "Run resumed",
              payload: { status: "running", sessionRef: input.sessionRef },
            },
          ],
        };
      },
      async cancel(input) {
        return {
          id: `${input.executionId}:cancelled`,
          executionId: input.executionId,
          type: "task_status_changed",
          timestamp: "2026-04-09T03:10:00.000Z",
          source: "codex",
          summary: "Run cancelled",
          payload: { status: "cancelled", sessionRef: input.sessionRef },
        };
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
      repoUrl: "https://github.com/yoophi-a/specrail",
    },
    workspaceRoot,
    now: (() => {
      const values = [
        "2026-04-09T03:00:00.000Z",
        "2026-04-09T03:00:00.000Z",
        "2026-04-09T03:10:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-09T03:10:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-a", "run-a"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Build executor MVP",
    description: "Create enough state and artifacts to start a run.",
    priority: "high",
    githubIssue: { number: 28, url: "https://github.com/yoophi-a/specrail/issues/28" },
  });

  assert.equal(track.id, "track-track-a");
  assert.equal(track.projectId, "project-default");
  assert.deepEqual(track.githubIssue, { number: 28, url: "https://github.com/yoophi-a/specrail/issues/28" });

  const specContent = await readFile(path.join(artifactRoot, track.id, "spec.md"), "utf8");
  assert.match(specContent, /# Spec — Build executor MVP/);

  const run = await service.startRun({
    trackId: track.id,
    prompt: "Ship the MVP",
    profile: "default",
  });

  assert.equal(run.id, "run-run-a");
  assert.equal(run.sessionRef, "session:run-run-a");
  assert.equal(run.command?.command, "codex");
  assert.equal(run.status, "running");
  assert.deepEqual(run.summary, {
    eventCount: 2,
    lastEventSummary: "Prepared Codex command",
    lastEventAt: "2026-04-09T03:00:00.000Z",
  });

  const resumedRun = await service.resumeRun({
    runId: run.id,
    prompt: "Continue with verification",
  });
  assert.equal(resumedRun.command?.resumeSessionRef, "session:run-run-a");
  assert.equal(resumedRun.command?.prompt, "Continue with verification");
  assert.equal(resumedRun.status, "running");
  assert.deepEqual(resumedRun.summary, {
    eventCount: 3,
    lastEventSummary: "Run resumed",
    lastEventAt: "2026-04-09T03:05:00.000Z",
  });

  const cancelledRun = await service.cancelRun({ runId: run.id });
  assert.equal(cancelledRun.status, "cancelled");
  assert.equal(cancelledRun.finishedAt, "2026-04-09T03:10:00.000Z");
  assert.deepEqual(cancelledRun.summary, {
    eventCount: 4,
    lastEventSummary: "Run cancelled",
    lastEventAt: "2026-04-09T03:10:00.000Z",
  });

  const persistedRun = await service.getRun(run.id);
  assert.deepEqual(persistedRun, cancelledRun);

  const blockedTrack = await service.getTrack(track.id);
  assert.equal(blockedTrack?.status, "blocked");
  assert.equal(blockedTrack?.updatedAt, "2026-04-09T03:10:00.000Z");

  const events = await service.listRunEvents(run.id);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((event) => event.summary),
    ["Run started", "Prepared Codex command", "Run resumed", "Run cancelled"],
  );
});

test("SpecRailService throws when starting a run for a missing track", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-missing-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn() {
        throw new Error("should not be called");
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
  });

  await assert.rejects(() => service.startRun({ trackId: "missing-track", prompt: "nope" }), /Track not found/);
  await assert.rejects(() => service.resumeRun({ runId: "missing-run", prompt: "nope" }), /Run not found/);
  await assert.rejects(() => service.cancelRun({ runId: "missing-run" }), /Run not found/);
});

test("SpecRailService applies explicit sorting and pagination for track and run listings", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-listing-"));

  const nowValues = [
    "2026-04-09T01:00:00.000Z",
    "2026-04-09T01:00:00.000Z",
    "2026-04-09T01:00:01.000Z",
    "2026-04-09T01:00:01.000Z",
    "2026-04-09T01:00:02.000Z",
    "2026-04-09T01:00:02.000Z",
    "2026-04-09T01:00:03.000Z",
    "2026-04-09T01:00:04.000Z",
    "2026-04-09T01:00:05.000Z",
    "2026-04-09T01:00:06.000Z",
    "2026-04-09T01:00:07.000Z",
    "2026-04-09T01:00:08.000Z",
  ];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [
            {
              id: `${input.executionId}:started`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T02:00:00.000Z",
              source: "codex",
              summary: "Run started",
              payload: { status: "running" },
            },
          ],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => nowValues.shift() ?? "2026-04-09T01:00:05.000Z",
    idGenerator: (() => {
      const values = ["track-a", "track-b", "track-c", "run-a", "run-b", "run-c"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const trackC = await service.createTrack({ title: "Charlie", description: "C" });
  const trackA = await service.createTrack({ title: "Alpha", description: "A" });
  const trackB = await service.createTrack({ title: "Bravo", description: "B" });

  const pagedTrackResult = await service.listTracksPage({ page: 2, pageSize: 1, sortBy: "title", sortOrder: "asc" });
  assert.deepEqual(pagedTrackResult.items.map((track) => track.id), [trackB.id]);
  assert.deepEqual(pagedTrackResult.meta, {
    total: 3,
    totalPages: 3,
    hasNextPage: true,
    hasPrevPage: true,
  });

  const pagedTracks = await service.listTracks({ page: 2, pageSize: 1, sortBy: "title", sortOrder: "asc" });
  assert.deepEqual(pagedTracks.map((track) => track.id), [trackB.id]);

  const runA = await service.startRun({ trackId: trackC.id, prompt: "Run 1" });
  const runB = await service.startRun({ trackId: trackC.id, prompt: "Run 2" });
  const runC = await service.startRun({ trackId: trackC.id, prompt: "Run 3" });

  const sortedRuns = await service.listRuns({
    trackId: trackC.id,
    sortBy: "createdAt",
    sortOrder: "asc",
  });
  const pagedRunResult = await service.listRunsPage({
    trackId: trackC.id,
    page: 2,
    pageSize: 1,
    sortBy: "createdAt",
    sortOrder: "asc",
  });
  assert.deepEqual(pagedRunResult.items.map((run) => run.id), [sortedRuns[1]?.id]);
  assert.deepEqual(pagedRunResult.meta, {
    total: 3,
    totalPages: 3,
    hasNextPage: true,
    hasPrevPage: true,
  });

  const pagedRuns = await service.listRuns({
    trackId: trackC.id,
    page: 2,
    pageSize: 1,
    sortBy: "createdAt",
    sortOrder: "asc",
  });
  assert.deepEqual(pagedRuns.map((run) => run.id), [sortedRuns[1]?.id]);
  assert.equal(runA.status, "running");
  assert.equal(runB.status, "running");
  assert.equal(runC.status, "running");
  assert.equal(trackA.title, "Alpha");
});

test("SpecRailService reconciles execution records from adapter terminal events and track status", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-runtime-event-"));

  const createService = (idSuffix: string) =>
    new SpecRailService({
      projectRepository: new FileProjectRepository(path.join(rootDir, `state-${idSuffix}`)),
      trackRepository: new FileTrackRepository(path.join(rootDir, `state-${idSuffix}`)),
      executionRepository: new FileExecutionRepository(path.join(rootDir, `state-${idSuffix}`)),
      eventStore: new JsonlEventStore(path.join(rootDir, `state-${idSuffix}`)),
      artifactWriter: { async write() {} },
      executor: {
        name: "codex",
        async spawn(input) {
          return {
            sessionRef: `session:${input.executionId}`,
            command: {
              command: "codex",
              args: ["exec", input.prompt],
              cwd: input.workspacePath,
              prompt: input.prompt,
            },
            events: [
              {
                id: `${input.executionId}:started`,
                executionId: input.executionId,
                type: "task_status_changed",
                timestamp: "2026-04-09T04:00:00.000Z",
                source: "codex",
                summary: "Run started",
                payload: { status: "running" },
              },
            ],
          };
        },
        async resume() {
          throw new Error("should not be called");
        },
        async cancel() {
          throw new Error("should not be called");
        },
      },
      defaultProject: {
        id: "project-default",
        name: "SpecRail",
      },
      workspaceRoot: path.join(rootDir, `workspaces-${idSuffix}`),
      now: () => "2026-04-09T04:00:00.000Z",
      idGenerator: (() => {
        const values = [`track-runtime-${idSuffix}`, `run-runtime-${idSuffix}`];
        return () => values.shift() ?? `extra-${idSuffix}`;
      })(),
    });

  await Promise.all(
    [
      {
        terminalStatus: "completed",
        expectedTrackStatus: "review",
        timestamp: "2026-04-09T04:03:00.000Z",
        summary: "Completed Codex session session:run-run-runtime-completed",
      },
      {
        terminalStatus: "failed",
        expectedTrackStatus: "failed",
        timestamp: "2026-04-09T04:05:00.000Z",
        summary: "Failed Codex session session:run-run-runtime-failed",
      },
      {
        terminalStatus: "cancelled",
        expectedTrackStatus: "blocked",
        timestamp: "2026-04-09T04:07:00.000Z",
        summary: "Cancelled Codex session session:run-run-runtime-cancelled",
      },
    ].map(async ({ terminalStatus, expectedTrackStatus, timestamp, summary }) => {
      const service = createService(terminalStatus);
      const track = await service.createTrack({
        title: `Runtime reconciliation ${terminalStatus}`,
        description: "Keep execution records aligned with adapter events.",
      });

      const run = await service.startRun({
        trackId: track.id,
        prompt: "Start the work",
      });

      await service.recordExecutionEvent({
        id: `${run.id}:${terminalStatus}`,
        executionId: run.id,
        type: "task_status_changed",
        timestamp,
        source: "codex",
        summary,
        payload: {
          status: terminalStatus,
          ...(terminalStatus === "failed" ? { exitCode: 1 } : { exitCode: 0 }),
        },
      });

      const persistedRun = await service.getRun(run.id);
      assert.equal(persistedRun?.status, terminalStatus);
      assert.equal(persistedRun?.finishedAt, timestamp);
      assert.deepEqual(persistedRun?.summary, {
        eventCount: 2,
        lastEventSummary: summary,
        lastEventAt: timestamp,
      });

      const events = await service.listRunEvents(run.id);
      assert.equal(events.length, 2);
      assert.equal(events[1]?.summary, summary);

      const persistedTrack = await service.getTrack(track.id);
      assert.equal(persistedTrack?.status, expectedTrackStatus);
      assert.equal(persistedTrack?.updatedAt, timestamp);
    }),
  );
});

test("SpecRailService updates track workflow and approval state", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-update-track-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn() {
        throw new Error("should not be called");
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = ["2026-04-09T04:00:00.000Z", "2026-04-09T04:05:00.000Z"];
      return () => values.shift() ?? "2026-04-09T04:05:00.000Z";
    })(),
    idGenerator: () => "track-update",
  });

  const track = await service.createTrack({
    title: "Approval workflow",
    description: "Update track workflow state through the service.",
  });

  const updated = await service.updateTrack({
    trackId: track.id,
    status: "review",
    specStatus: "approved",
    planStatus: "pending",
    githubIssue: { number: 28, url: "https://github.com/yoophi-a/specrail/issues/28" },
    githubPullRequest: { number: 30, url: "https://github.com/yoophi-a/specrail/pull/30" },
  });

  assert.equal(updated.status, "review");
  assert.equal(updated.specStatus, "approved");
  assert.equal(updated.planStatus, "pending");
  assert.deepEqual(updated.githubIssue, { number: 28, url: "https://github.com/yoophi-a/specrail/issues/28" });
  assert.deepEqual(updated.githubPullRequest, { number: 30, url: "https://github.com/yoophi-a/specrail/pull/30" });
  assert.equal(updated.updatedAt, "2026-04-09T04:05:00.000Z");

  const persisted = await service.getTrack(track.id);
  assert.deepEqual(persisted, updated);

  await assert.rejects(
    () => service.updateTrack({ trackId: "missing-track", status: "blocked" }),
    /Track not found/,
  );
});

test("SpecRailService trims persisted track fields and run prompts before execution", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-trim-"));
  const spawnCalls: Array<{ prompt: string; profile: string }> = [];
  const resumeCalls: Array<{ prompt: string; profile: string }> = [];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        spawnCalls.push({ prompt: input.prompt, profile: input.profile });
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [
            {
              id: `${input.executionId}:started`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T05:00:00.000Z",
              source: "codex",
              summary: "Run started",
              payload: { status: "running" },
            },
          ],
        };
      },
      async resume(input) {
        resumeCalls.push({ prompt: input.prompt, profile: input.profile });
        return {
          sessionRef: input.sessionRef,
          command: {
            command: "codex",
            args: ["exec", "resume", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
            resumeSessionRef: input.sessionRef,
          },
          events: [
            {
              id: `${input.executionId}:resumed`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T05:05:00.000Z",
              source: "codex",
              summary: "Run resumed",
              payload: { status: "running", sessionRef: input.sessionRef },
            },
          ],
        };
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = ["2026-04-09T05:00:00.000Z", "2026-04-09T05:05:00.000Z"];
      return () => values.shift() ?? "2026-04-09T05:05:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-trim", "run-trim"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "  Trim title  ",
    description: "  Trim description  ",
  });

  assert.equal(track.title, "Trim title");
  assert.equal(track.description, "Trim description");

  const run = await service.startRun({
    trackId: track.id,
    prompt: "  Run the checks  ",
    profile: "  default  ",
  });

  assert.deepEqual(spawnCalls, [{ prompt: "Run the checks", profile: "default" }]);
  assert.equal(run.profile, "default");
  assert.equal(run.command?.prompt, "Run the checks");

  const resumedRun = await service.resumeRun({
    runId: run.id,
    prompt: "  Continue verifying  ",
  });

  assert.deepEqual(resumeCalls, [{ prompt: "Continue verifying", profile: "default" }]);
  assert.equal(resumedRun.command?.prompt, "Continue verifying");
});

test("SpecRailService derives waiting approval and resumed running state from approval events", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-approval-events-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [
            {
              id: `${input.executionId}:started`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T06:00:00.000Z",
              source: "codex",
              summary: "Run started",
              payload: { status: "running" },
            },
          ],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = ["2026-04-09T06:00:00.000Z", "2026-04-09T06:00:01.000Z", "2026-04-09T06:00:02.000Z"];
      return () => values.shift() ?? "2026-04-09T06:00:02.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-approval", "run-approval"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Approval-gated run",
    description: "Reconcile waiting approval from normalized events.",
  });

  const run = await service.startRun({
    trackId: track.id,
    prompt: "Start the gated work",
  });

  await service.recordExecutionEvent({
    id: `${run.id}:approval-requested`,
    executionId: run.id,
    type: "approval_requested",
    timestamp: "2026-04-09T06:00:01.000Z",
    source: "codex",
    summary: "Approval requested",
    payload: {
      gate: "plan",
    },
  });

  const waitingRun = await service.getRun(run.id);
  assert.equal(waitingRun?.status, "waiting_approval");
  assert.equal(waitingRun?.startedAt, run.startedAt);
  assert.equal(waitingRun?.finishedAt, undefined);
  assert.deepEqual(waitingRun?.summary, {
    eventCount: 2,
    lastEventSummary: "Approval requested",
    lastEventAt: "2026-04-09T06:00:01.000Z",
  });

  await service.recordExecutionEvent({
    id: `${run.id}:approval-resolved`,
    executionId: run.id,
    type: "approval_resolved",
    timestamp: "2026-04-09T06:00:02.000Z",
    source: "codex",
    summary: "Approval resolved",
    payload: {
      gate: "plan",
      resolution: "approved",
    },
  });

  const resumedRun = await service.getRun(run.id);
  assert.equal(resumedRun?.status, "running");
  assert.equal(resumedRun?.startedAt, run.startedAt);
  assert.equal(resumedRun?.finishedAt, undefined);
  assert.deepEqual(resumedRun?.summary, {
    eventCount: 3,
    lastEventSummary: "Approval resolved",
    lastEventAt: "2026-04-09T06:00:02.000Z",
  });
});

test("SpecRailService lists tracks and runs with basic filters", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-listing-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [
            {
              id: `${input.executionId}:started`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T05:10:00.000Z",
              source: "codex",
              summary: "Run started",
              payload: { status: "running" },
            },
          ],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = [
        "2026-04-09T05:00:00.000Z",
        "2026-04-09T05:00:00.000Z",
        "2026-04-09T05:05:00.000Z",
        "2026-04-09T05:05:00.000Z",
        "2026-04-09T05:10:00.000Z",
        "2026-04-09T05:15:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-09T05:15:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-one", "track-two", "run-one", "run-two"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const trackOne = await service.createTrack({
    title: "High priority track",
    description: "Track one",
    priority: "high",
  });
  const trackTwo = await service.createTrack({
    title: "Low priority track",
    description: "Track two",
    priority: "low",
  });

  await service.updateTrack({ trackId: trackOne.id, status: "review" });

  const runOne = await service.startRun({ trackId: trackOne.id, prompt: "Run one" });
  const runTwo = await service.startRun({ trackId: trackTwo.id, prompt: "Run two" });

  await service.recordExecutionEvent({
    id: `${runTwo.id}:completed`,
    executionId: runTwo.id,
    type: "task_status_changed",
    timestamp: "2026-04-09T05:20:00.000Z",
    source: "codex",
    summary: "Run completed",
    payload: { status: "completed" },
  });

  const tracks = await service.listTracks();
  assert.deepEqual(
    tracks.map((track) => track.id),
    [trackTwo.id, trackOne.id],
  );
  assert.deepEqual(
    (await service.listTracks({ priority: "low" })).map((track) => track.id),
    [trackTwo.id],
  );
  assert.deepEqual(
    (await service.listTracks({ status: "review" })).map((track) => track.id),
    [trackTwo.id, trackOne.id],
  );

  const runs = await service.listRuns();
  assert.deepEqual(
    runs.map((run) => run.id),
    [runTwo.id, runOne.id],
  );
  assert.deepEqual(
    (await service.listRuns({ trackId: trackOne.id })).map((run) => run.id),
    [runOne.id],
  );
  assert.deepEqual(
    (await service.listRuns({ status: "completed" })).map((run) => run.id),
    [runTwo.id],
  );
});

test("SpecRailService publishes GitHub run summaries for linked issue and pull request targets", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-publish-"));
  const publishCalls: Array<{ trackStatus: string; runStatus: string; eventCount: number }> = [];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [
            {
              id: `${input.executionId}:started`,
              executionId: input.executionId,
              type: "task_status_changed",
              timestamp: "2026-04-09T07:00:00.000Z",
              source: "codex",
              summary: "Run started",
              payload: { status: "running" },
            },
          ],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    githubRunCommentPublisher: {
      async publishRunSummary(input) {
        publishCalls.push({
          trackStatus: input.track.status,
          runStatus: input.run.status,
          eventCount: input.events.length,
        });
        return [
          {
            action: "updated",
            target: { kind: "issue", number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
            body: "summary",
            commentId: 3001,
          },
          {
            action: "updated",
            target: { kind: "pull_request", number: 31, url: "https://github.com/yoophi-a/specrail/pull/31" },
            body: "summary",
            commentId: 3101,
          },
        ];
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = ["2026-04-09T07:00:00.000Z", "2026-04-09T07:00:01.000Z"];
      return () => values.shift() ?? "2026-04-09T07:00:01.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-publish", "run-publish"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Publish linked summaries",
    description: "Push run state to linked GitHub discussions.",
    githubIssue: { number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
    githubPullRequest: { number: 31, url: "https://github.com/yoophi-a/specrail/pull/31" },
  });

  const run = await service.startRun({
    trackId: track.id,
    prompt: "Ship the publish flow",
  });

  assert.deepEqual(publishCalls, [{ trackStatus: "new", runStatus: "running", eventCount: 1 }]);

  await service.recordExecutionEvent({
    id: `${run.id}:completed`,
    executionId: run.id,
    type: "task_status_changed",
    timestamp: "2026-04-09T07:00:01.000Z",
    source: "codex",
    summary: "Run completed",
    payload: { status: "completed" },
  });

  assert.deepEqual(publishCalls, [
    { trackStatus: "new", runStatus: "running", eventCount: 1 },
    { trackStatus: "review", runStatus: "completed", eventCount: 2 },
  ]);

  assert.equal((await service.getTrack(track.id))?.status, "review");
  assert.deepEqual(await service.publishRunSummary(run.id), [
    {
      action: "updated",
      target: { kind: "issue", number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
      body: "summary",
      commentId: 3001,
    },
    {
      action: "updated",
      target: { kind: "pull_request", number: 31, url: "https://github.com/yoophi-a/specrail/pull/31" },
      body: "summary",
      commentId: 3101,
    },
  ]);
});

test("SpecRailService skips GitHub publishing when a track has no linked targets", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-publish-none-"));
  let publishCount = 0;

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    githubRunCommentPublisher: {
      async publishRunSummary() {
        publishCount += 1;
        return [];
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    idGenerator: (() => {
      const values = ["track-unlinked", "run-unlinked"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "No external links",
    description: "This should not publish anywhere.",
  });

  await service.startRun({ trackId: track.id, prompt: "Do the work" });
  assert.equal(publishCount, 0);
});

test("SpecRailService exposes track and run inspections with persisted GitHub sync metadata", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-inspection-sync-"));
  const syncStore = new FileGitHubRunCommentSyncStore(path.join(rootDir, "state"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    githubRunCommentSyncStore: syncStore,
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T00:00:00.000Z",
    idGenerator: (() => {
      const values = ["track-inspection", "run-inspection"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Inspect sync state",
    description: "Surface persisted GitHub sync metadata.",
    githubIssue: { number: 32, url: "https://github.com/yoophi-a/specrail/issues/32" },
  });
  const run = await service.startRun({ trackId: track.id, prompt: "inspect" });

  await syncStore.upsert({
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T00:30:00.000Z",
    comments: [
      {
        target: { kind: "issue", number: 32, url: "https://github.com/yoophi-a/specrail/issues/32" },
        commentId: 3201,
        lastRunId: run.id,
        lastRunStatus: "running",
        lastPublishedAt: "2026-04-10T00:25:00.000Z",
        lastSyncStatus: "success",
      },
    ],
  });

  const trackInspection = await service.getTrackInspection(track.id);
  assert.equal(trackInspection?.track.id, track.id);
  assert.deepEqual(trackInspection?.githubRunCommentSync, {
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T00:30:00.000Z",
    comments: [
      {
        target: { kind: "issue", number: 32, url: "https://github.com/yoophi-a/specrail/issues/32" },
        commentId: 3201,
        lastRunId: run.id,
        lastRunStatus: "running",
        lastPublishedAt: "2026-04-10T00:25:00.000Z",
        lastSyncStatus: "success",
      },
    ],
  });

  const runInspection = await service.getRunInspection(run.id);
  assert.equal(runInspection?.run.id, run.id);
  assert.deepEqual(runInspection?.githubRunCommentSync, {
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T00:30:00.000Z",
    comments: [
      {
        target: { kind: "issue", number: 32, url: "https://github.com/yoophi-a/specrail/issues/32" },
        commentId: 3201,
        lastRunId: run.id,
        lastRunStatus: "running",
        lastPublishedAt: "2026-04-10T00:25:00.000Z",
        lastSyncStatus: "success",
      },
    ],
  });
  assert.deepEqual(runInspection?.githubRunCommentSyncForRun, [
    {
      target: { kind: "issue", number: 32, url: "https://github.com/yoophi-a/specrail/issues/32" },
      commentId: 3201,
      lastRunId: run.id,
      lastRunStatus: "running",
      lastPublishedAt: "2026-04-10T00:25:00.000Z",
      lastSyncStatus: "success",
    },
  ]);

  const integrationsInspection = await service.getTrackIntegrationsInspection(track.id);
  assert.equal(integrationsInspection?.trackId, track.id);
  assert.deepEqual(integrationsInspection?.github.issue, {
    number: 32,
    url: "https://github.com/yoophi-a/specrail/issues/32",
  });
  assert.equal(integrationsInspection?.github.pullRequest, undefined);
  assert.deepEqual(integrationsInspection?.github.runCommentSync, {
        id: track.id,
        trackId: track.id,
        updatedAt: "2026-04-10T00:30:00.000Z",
        comments: [
          {
            target: { kind: "issue", number: 32, url: "https://github.com/yoophi-a/specrail/issues/32" },
            commentId: 3201,
            lastRunId: run.id,
            lastRunStatus: "running",
            lastPublishedAt: "2026-04-10T00:25:00.000Z",
            lastSyncStatus: "success",
          },
        ],
      });
  assert.deepEqual(integrationsInspection?.github.summary, {
    linkedTargetCount: 1,
    syncedTargetCount: 1,
    lastPublishedAt: "2026-04-10T00:25:00.000Z",
    lastSyncStatus: "success",
  });
});

test("SpecRailService exposes empty GitHub integration inspection summaries without sync state", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-integrations-empty-"));
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn() {
        throw new Error("should not be called");
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T00:00:00.000Z",
    idGenerator: () => "track-empty-integrations",
  });

  const track = await service.createTrack({
    title: "Inspect empty integration state",
    description: "Surface linked GitHub references without sync metadata.",
    githubIssue: { number: 33, url: "https://github.com/yoophi-a/specrail/issues/33" },
    githubPullRequest: { number: 34, url: "https://github.com/yoophi-a/specrail/pull/34" },
  });

  assert.deepEqual(await service.getTrackIntegrationsInspection(track.id), {
    trackId: track.id,
    github: {
      issue: { number: 33, url: "https://github.com/yoophi-a/specrail/issues/33" },
      pullRequest: { number: 34, url: "https://github.com/yoophi-a/specrail/pull/34" },
      runCommentSync: null,
      summary: {
        linkedTargetCount: 2,
        syncedTargetCount: 0,
      },
    },
  });
});

test("SpecRailService persists GitHub run comment sync metadata and passes it back on republish", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-publish-sync-"));
  const syncStore = new FileGitHubRunCommentSyncStore(path.join(rootDir, "state"));
  const syncStates: Array<number | undefined> = [];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    githubRunCommentSyncStore: syncStore,
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    githubRunCommentPublisher: {
      async publishRunSummary(input) {
        syncStates.push(input.syncState?.comments[0]?.commentId);
        return [
          {
            action: input.syncState ? "updated" : "created",
            target: { kind: "issue", number: 31, url: "https://github.com/yoophi-a/specrail/issues/31" },
            body: `summary:${input.run.status}`,
            commentId: 3101,
          },
        ];
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = [
        "2026-04-10T00:00:00.000Z",
        "2026-04-10T00:00:01.000Z",
        "2026-04-10T00:00:02.000Z",
        "2026-04-10T00:00:03.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T00:00:03.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-sync", "run-sync"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Persist summary sync",
    description: "Remember published comment ids.",
    githubIssue: { number: 31, url: "https://github.com/yoophi-a/specrail/issues/31" },
  });

  const run = await service.startRun({ trackId: track.id, prompt: "publish" });
  await service.publishRunSummary(run.id);

  assert.deepEqual(syncStates, [undefined, 3101]);
  assert.deepEqual(await syncStore.getByTrackId(track.id), {
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T00:00:03.000Z",
    comments: [
      {
        target: { kind: "issue", number: 31, url: "https://github.com/yoophi-a/specrail/issues/31" },
        commentId: 3101,
        lastRunId: run.id,
        lastRunStatus: "running",
        lastPublishedAt: "2026-04-10T00:00:03.000Z",
        lastCommentBody: "summary:running",
        lastSyncStatus: "success",
      },
    ],
  });
});

test("SpecRailService records failed GitHub run summary sync attempts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-publish-failure-"));
  const syncStore = new FileGitHubRunCommentSyncStore(path.join(rootDir, "state"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    githubRunCommentSyncStore: syncStore,
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn(input) {
        return {
          sessionRef: `session:${input.executionId}`,
          command: {
            command: "codex",
            args: ["exec", input.prompt],
            cwd: input.workspacePath,
            prompt: input.prompt,
          },
          events: [],
        };
      },
      async resume() {
        throw new Error("should not be called");
      },
      async cancel() {
        throw new Error("should not be called");
      },
    },
    githubRunCommentPublisher: {
      async publishRunSummary() {
        throw new Error("GitHub temporarily unavailable");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = ["2026-04-10T01:00:00.000Z", "2026-04-10T01:00:01.000Z"];
      return () => values.shift() ?? "2026-04-10T01:00:01.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-failure", "run-failure"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Handle sync failures",
    description: "Persist failure metadata for retry visibility.",
    githubIssue: { number: 31, url: "https://github.com/yoophi-a/specrail/issues/31" },
  });

  await assert.rejects(
    () => service.startRun({ trackId: track.id, prompt: "publish" }),
    /GitHub temporarily unavailable/,
  );

  assert.deepEqual(await syncStore.getByTrackId(track.id), {
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T01:00:01.000Z",
    comments: [
      {
        target: { kind: "issue", number: 31, url: "https://github.com/yoophi-a/specrail/issues/31" },
        lastRunId: "run-run-failure",
        lastRunStatus: "running",
        lastPublishedAt: "2026-04-10T01:00:01.000Z",
        lastSyncStatus: "failed",
        lastSyncError: "GitHub temporarily unavailable",
      },
    ],
  });
});
