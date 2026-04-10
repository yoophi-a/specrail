import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExecutionEvent } from "../../domain/types.js";
import {
  FileHeartbeatStateStore,
  FileGitHubRunCommentSyncStore,
  FileExecutionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
} from "../file-repositories.js";
import { SpecRailService } from "../specrail-service.js";

test("SpecRailService updates durable heartbeat state for start, report, and completion", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-heartbeat-"));
  const stateDir = path.join(rootDir, "state");
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(stateDir),
    trackRepository: new FileTrackRepository(stateDir),
    executionRepository: new FileExecutionRepository(stateDir),
    eventStore: new JsonlEventStore(stateDir),
    heartbeatStateStore: new FileHeartbeatStateStore(stateDir),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn() {
        throw new Error("not used");
      },
      async resume() {
        throw new Error("not used");
      },
      async cancel() {
        throw new Error("not used");
      },
    },
    defaultProject: { id: "project-default", name: "SpecRail" },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = [
        "2026-04-10T00:00:00.000Z",
        "2026-04-10T00:05:00.000Z",
        "2026-04-10T00:10:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T00:10:00.000Z";
    })(),
  });

  const started = await service.markHeartbeatTaskStarted({
    task: { trackId: "track-56", runId: "run-56", taskId: "issue-56", title: "Add heartbeat state tracking" },
    session: { sessionRef: "session:run-56", executionId: "run-56", profile: "default" },
  });
  assert.equal(started.lastStartedTask?.task.taskId, "issue-56");
  assert.equal(started.activeTask?.session?.sessionRef, "session:run-56");

  const reported = await service.markHeartbeatReported();
  assert.equal(reported.lastReportAt, "2026-04-10T00:05:00.000Z");
  assert.equal(reported.activeTask?.task.taskId, "issue-56");

  const completed = await service.markHeartbeatTaskCompleted();
  assert.equal(completed.activeTask, undefined);
  assert.equal(completed.lastCompletedTask?.task.taskId, "issue-56");
  assert.equal(completed.lastCompletedTask?.session?.sessionRef, "session:run-56");

  const persisted = await service.getHeartbeatState();
  assert.equal(persisted?.activeTask, undefined);
  assert.deepEqual(persisted, {
    id: "specrail-automation",
    updatedAt: "2026-04-10T00:10:00.000Z",
    lastStartedTask: completed.lastStartedTask,
    lastCompletedTask: completed.lastCompletedTask,
    lastReportAt: "2026-04-10T00:05:00.000Z",
  });
});

test("SpecRailService skips heartbeat dispatch when the same task or session is already active", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-heartbeat-active-"));
  const stateDir = path.join(rootDir, "state");
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(stateDir),
    trackRepository: new FileTrackRepository(stateDir),
    executionRepository: new FileExecutionRepository(stateDir),
    eventStore: new JsonlEventStore(stateDir),
    heartbeatStateStore: new FileHeartbeatStateStore(stateDir),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn() {
        throw new Error("not used");
      },
      async resume() {
        throw new Error("not used");
      },
      async cancel() {
        throw new Error("not used");
      },
    },
    defaultProject: { id: "project-default", name: "SpecRail" },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T00:05:00.000Z",
  });

  await service.markHeartbeatTaskStarted({
    task: { trackId: "track-57", runId: "run-57", taskId: "issue-57", title: "Prevent duplicate heartbeat dispatches" },
    session: { sessionRef: "session:run-57", executionId: "run-57", profile: "default" },
  });

  const byTask = await service.evaluateHeartbeatDispatch({
    task: { trackId: "track-57", runId: "run-57", taskId: "issue-57", title: "Prevent duplicate heartbeat dispatches" },
    session: { sessionRef: "session:other", executionId: "run-other" },
  });
  assert.deepEqual(byTask, {
    action: "skip",
    reason: "active_task",
    matchedTask: true,
    matchedSession: false,
  });

  const bySession = await service.evaluateHeartbeatDispatch({
    task: { trackId: "track-57", runId: "run-other", taskId: "issue-other", title: "Other candidate" },
    session: { sessionRef: "session:run-57", executionId: "run-57" },
  });
  assert.deepEqual(bySession, {
    action: "skip",
    reason: "active_task",
    matchedTask: false,
    matchedSession: true,
  });
});

