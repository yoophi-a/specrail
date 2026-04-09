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

  const resumedRun = await service.resumeRun({
    runId: run.id,
    prompt: "Continue with verification",
  });
  assert.equal(resumedRun.command?.resumeSessionRef, "session:run-run-a");
  assert.equal(resumedRun.command?.prompt, "Continue with verification");
  assert.equal(resumedRun.status, "running");

  const cancelledRun = await service.cancelRun({ runId: run.id });
  assert.equal(cancelledRun.status, "cancelled");
  assert.equal(cancelledRun.finishedAt, "2026-04-09T03:10:00.000Z");

  const persistedRun = await service.getRun(run.id);
  assert.deepEqual(persistedRun, cancelledRun);

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
