import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExecutionEvent } from "../../domain/types.js";
import {
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
  });

  assert.equal(track.id, "track-track-a");
  assert.equal(track.projectId, "project-default");

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
  });

  assert.equal(updated.status, "review");
  assert.equal(updated.specStatus, "approved");
  assert.equal(updated.planStatus, "pending");
  assert.equal(updated.updatedAt, "2026-04-09T04:05:00.000Z");

  const persisted = await service.getTrack(track.id);
  assert.deepEqual(persisted, updated);

  await assert.rejects(
    () => service.updateTrack({ trackId: "missing-track", status: "blocked" }),
    /Track not found/,
  );
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