test("SpecRailService applies cooldown after recent heartbeat completion and allows safe re-entry later", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-heartbeat-cooldown-"));
  const stateDir = path.join(rootDir, "state");
  const nowValues = ["2026-04-10T00:01:00.000Z", "2026-04-10T00:01:20.000Z", "2026-04-10T00:03:10.000Z", "2026-04-10T00:04:30.000Z"];
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(stateDir),
    trackRepository: new FileTrackRepository(stateDir),
    executionRepository: new FileExecutionRepository(stateDir),
    eventStore: new JsonlEventStore(stateDir),
    heartbeatStateStore: new FileHeartbeatStateStore(stateDir),
    artifactWriter: { async write() {} },
    executor: {
      name: "codex",
      async spawn() {
        throw new Error("not used");
      },
      async resume() {
        throw new Error("not used");
      },
      async cancel() {
        throw new Error("not used");
      },
    },
    defaultProject: { id: "project-default", name: "SpecRail" },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => nowValues.shift() ?? "2026-04-10T00:04:30.000Z",
  });

  await service.markHeartbeatTaskStarted({
    task: { trackId: "track-57", runId: "run-57", taskId: "issue-57", title: "Prevent duplicate heartbeat dispatches" },
    session: { sessionRef: "session:run-57", executionId: "run-57" },
  });
  await service.markHeartbeatTaskCompleted();

  const duringCooldown = await service.evaluateHeartbeatDispatch({
    task: { trackId: "track-57", runId: "run-57", taskId: "issue-57", title: "Prevent duplicate heartbeat dispatches" },
    session: { sessionRef: "session:run-57", executionId: "run-57" },
    cooldownMs: 180000,
  });
  assert.deepEqual(duringCooldown, {
    action: "skip",
    reason: "recent_completion_cooldown",
    cooldownRemainingMs: 70000,
    matchedTask: true,
    matchedSession: true,
  });

  const afterCooldown = await service.evaluateHeartbeatDispatch({
    task: { trackId: "track-57", runId: "run-57", taskId: "issue-57", title: "Prevent duplicate heartbeat dispatches" },
    session: { sessionRef: "session:run-57", executionId: "run-57" },
    cooldownMs: 180000,
  });
  assert.deepEqual(afterCooldown, {
    action: "dispatch",
    reason: "safe_reentry",
  });
});

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
    artifactReader: {
      async read(trackId) {
        return {
          spec: `# Spec for ${trackId}`,
          plan: `# Plan for ${trackId}`,
          tasks: `# Tasks for ${trackId}`,
        };
      },
    },
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
    artifactReader: {
      async read(trackId) {
        return {
          spec: `# Spec for ${trackId}`,
          plan: `# Plan for ${trackId}`,
          tasks: `# Tasks for ${trackId}`,
        };
      },
    },
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
    artifactReader: {
      async read(trackId) {
        return {
          spec: `# Spec for ${trackId}`,
          plan: `# Plan for ${trackId}`,
          tasks: `# Tasks for ${trackId}`,
        };
      },
    },
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
  assert.deepEqual(runInspection?.completionVerification, {
    status: "not_applicable",
    checkedAt: "2026-04-10T00:00:00.000Z",
    summary: "Run is running, so terminal completion verification is not applicable yet.",
    signals: [],
  });

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

test("SpecRailService verifies completed runs with fallback reconciliation signals", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-completion-verify-"));
  const stateDir = path.join(rootDir, "state");
  const projectRepository = new FileProjectRepository(stateDir);
  const trackRepository = new FileTrackRepository(stateDir);
  const executionRepository = new FileExecutionRepository(stateDir);
  const eventStore = new JsonlEventStore(stateDir);
  const syncStore = new FileGitHubRunCommentSyncStore(stateDir);
  const service = new SpecRailService({
    projectRepository,
    trackRepository,
    executionRepository,
    eventStore,
    githubRunCommentSyncStore: syncStore,
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
    defaultProject: { id: "project-default", name: "SpecRail" },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T00:40:00.000Z",
  });

  const track = await service.createTrack({
    title: "Verify completion",
    description: "Do not trust completion events alone.",
    githubIssue: { number: 58, url: "https://github.com/yoophi-a/specrail/issues/58" },
  });
  await service.updateTrack({ trackId: track.id, status: "review" });

  const run = {
    id: "run-verified",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: path.join(rootDir, "workspaces", "run-verified"),
    branchName: "specrail/run-verified",
    sessionRef: "session:run-verified",
    summary: {
      eventCount: 2,
      lastEventSummary: "Run completed",
      lastEventAt: "2026-04-10T00:31:00.000Z",
    },
    status: "completed" as const,
    createdAt: "2026-04-10T00:10:00.000Z",
    startedAt: "2026-04-10T00:11:00.000Z",
    finishedAt: "2026-04-10T00:31:00.000Z",
  };
  await executionRepository.create(run);
  await eventStore.append({
    id: "run-verified:summary",
    executionId: run.id,
    type: "summary",
    timestamp: "2026-04-10T00:31:00.000Z",
    source: "codex",
    summary: "Run completed",
  });
  await syncStore.upsert({
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T00:32:00.000Z",
    comments: [
      {
        target: { kind: "issue", number: 58, url: "https://github.com/yoophi-a/specrail/issues/58" },
        commentId: 5801,
        lastRunId: run.id,
        lastRunStatus: "completed",
        lastPublishedAt: "2026-04-10T00:32:00.000Z",
        lastSyncStatus: "success",
      },
    ],
  });

  const inspection = await service.getRunInspection(run.id);
  assert.equal(inspection?.completionVerification.status, "verified");
  assert.equal(inspection?.completionVerification.terminalStatus, "completed");
  assert.match(inspection?.completionVerification.summary ?? "", /corroborated/);
  assert.deepEqual(
    inspection?.completionVerification.signals.map((signal) => [signal.key, signal.status]),
    [
      ["terminal_event", "missing"],
      ["run_record", "passed"],
      ["run_summary", "passed"],
      ["track_reconciliation", "passed"],
      ["github_sync", "passed"],
    ],
  );
});

test("SpecRailService flags completed runs that only have a completion event claim", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-completion-review-"));
  const stateDir = path.join(rootDir, "state");
  const projectRepository = new FileProjectRepository(stateDir);
  const trackRepository = new FileTrackRepository(stateDir);
  const executionRepository = new FileExecutionRepository(stateDir);
  const eventStore = new JsonlEventStore(stateDir);
  const service = new SpecRailService({
    projectRepository,
    trackRepository,
    executionRepository,
    eventStore,
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
    defaultProject: { id: "project-default", name: "SpecRail" },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T00:40:00.000Z",
  });

  const track = await service.createTrack({
    title: "Review completion",
    description: "Terminal event alone should not be trusted.",
  });

  const run = {
    id: "run-needs-review",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: path.join(rootDir, "workspaces", "run-needs-review"),
    branchName: "specrail/run-needs-review",
    status: "completed" as const,
    createdAt: "2026-04-10T00:10:00.000Z",
  };
  await executionRepository.create(run);
  await eventStore.append({
    id: "run-needs-review:completed",
    executionId: run.id,
    type: "task_status_changed",
    timestamp: "2026-04-10T00:20:00.000Z",
    source: "codex",
    summary: "Run completed",
    payload: { status: "completed" },
  });

  const inspection = await service.getRunInspection(run.id);
  assert.equal(inspection?.completionVerification.status, "needs_review");
  assert.match(inspection?.completionVerification.summary ?? "", /needs operator review/);
  assert.deepEqual(
    inspection?.completionVerification.signals.map((signal) => [signal.key, signal.status]),
    [
      ["terminal_event", "passed"],
      ["run_record", "failed"],
      ["run_summary", "missing"],
      ["track_reconciliation", "failed"],
      ["github_sync", "passed"],
    ],
  );
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
    openSpec: {
      trackId: track.id,
      imports: {
        latest: null,
        items: [],
        meta: { total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
      },
      exports: {
        latest: null,
        items: [],
        meta: { total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
      },
    },
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

test("SpecRailService retries failed GitHub run comment syncs using the latest failed run", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-retry-sync-"));
  const syncStore = new FileGitHubRunCommentSyncStore(path.join(rootDir, "state"));
  const publishCalls: Array<{ runId: string; syncCommentId?: number }> = [];

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
        publishCalls.push({
          runId: input.run.id,
          syncCommentId: input.syncState?.comments[0]?.commentId,
        });
        return [
          {
            action: "updated",
            target: { kind: "issue", number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
            body: `summary:${input.run.status}`,
            commentId: 3401,
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
        "2026-04-10T02:00:00.000Z",
        "2026-04-10T02:00:01.000Z",
        "2026-04-10T02:00:02.000Z",
        "2026-04-10T02:00:03.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T02:00:03.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-retry", "run-retry-old", "run-retry-new"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Retry sync failures",
    description: "Reuse the publish flow for failed GitHub syncs.",
    githubIssue: { number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
  });

  const olderRun = await service.startRun({ trackId: track.id, prompt: "older run" });
  const newerRun = await service.startRun({ trackId: track.id, prompt: "newer run" });

  await syncStore.upsert({
    id: track.id,
    trackId: track.id,
    updatedAt: "2026-04-10T02:00:02.000Z",
    comments: [
      {
        target: { kind: "issue", number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
        commentId: 3401,
        lastRunId: newerRun.id,
        lastRunStatus: newerRun.status,
        lastPublishedAt: "2026-04-10T02:00:02.000Z",
        lastCommentBody: "summary:running",
        lastSyncStatus: "failed",
        lastSyncError: "GitHub temporarily unavailable",
      },
      {
        target: { kind: "pull_request", number: 35, url: "https://github.com/yoophi-a/specrail/pull/35" },
        commentId: 3501,
        lastRunId: olderRun.id,
        lastRunStatus: olderRun.status,
        lastPublishedAt: "2026-04-10T02:00:01.000Z",
        lastCommentBody: "summary:running",
        lastSyncStatus: "failed",
        lastSyncError: "GitHub temporarily unavailable",
      },
    ],
  });

  assert.deepEqual(await service.retryGitHubRunCommentSync(track.id), {
    runId: newerRun.id,
    results: [
      {
        action: "updated",
        target: { kind: "issue", number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
        body: "summary:running",
        commentId: 3401,
      },
    ],
  });
  assert.deepEqual(publishCalls.at(-1), { runId: newerRun.id, syncCommentId: 3401 });
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

test("SpecRailService exports a track through the OpenSpec adapter", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-openspec-export-"));
  const exportCalls: Array<{ trackId: string; targetPath: string; overwrite?: boolean; spec: string }> = [];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    artifactReader: {
      async read(trackId) {
        return {
          spec: `# Spec for ${trackId}`,
          plan: "# Plan",
          tasks: "# Tasks",
        };
      },
    },
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
    openSpecAdapter: {
      name: "openspec-file",
      async importPackage() {
        throw new Error("should not be called");
      },
      async exportPackage(input) {
        exportCalls.push({
          trackId: input.package.track.id,
          targetPath: input.target.path,
          overwrite: input.target.overwrite,
          spec: input.package.artifacts.spec,
        });

        return input;
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T04:00:00.000Z",
    idGenerator: () => "track-openspec-export",
  });

  const track = await service.createTrack({
    title: "Export OpenSpec bundle",
    description: "Package track artifacts for external exchange.",
  });

  const result = await service.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: path.join(rootDir, "bundle"), overwrite: true },
  });

  assert.equal(result.package.track.id, track.id);
  assert.deepEqual(exportCalls, [
    {
      trackId: track.id,
      targetPath: path.join(rootDir, "bundle"),
      overwrite: true,
      spec: `# Spec for ${track.id}`,
    },
  ]);

  const exportInspection = await service.getTrackOpenSpecImports(track.id);
  assert.ok(exportInspection);
  assert.equal(exportInspection.exports.latest?.target.path, path.join(rootDir, "bundle"));
  assert.equal(exportInspection.exports.items.length, 1);

  const exportHistory = await service.listOpenSpecExportHistory({ trackId: track.id });
  assert.equal(exportHistory.length, 1);
  assert.equal(exportHistory[0]?.exportRecord.target.path, path.join(rootDir, "bundle"));
});

test("SpecRailService imports OpenSpec bundles into created and existing tracks", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-openspec-import-"));
  const writes: Array<{ trackId: string; spec: string; plan: string; tasks: string }> = [];
  const existingArtifacts = new Map<string, { spec: string; plan: string; tasks: string }>();
  const importedTrack = {
    id: "track-openspec-import",
    projectId: "project-foreign",
    title: "  Imported track  ",
    description: "  Imported description  ",
    status: "ready" as const,
    specStatus: "approved" as const,
    planStatus: "pending" as const,
    priority: "high" as const,
    githubIssue: { number: 36, url: "https://github.com/yoophi-a/specrail/issues/36" },
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: {
      async write(input) {
        existingArtifacts.set(input.track.id, {
          spec: input.specContent,
          plan: input.planContent,
          tasks: input.tasksContent,
        });
        writes.push({
          trackId: input.track.id,
          spec: input.specContent,
          plan: input.planContent,
          tasks: input.tasksContent,
        });
      },
    },
    artifactReader: {
      async read(trackId) {
        const artifacts = existingArtifacts.get(trackId);
        if (!artifacts) {
          throw new Error(`missing artifacts for ${trackId}`);
        }

        return artifacts;
      },
    },
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
    openSpecAdapter: {
      name: "openspec-file",
      async importPackage() {
        return {
          package: {
            metadata: {
              version: 1,
              format: "specrail.openspec.bundle",
              exportedAt: "2026-04-10T04:00:00.000Z",
              generatedBy: "specrail",
            },
            track: importedTrack,
            artifacts: {
              spec: "# Imported spec",
              plan: "# Imported plan",
              tasks: "# Imported tasks",
            },
            files: {
              spec: "spec.md",
              plan: "plan.md",
              tasks: "tasks.md",
            },
          },
        };
      },
      async exportPackage() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    idGenerator: (() => {
      const values = ["import-1", "import-2"];
      return () => values.shift() ?? "import-tail";
    })(),
    now: (() => {
      const values = ["2026-04-10T04:00:00.000Z", "2026-04-10T04:05:00.000Z", "2026-04-10T04:10:00.000Z"];
      return () => values.shift() ?? "2026-04-10T04:10:00.000Z";
    })(),
  });

  const created = await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    conflictPolicy: "overwrite",
  });
  assert.equal(created.action, "created");
  assert.equal(created.applied, true);
  assert.equal(created.track.id, importedTrack.id);
  assert.equal(created.track.projectId, importedTrack.projectId);
  assert.equal(created.track.title, "Imported track");
  assert.equal(created.track.description, "Imported description");
  assert.equal(created.track.updatedAt, "2026-04-10T04:05:00.000Z");
  assert.deepEqual(created.provenance, {
    id: "openspec-import-import-1",
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    importedAt: "2026-04-10T04:05:00.000Z",
    conflictPolicy: "overwrite",
    bundle: {
      version: 1,
      format: "specrail.openspec.bundle",
      exportedAt: "2026-04-10T04:00:00.000Z",
      generatedBy: "specrail",
    },
  });
  assert.equal(created.importHistory.length, 1);
  assert.equal(created.resolvedArtifacts.spec, "# Imported spec");

  const updated = await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    conflictPolicy: "overwrite",
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.applied, true);
  assert.equal(updated.track.createdAt, "2026-04-09T00:00:00.000Z");
  assert.equal(updated.track.updatedAt, "2026-04-10T04:10:00.000Z");
  assert.equal(updated.conflict.details[0]?.field, "track.id");
  assert.equal(updated.track.openSpecImport?.source.path, path.join(rootDir, "bundle"));
  assert.equal(updated.importHistory.length, 2);

  assert.deepEqual(writes, [
    {
      trackId: importedTrack.id,
      spec: "# Imported spec",
      plan: "# Imported plan",
      tasks: "# Imported tasks",
    },
    {
      trackId: importedTrack.id,
      spec: "# Imported spec",
      plan: "# Imported plan",
      tasks: "# Imported tasks",
    },
  ]);
});

test("SpecRailService previews OpenSpec imports and rejects collisions unless overwrite is explicit", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-openspec-import-preview-"));
  const writes: Array<{ trackId: string; spec: string; plan: string; tasks: string }> = [];
  const existingArtifacts = new Map<string, { spec: string; plan: string; tasks: string }>();
  const importedArtifacts = {
    spec: "# Preview spec",
    plan: "# Preview plan",
    tasks: "# Preview tasks",
  };
  const importedTrack = {
    id: "track-openspec-preview",
    projectId: "project-foreign",
    title: "Imported preview",
    description: "Imported preview description",
    status: "ready" as const,
    specStatus: "approved" as const,
    planStatus: "pending" as const,
    priority: "medium" as const,
    githubIssue: null,
    githubPullRequest: null,
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: {
      async write(input) {
        existingArtifacts.set(input.track.id, {
          spec: input.specContent,
          plan: input.planContent,
          tasks: input.tasksContent,
        });
        writes.push({
          trackId: input.track.id,
          spec: input.specContent,
          plan: input.planContent,
          tasks: input.tasksContent,
        });
      },
    },
    artifactReader: {
      async read(trackId) {
        const artifacts = existingArtifacts.get(trackId);
        if (!artifacts) {
          throw new Error(`missing artifacts for ${trackId}`);
        }

        return artifacts;
      },
    },
    executor: {
      name: "codex",
      async spawn() { throw new Error("should not be called"); },
      async resume() { throw new Error("should not be called"); },
      async cancel() { throw new Error("should not be called"); },
    },
    openSpecAdapter: {
      name: "openspec-file",
      async importPackage() {
        return {
          package: {
            metadata: {
              version: 1,
              format: "specrail.openspec.bundle",
              exportedAt: "2026-04-10T04:00:00.000Z",
              generatedBy: "specrail",
            },
            track: importedTrack,
            artifacts: importedArtifacts,
            files: {
              spec: "spec.md",
              plan: "plan.md",
              tasks: "tasks.md",
            },
          },
        };
      },
      async exportPackage() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => "2026-04-10T04:00:00.000Z",
  });

  const preview = await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    dryRun: true,
  });
  assert.equal(preview.action, "created");
  assert.equal(preview.applied, false);
  assert.equal(preview.conflict.hasConflict, false);

  await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    conflictPolicy: "overwrite",
  });

  await assert.rejects(
    () =>
      service.importTrackFromOpenSpec({
        source: { kind: "file", path: path.join(rootDir, "bundle") },
      }),
    /Retry with conflictPolicy=overwrite or dryRun=true/,
  );

  importedArtifacts.spec = "# Preview spec updated\n";

  const collisionPreview = await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    dryRun: true,
  });
  assert.equal(collisionPreview.action, "updated");
  assert.equal(collisionPreview.applied, false);
  assert.equal(collisionPreview.conflict.hasConflict, true);
  assert.equal(collisionPreview.conflict.reason, "track_id_exists");
  assert.ok(collisionPreview.conflict.details.some((detail) => detail.field === "artifacts.spec"));
  assert.equal(collisionPreview.provenance.source.path, path.join(rootDir, "bundle"));
  assert.equal(collisionPreview.operatorGuide.selectedPreset, null);
  assert.ok(collisionPreview.operatorGuide.examples.some((example) => example.id === "policy-defaults-resolve"));
  assert.equal(writes.length, 1);
});

test("SpecRailService exposes operator-facing OpenSpec import help for preset selection", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-openspec-help-"));
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() { throw new Error("should not be called"); } },
    executor: {
      name: "codex",
      async spawn() { throw new Error("should not be called"); },
      async resume() { throw new Error("should not be called"); },
      async cancel() { throw new Error("should not be called"); },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
  });

  const help = service.getOpenSpecImportHelp({ resolutionPreset: "policyDefaults" });
  assert.deepEqual(help.recommendedFlow.slice(0, 2), [
    "Preview with dryRun=true first.",
    "Pick a named preset that matches the workflow you want.",
  ]);
  assert.equal(help.selectedPreset?.name, "policyDefaults");
  assert.ok(help.selectedPreset?.choices.some((choice) => choice.field === "status" && choice.choice === "existing"));
  assert.ok(help.examples.some((example) => example.id === "preset-with-override"));
  assert.ok(help.conflictPolicies.some((policy) => policy.name === "overwrite"));
});

test("SpecRailService resolves OpenSpec conflicts with field-level keep-existing choices and lists import history", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-openspec-resolve-"));
  const existingArtifacts = new Map<string, { spec: string; plan: string; tasks: string }>();
  const importedPackage = {
    metadata: {
      version: 1 as const,
      format: "specrail.openspec.bundle" as const,
      exportedAt: "2026-04-10T06:00:00.000Z",
      generatedBy: "specrail" as const,
    },
    track: {
      id: "track-placeholder",
      projectId: "project-foreign",
      title: "Incoming title",
      description: "Incoming description",
      status: "ready" as const,
      specStatus: "approved" as const,
      planStatus: "approved" as const,
      priority: "high" as const,
      githubIssue: { number: 39, url: "https://github.com/yoophi-a/specrail/issues/39" },
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
    },
    artifacts: {
      spec: "# Incoming spec\n",
      plan: "# Incoming plan\n",
      tasks: "# Incoming tasks\n",
    },
    files: {
      spec: "spec.md",
      plan: "plan.md",
      tasks: "tasks.md",
    },
  };

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: {
      async write(input) {
        existingArtifacts.set(input.track.id, {
          spec: input.specContent,
          plan: input.planContent,
          tasks: input.tasksContent,
        });
      },
    },
    artifactReader: {
      async read(trackId) {
        const artifacts = existingArtifacts.get(trackId);
        if (!artifacts) {
          throw new Error(`missing artifacts for ${trackId}`);
        }

        return artifacts;
      },
    },
    executor: {
      name: "codex",
      async spawn() { throw new Error("should not be called"); },
      async resume() { throw new Error("should not be called"); },
      async cancel() { throw new Error("should not be called"); },
    },
    openSpecAdapter: {
      name: "openspec-file",
      async importPackage() {
        return { package: importedPackage };
      },
      async exportPackage() {
        throw new Error("should not be called");
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    idGenerator: () => "resolve-1",
    now: () => "2026-04-10T06:05:00.000Z",
  });

  const created = await service.createTrack({ title: "Existing title", description: "Existing description" });
  existingArtifacts.set(created.id, {
    spec: "# Existing spec\n",
    plan: "# Existing plan\n",
    tasks: "# Existing tasks\n",
  });
  await service.updateTrack({ trackId: created.id, status: "planned" });
  importedPackage.track.id = created.id;

  const result = await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "bundle") },
    conflictPolicy: "resolve",
    resolutionPreset: "policyDefaults",
    resolution: {
      track: { title: "existing" },
      artifacts: { spec: "existing", plan: "incoming", tasks: "existing" },
    },
  });

  assert.equal(result.track.title, "Existing title");
  assert.equal(result.track.description, "Incoming description");
  assert.equal(result.track.status, "planned");
  assert.equal(result.resolvedArtifacts.spec, "# Existing spec\n");
  assert.equal(result.resolvedArtifacts.plan, "# Incoming plan\n");
  assert.equal(result.resolvedArtifacts.tasks, "# Existing tasks\n");
  assert.equal(result.provenance.conflictPolicy, "resolve");
  assert.equal(result.provenance.resolutionPreset, "policyDefaults");
  assert.deepEqual(result.provenance.resolution, {
    track: {
      title: "existing",
      description: "incoming",
      status: "existing",
      specStatus: "existing",
      planStatus: "existing",
      priority: "existing",
      githubIssue: "existing",
      githubPullRequest: "existing",
    },
    artifacts: { spec: "existing", plan: "incoming", tasks: "existing" },
  });
  assert.equal(result.resolutionGuide.presetApplied, "policyDefaults");
  assert.equal(result.resolutionGuide.effectiveResolution.track?.status, "existing");
  assert.equal(result.resolutionGuide.effectiveResolution.track?.title, "existing");
  assert.equal(result.resolutionGuide.effectiveResolution.artifacts?.plan, "incoming");
  assert.ok(result.resolutionGuide.policies.some((policy) => policy.field === "status" && policy.defaultChoice === "existing"));
  assert.ok(result.resolutionGuide.presets.some((preset) => preset.name === "preferIncomingArtifacts"));
  assert.equal(result.operatorGuide.selectedPreset?.name, "policyDefaults");
  assert.ok(result.operatorGuide.effectiveChoices.some((choice) => choice.field === "plan" && choice.choice === "incoming"));

  const importInspection = await service.getTrackOpenSpecImports(created.id);
  assert.ok(importInspection);
  assert.equal(importInspection.imports.latest?.conflictPolicy, "resolve");
  assert.equal(importInspection.imports.items.length, 1);
  assert.equal(importInspection.exports.latest, null);
  assert.equal(importInspection.exports.items.length, 0);

  const adminHistory = await service.listOpenSpecImportHistory();
  assert.equal(adminHistory.length, 1);
  assert.equal(adminHistory[0]?.trackId, created.id);
});

test("SpecRailService paginates and filters OpenSpec audit history", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-openspec-history-page-"));
  const timestamps = [
    "2026-04-10T01:00:00.000Z",
    "2026-04-10T02:00:00.000Z",
    "2026-04-10T03:00:00.000Z",
    "2026-04-10T04:00:00.000Z",
    "2026-04-10T05:00:00.000Z",
    "2026-04-10T06:00:00.000Z",
  ];
  let timestampIndex = 0;
  let importCount = 0;
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {} },
    artifactReader: {
      async read(trackId) {
        return {
          spec: `# Spec for ${trackId}`,
          plan: `# Plan for ${trackId}`,
          tasks: `# Tasks for ${trackId}`,
        };
      },
    },
    executor: {
      name: "codex",
      async spawn() { throw new Error("should not be called"); },
      async resume() { throw new Error("should not be called"); },
      async cancel() { throw new Error("should not be called"); },
    },
    openSpecAdapter: {
      name: "openspec-file",
      async importPackage() {
        importCount += 1;
        return {
          package: {
            metadata: {
              version: 1,
              format: "specrail.openspec.bundle",
              exportedAt: timestamps[Math.min(importCount - 1, timestamps.length - 1)] ?? timestamps.at(-1)!,
              generatedBy: "specrail",
            },
            track: {
              id: `track-import-${importCount}`,
              projectId: "project-foreign",
              title: `Imported ${importCount}`,
              description: `Imported description ${importCount}`,
              status: "ready",
              specStatus: "approved",
              planStatus: "approved",
              priority: "medium",
              createdAt: "2026-04-09T00:00:00.000Z",
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
            artifacts: {
              spec: `# Spec ${importCount}\n`,
              plan: `# Plan ${importCount}\n`,
              tasks: `# Tasks ${importCount}\n`,
            },
            files: { spec: "spec.md", plan: "plan.md", tasks: "tasks.md" },
          },
        };
      },
      async exportPackage(input) {
        return input;
      },
    },
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: () => timestamps[timestampIndex++] ?? timestamps.at(-1)!,
    idGenerator: () => `generated-${timestampIndex}`,
  });

  const exportTrackA = await service.createTrack({ title: "Export A", description: "A" });
  const exportTrackB = await service.createTrack({ title: "Export B", description: "B" });

  await service.exportTrackToOpenSpec({
    trackId: exportTrackA.id,
    target: { kind: "file", path: path.join(rootDir, "bundle-a"), overwrite: false },
  });
  await service.exportTrackToOpenSpec({
    trackId: exportTrackB.id,
    target: { kind: "file", path: path.join(rootDir, "bundle-b"), overwrite: true },
  });

  await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "imports", "alpha") },
    conflictPolicy: "reject",
  });
  await service.importTrackFromOpenSpec({
    source: { kind: "file", path: path.join(rootDir, "imports", "beta") },
    conflictPolicy: "resolve",
    resolutionPreset: "policyDefaults",
  });

  const importPage = await service.listOpenSpecImportHistoryPage({ page: 1, pageSize: 1 });
  assert.equal(importPage.items.length, 1);
  assert.ok([path.join(rootDir, "imports", "alpha"), path.join(rootDir, "imports", "beta")].includes(importPage.items[0]?.provenance.source.path ?? ""));
  assert.deepEqual(importPage.meta, {
    total: 2,
    totalPages: 2,
    hasNextPage: true,
    hasPrevPage: false,
  });

  const filteredImports = await service.listOpenSpecImportHistoryPage({
    sourcePath: "beta",
    conflictPolicy: "resolve",
    importedAfter: "2026-04-10T03:30:00.000Z",
    page: 1,
    pageSize: 5,
  });
  assert.equal(filteredImports.items.length, 1);
  assert.equal(filteredImports.items[0]?.provenance.source.path, path.join(rootDir, "imports", "beta"));
  assert.equal(filteredImports.meta.total, 1);

  const exportPage = await service.listOpenSpecExportHistoryPage({ page: 2, pageSize: 1 });
  assert.equal(exportPage.items.length, 1);
  assert.equal(exportPage.items[0]?.exportRecord.target.path, path.join(rootDir, "bundle-a"));
  assert.deepEqual(exportPage.meta, {
    total: 2,
    totalPages: 2,
    hasNextPage: false,
    hasPrevPage: true,
  });

  const filteredExports = await service.listOpenSpecExportHistoryPage({
    targetPath: "bundle-b",
    overwrite: true,
    exportedAfter: "2026-04-10T01:30:00.000Z",
    page: 1,
    pageSize: 5,
  });
  assert.equal(filteredExports.items.length, 1);
  assert.equal(filteredExports.items[0]?.trackId, exportTrackB.id);
  assert.equal(filteredExports.meta.total, 1);
});
