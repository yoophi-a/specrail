import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExecutionEvent } from "../../domain/types.js";
import {
  FileAttachmentReferenceRepository,
  FileApprovalRequestRepository,
  FileArtifactRevisionRepository,
  FileChannelBindingRepository,
  FileExecutionRepository,
  FilePlanningSessionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
  JsonlPlanningMessageStore,
} from "../file-repositories.js";
import { SpecRailService } from "../specrail-service.js";

test("SpecRailService creates tracks, artifacts, runs, and execution events", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-"));
  const artifactRoot = path.join(rootDir, ".specrail");
  const workspaceRoot = path.join(rootDir, "workspaces");
  const workspaceAllocations: Array<{ executionId: string; workspaceRoot: string; localRepoPath?: string }> = [];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    channelBindingRepository: new FileChannelBindingRepository(path.join(rootDir, "state")),
    attachmentReferenceRepository: new FileAttachmentReferenceRepository(path.join(rootDir, "state")),
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
      async writeApprovedArtifact(input) {
        const trackDir = path.join(artifactRoot, input.track.id);
        await mkdir(trackDir, { recursive: true });
        await writeFile(path.join(trackDir, `${input.artifact}.md`), input.content, "utf8");
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
    workspaceManager: {
      async allocate(input) {
        workspaceAllocations.push(input);
        return {
          workspacePath: path.join(input.workspaceRoot, input.executionId),
          branchName: `specrail/${input.executionId}`,
          mode: "directory",
        };
      },
    },
    now: (() => {
      const values = [
        "2026-04-09T03:00:00.000Z",
        "2026-04-09T03:00:00.000Z",
        "2026-04-09T03:01:00.000Z",
        "2026-04-09T03:02:00.000Z",
        "2026-04-09T03:10:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-09T03:10:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-a", "planning-a", "message-a", "run-a"];
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
  assert.equal(track.planningSystem, "native");

  const planningSession = await service.createPlanningSession({ trackId: track.id });
  assert.equal(planningSession.trackId, track.id);
  assert.equal(planningSession.status, "active");

  const planningMessage = await service.appendPlanningMessage({
    planningSessionId: planningSession.id,
    authorType: "user",
    kind: "question",
    body: "Please clarify the approval flow before execution.",
    relatedArtifact: "plan",
  });
  assert.equal(planningMessage.planningSessionId, planningSession.id);

  const planningMessages = await service.listPlanningMessages(planningSession.id);
  assert.equal(planningMessages.length, 1);
  assert.equal(planningMessages[0]?.body, "Please clarify the approval flow before execution.");

  const run = await service.startRun({
    trackId: track.id,
    prompt: "Ship the MVP",
    profile: "default",
  });

  assert.equal(run.id, "run-run-a");
  assert.equal(run.sessionRef, "session:run-run-a");
  assert.equal(run.workspacePath, path.join(workspaceRoot, "run-run-a"));
  assert.equal(run.branchName, "specrail/run-run-a");
  assert.deepEqual(workspaceAllocations, [{ executionId: "run-run-a", workspaceRoot, localRepoPath: undefined }]);
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
  assert.ok((resumedRun.summary?.eventCount ?? 0) >= (run.summary?.eventCount ?? 0) + 1);
  assert.equal(resumedRun.summary?.lastEventSummary, "Run resumed");
  assert.equal(resumedRun.summary?.lastEventAt, "2026-04-09T03:05:00.000Z");

  const cancelledRun = await service.cancelRun({ runId: run.id });
  assert.equal(cancelledRun.status, "cancelled");
  assert.equal(cancelledRun.finishedAt, "2026-04-09T03:10:00.000Z");
  assert.ok((cancelledRun.summary?.eventCount ?? 0) >= (resumedRun.summary?.eventCount ?? 0) + 1);
  assert.equal(cancelledRun.summary?.lastEventSummary, "Run cancelled");
  assert.equal(cancelledRun.summary?.lastEventAt, "2026-04-09T03:10:00.000Z");

  const persistedRun = await service.getRun(run.id);
  assert.deepEqual(persistedRun, cancelledRun);

  const blockedTrack = await service.getTrack(track.id);
  assert.equal(blockedTrack?.status, "blocked");
  assert.equal(blockedTrack?.updatedAt, "2026-04-09T03:10:00.000Z");

  const events = await service.listRunEvents(run.id);
  assert.ok(events.length >= 4);
  assert.deepEqual(events.slice(0, 2).map((event) => event.summary), ["Run started", "Prepared Codex command"]);
  assert.ok(events.some((event) => event.summary === "Run resumed"));
  assert.ok(events.some((event) => event.summary === "Run cancelled"));

  const binding = await service.bindChannel({
    projectId: "project-default",
    channelType: "telegram",
    externalChatId: "chat-1",
    externalThreadId: "thread-1",
    externalUserId: "user-1",
    trackId: track.id,
    planningSessionId: planningSession.id,
  });
  assert.equal(binding.trackId, track.id);

  const rebound = await service.bindChannel({
    projectId: "project-default",
    channelType: "telegram",
    externalChatId: "chat-1",
    externalThreadId: "thread-1",
    externalUserId: "user-2",
    planningSessionId: planningSession.id,
  });
  assert.equal(rebound.id, binding.id);
  assert.equal(rebound.externalUserId, "user-2");

  const attachment = await service.registerAttachmentReference({
    sourceType: "telegram",
    externalFileId: "file-1",
    fileName: "notes.txt",
    trackId: track.id,
    planningSessionId: planningSession.id,
  });
  assert.equal(attachment.externalFileId, "file-1");
  assert.deepEqual(
    (await service.listAttachmentReferences({ planningSessionId: planningSession.id })).map((item) => item.id),
    [attachment.id],
  );
});

test("SpecRailService throws when starting a run for a missing track", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-missing-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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

  await assert.rejects(() => service.createPlanningSession({ trackId: "missing-track" }), /Track not found/);
  await assert.rejects(
    () => service.appendPlanningMessage({ planningSessionId: "missing-session", authorType: "user", body: "hello" }),
    /Planning session not found/,
  );
  await assert.rejects(() => service.listPlanningMessages("missing-session"), /Planning session not found/);
  await assert.rejects(() => service.startRun({ trackId: "missing-track", prompt: "nope" }), /Track not found/);
  await assert.rejects(() => service.resumeRun({ runId: "missing-run", prompt: "nope" }), /Run not found/);
  await assert.rejects(() => service.cancelRun({ runId: "missing-run" }), /Run not found/);
});

test("SpecRailService routes run start and resume through the selected backend and profile", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-backends-"));
  const stateDir = path.join(rootDir, "state");
  const workspaceRoot = path.join(rootDir, "workspaces");
  const spawnCalls: Array<{ backend: string; profile: string }> = [];
  const resumeCalls: Array<{ backend: string; profile?: string }> = [];

  const createExecutor = (backend: string) => ({
    name: backend,
    async spawn(input: { executionId: string; prompt: string; workspacePath: string; profile: string }) {
      spawnCalls.push({ backend, profile: input.profile });
      return {
        sessionRef: `${backend}:${input.executionId}`,
        command: {
          command: backend,
          args: [input.prompt],
          cwd: input.workspacePath,
          prompt: input.prompt,
        },
        events: [
          {
            id: `${input.executionId}:${backend}:started`,
            executionId: input.executionId,
            type: "task_status_changed" as const,
            timestamp: "2026-04-10T11:00:00.000Z",
            source: backend,
            summary: `Run started (${backend})`,
            payload: { status: "running", backend, profile: input.profile },
          },
        ],
      };
    },
    async resume(input: { executionId?: string; sessionRef: string; prompt: string; workspacePath?: string; profile?: string }) {
      resumeCalls.push({ backend, profile: input.profile });
      return {
        sessionRef: input.sessionRef,
        command: {
          command: backend,
          args: [input.prompt],
          cwd: input.workspacePath ?? workspaceRoot,
          prompt: input.prompt,
          resumeSessionRef: input.sessionRef,
        },
        events: [
          {
            id: `${input.executionId}:${backend}:resumed`,
            executionId: input.executionId ?? "unknown",
            type: "task_status_changed" as const,
            timestamp: "2026-04-10T11:05:00.000Z",
            source: backend,
            summary: `Run resumed (${backend})`,
            payload: { status: "running", backend, profile: input.profile },
          },
        ],
      };
    },
    async cancel(input: { executionId?: string; sessionRef: string }) {
      return {
        id: `${input.executionId}:${backend}:cancelled`,
        executionId: input.executionId ?? "unknown",
        type: "task_status_changed" as const,
        timestamp: "2026-04-10T11:10:00.000Z",
        source: backend,
        summary: `Run cancelled (${backend})`,
        payload: { status: "cancelled", sessionRef: input.sessionRef },
      };
    },
  });

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(stateDir),
    trackRepository: new FileTrackRepository(stateDir),
    planningSessionRepository: new FilePlanningSessionRepository(stateDir),
    planningMessageStore: new JsonlPlanningMessageStore(stateDir),
    artifactRevisionRepository: new FileArtifactRevisionRepository(stateDir),
    approvalRequestRepository: new FileApprovalRequestRepository(stateDir),
    channelBindingRepository: new FileChannelBindingRepository(stateDir),
    attachmentReferenceRepository: new FileAttachmentReferenceRepository(stateDir),
    executionRepository: new FileExecutionRepository(stateDir),
    eventStore: new JsonlEventStore(stateDir),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
    executors: {
      codex: createExecutor("codex"),
      claude_code: createExecutor("claude_code"),
    },
    defaultExecutionBackend: "codex",
    defaultExecutionProfile: "default",
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot,
    now: (() => {
      const values = [
        "2026-04-10T11:00:00.000Z",
        "2026-04-10T11:00:00.000Z",
        "2026-04-10T11:05:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T11:05:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-a", "run-a"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Claude backend",
    description: "Verify backend routing.",
  });

  const run = await service.startRun({
    trackId: track.id,
    prompt: "Use Claude Code",
    backend: "claude_code",
    profile: "claude-sonnet-4",
  });

  assert.equal(run.backend, "claude_code");
  assert.equal(run.profile, "claude-sonnet-4");
  assert.deepEqual(spawnCalls, [{ backend: "claude_code", profile: "claude-sonnet-4" }]);

  const resumedRun = await service.resumeRun({
    runId: run.id,
    prompt: "Continue with Opus",
    backend: "claude_code",
    profile: "claude-opus-4-1",
  });

  assert.equal(resumedRun.backend, "claude_code");
  assert.equal(resumedRun.profile, "claude-opus-4-1");
  assert.deepEqual(resumeCalls, [{ backend: "claude_code", profile: "claude-opus-4-1" }]);

  await assert.rejects(
    () => service.resumeRun({ runId: run.id, prompt: "Switch backend", backend: "codex" }),
    /Run .* is backed by claude_code, not codex/,
  );
});


test("SpecRailService keeps run lifecycle summaries semantic instead of exact-count bound", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-lifecycle-contract-"));
  const stateDir = path.join(rootDir, "state");
  const workspaceRoot = path.join(rootDir, "workspaces");

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(stateDir),
    trackRepository: new FileTrackRepository(stateDir),
    planningSessionRepository: new FilePlanningSessionRepository(stateDir),
    planningMessageStore: new JsonlPlanningMessageStore(stateDir),
    artifactRevisionRepository: new FileArtifactRevisionRepository(stateDir),
    approvalRequestRepository: new FileApprovalRequestRepository(stateDir),
    channelBindingRepository: new FileChannelBindingRepository(stateDir),
    attachmentReferenceRepository: new FileAttachmentReferenceRepository(stateDir),
    executionRepository: new FileExecutionRepository(stateDir),
    eventStore: new JsonlEventStore(stateDir),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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
              type: "task_status_changed" as const,
              timestamp: "2026-05-03T01:00:00.000Z",
              source: "codex",
              summary: "Run started",
              payload: { status: "running" },
            },
            {
              id: `${input.executionId}:spawn-telemetry`,
              executionId: input.executionId,
              type: "summary" as const,
              timestamp: "2026-05-03T01:00:01.000Z",
              source: "codex",
              summary: "Spawn telemetry recorded",
              payload: { phase: "spawn" },
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
              executionId: input.executionId ?? "unknown",
              type: "task_status_changed" as const,
              timestamp: "2026-05-03T01:05:00.000Z",
              source: "codex",
              summary: "Run resumed",
              payload: { status: "running", sessionRef: input.sessionRef },
            },
            {
              id: `${input.executionId}:resume-telemetry`,
              executionId: input.executionId ?? "unknown",
              type: "summary" as const,
              timestamp: "2026-05-03T01:05:01.000Z",
              source: "codex",
              summary: "Resume telemetry recorded",
              payload: { phase: "resume" },
            },
          ],
        };
      },
      async cancel(input) {
        return {
          id: `${input.executionId}:cancelled`,
          executionId: input.executionId ?? "unknown",
          type: "task_status_changed" as const,
          timestamp: "2026-05-03T01:10:00.000Z",
          source: "codex",
          summary: "Run cancelled",
          payload: { status: "cancelled", sessionRef: input.sessionRef },
        };
      },
    },
    defaultProject: { id: "project-default", name: "SpecRail" },
    workspaceRoot,
    now: (() => {
      const values = [
        "2026-05-03T01:00:00.000Z",
        "2026-05-03T01:00:00.000Z",
        "2026-05-03T01:10:00.000Z",
      ];
      return () => values.shift() ?? "2026-05-03T01:10:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-a", "run-a"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Lifecycle contract",
    description: "Verify semantic run summary assertions.",
  });
  const run = await service.startRun({ trackId: track.id, prompt: "Start" });
  const startEventCount = run.summary?.eventCount ?? 0;

  const resumedRun = await service.resumeRun({ runId: run.id, prompt: "Continue" });
  assert.equal(resumedRun.id, run.id);
  assert.equal(resumedRun.status, "running");
  assert.equal(resumedRun.command?.prompt, "Continue");
  assert.equal(resumedRun.command?.resumeSessionRef, "session:run-run-a");
  assert.ok((resumedRun.summary?.eventCount ?? 0) >= startEventCount + 1);
  assert.equal(resumedRun.summary?.lastEventSummary, "Resume telemetry recorded");

  const resumedEventCount = resumedRun.summary?.eventCount ?? 0;
  const cancelledRun = await service.cancelRun({ runId: run.id });
  assert.equal(cancelledRun.status, "cancelled");
  assert.ok(cancelledRun.finishedAt);
  assert.ok((cancelledRun.summary?.eventCount ?? 0) >= resumedEventCount + 1);
  assert.equal(cancelledRun.summary?.lastEventSummary, "Run cancelled");

  const events = await service.listRunEvents(run.id);
  assert.ok(events.some((event) => event.summary === "Run resumed"));
  assert.ok(events.some((event) => event.summary === "Run cancelled"));
  assert.ok(events.some((event) => event.summary === "Resume telemetry recorded"));
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
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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
      planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, `state-${idSuffix}`)),
      planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, `state-${idSuffix}`)),
      artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, `state-${idSuffix}`)),
      approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, `state-${idSuffix}`)),
      executionRepository: new FileExecutionRepository(path.join(rootDir, `state-${idSuffix}`)),
      eventStore: new JsonlEventStore(path.join(rootDir, `state-${idSuffix}`)),
      artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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

test("SpecRailService trims persisted track fields and run prompts before execution", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-trim-"));
  const spawnCalls: Array<{ prompt: string; profile: string }> = [];
  const resumeCalls: Array<{ prompt: string; profile: string }> = [];

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    channelBindingRepository: new FileChannelBindingRepository(path.join(rootDir, "state")),
    attachmentReferenceRepository: new FileAttachmentReferenceRepository(path.join(rootDir, "state")),
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
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    channelBindingRepository: new FileChannelBindingRepository(path.join(rootDir, "state")),
    attachmentReferenceRepository: new FileAttachmentReferenceRepository(path.join(rootDir, "state")),
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
      const values = [
        "2026-04-09T06:00:00.000Z",
        "2026-04-09T06:00:01.000Z",
        "2026-04-09T06:00:02.000Z",
        "2026-04-09T06:00:03.000Z",
        "2026-04-09T06:00:04.000Z",
        "2026-04-09T06:00:05.000Z",
      ];
      return () => values.shift() ?? "2026-04-09T06:00:05.000Z";
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

  const resolution = await service.resolveRuntimeApprovalRequest({
    runId: run.id,
    requestId: `${run.id}:approval-requested`,
    outcome: "approved",
    decidedBy: "user",
    comment: "approved for test",
  });
  assert.equal(resolution.event.type, "approval_resolved");
  assert.equal(resolution.event.payload?.requestId, `${run.id}:approval-requested`);
  assert.equal(resolution.event.payload?.outcome, "approved");
  assert.equal(resolution.event.payload?.status, "running");
  assert.equal(resolution.callback.status, "unsupported");

  await assert.rejects(
    service.resolveRuntimeApprovalRequest({
      runId: run.id,
      requestId: `${run.id}:approval-requested`,
      outcome: "approved",
      decidedBy: "user",
    }),
    /already resolved/,
  );

  const resumedRun = await service.getRun(run.id);
  assert.equal(resumedRun?.status, "running");
  assert.equal(resumedRun?.startedAt, run.startedAt);
  assert.equal(resumedRun?.finishedAt, undefined);
  assert.deepEqual(resumedRun?.summary, {
    eventCount: 4,
    lastEventSummary: "Runtime approval callback is not supported by executor codex",
    lastEventAt: "2026-04-09T06:00:04.000Z",
  });

  const rejectedTrack = await service.createTrack({
    title: "Rejected approval run",
    description: "Reconcile rejected runtime approval from normalized events.",
  });
  const rejectedRun = await service.startRun({
    trackId: rejectedTrack.id,
    prompt: "Start the rejected gated work",
  });

  await service.recordExecutionEvent({
    id: `${rejectedRun.id}:approval-requested`,
    executionId: rejectedRun.id,
    type: "approval_requested",
    timestamp: "2026-04-09T06:00:04.000Z",
    source: "codex",
    summary: "Approval requested for risky command",
    payload: {
      toolName: "Bash",
      toolUseId: "toolu-rejected",
    },
  });

  const rejectedResolution = await service.resolveRuntimeApprovalRequest({
    runId: rejectedRun.id,
    requestId: `${rejectedRun.id}:approval-requested`,
    outcome: "rejected",
    decidedBy: "agent",
    comment: "too risky",
  });
  assert.equal(rejectedResolution.event.payload?.status, "cancelled");
  assert.equal(rejectedResolution.event.payload?.outcome, "rejected");
  assert.equal(rejectedResolution.event.payload?.toolName, "Bash");

  const cancelledRun = await service.getRun(rejectedRun.id);
  assert.equal(cancelledRun?.status, "cancelled");
  assert.equal(cancelledRun?.finishedAt, "2026-04-09T06:00:05.000Z");

  const blockedTrack = await service.getTrack(rejectedTrack.id);
  assert.equal(blockedTrack?.status, "blocked");
});

test("SpecRailService delivers runtime approval decisions to executor callbacks", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-approval-callback-"));
  const callbackCalls: Array<{ outcome: unknown; requestId: unknown; status: string }> = [];

  const makeExecutor = (name: string, fail = false) => ({
    name,
    async spawn(input: { executionId: string; prompt: string; workspacePath: string }) {
      return {
        sessionRef: `session:${input.executionId}`,
        command: {
          command: name,
          args: ["exec", input.prompt],
          cwd: input.workspacePath,
          prompt: input.prompt,
        },
        events: [
          {
            id: `${input.executionId}:started`,
            executionId: input.executionId,
            type: "task_status_changed" as const,
            timestamp: "2026-04-09T07:00:00.000Z",
            source: name,
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
    async resolveRuntimeApproval(input: {
      execution: { id: string; status: string };
      approvalResolvedEvent: ExecutionEvent;
    }) {
      callbackCalls.push({
        outcome: input.approvalResolvedEvent.payload?.outcome,
        requestId: input.approvalResolvedEvent.payload?.requestId,
        status: input.execution.status,
      });

      if (fail) {
        throw new Error("callback transport unavailable");
      }

      return [
        {
          id: `${input.execution.id}:approval-callback-delivered`,
          executionId: input.execution.id,
          type: "summary" as const,
          timestamp: "2026-04-09T07:00:05.000Z",
          source: "specrail",
          summary: "Runtime approval callback delivered to executor",
          payload: { outcome: input.approvalResolvedEvent.payload?.outcome },
        },
      ];
    },
  });

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    channelBindingRepository: new FileChannelBindingRepository(path.join(rootDir, "state")),
    attachmentReferenceRepository: new FileAttachmentReferenceRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
    executor: makeExecutor("callback_executor"),
    executors: {
      callback_executor: makeExecutor("callback_executor"),
      failing_executor: makeExecutor("failing_executor", true),
    },
    defaultExecutionBackend: "callback_executor",
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
    },
    workspaceRoot: path.join(rootDir, "workspaces"),
    now: (() => {
      const values = [
        "2026-04-09T07:00:00.000Z",
        "2026-04-09T07:00:01.000Z",
        "2026-04-09T07:00:02.000Z",
        "2026-04-09T07:00:03.000Z",
        "2026-04-09T07:00:04.000Z",
        "2026-04-09T07:00:05.000Z",
        "2026-04-09T07:00:06.000Z",
        "2026-04-09T07:00:07.000Z",
      ];
      return () => values.shift() ?? "2026-04-09T07:00:08.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-callback", "run-callback", "approval-callback", "track-failing", "run-failing", "approval-failing"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({ title: "Callback run", description: "approval callback" });
  const run = await service.startRun({ trackId: track.id, prompt: "Start callback run", backend: "callback_executor" });
  await service.recordExecutionEvent({
    id: `${run.id}:approval-requested`,
    executionId: run.id,
    type: "approval_requested",
    timestamp: "2026-04-09T07:00:02.000Z",
    source: "callback_executor",
    summary: "Approval requested",
    payload: { toolName: "Bash", toolUseId: "toolu-callback" },
  });

  const callbackResolution = await service.resolveRuntimeApprovalRequest({
    runId: run.id,
    requestId: `${run.id}:approval-requested`,
    outcome: "approved",
    decidedBy: "user",
  });
  assert.equal(callbackResolution.callback.status, "handled");

  const callbackEvents = await service.listRunEvents(run.id);
  assert.ok(callbackEvents.some((event) => event.summary === "Runtime approval callback delivered to executor"));
  assert.deepEqual(callbackCalls[0], {
    outcome: "approved",
    requestId: `${run.id}:approval-requested`,
    status: "running",
  });

  const failingTrack = await service.createTrack({ title: "Failing callback run", description: "approval callback failure" });
  const failingRun = await service.startRun({
    trackId: failingTrack.id,
    prompt: "Start failing callback run",
    backend: "failing_executor",
  });
  await service.recordExecutionEvent({
    id: `${failingRun.id}:approval-requested`,
    executionId: failingRun.id,
    type: "approval_requested",
    timestamp: "2026-04-09T07:00:06.000Z",
    source: "failing_executor",
    summary: "Approval requested",
    payload: { toolName: "Bash", toolUseId: "toolu-failing" },
  });

  const failingResolution = await service.resolveRuntimeApprovalRequest({
    runId: failingRun.id,
    requestId: `${failingRun.id}:approval-requested`,
    outcome: "approved",
    decidedBy: "system",
  });
  assert.equal(failingResolution.callback.status, "failed");
  assert.equal(failingResolution.callback.error, "callback transport unavailable");

  const failingEvents = await service.listRunEvents(failingRun.id);
  assert.ok(failingEvents.some((event) => event.summary === "Runtime approval callback delivery failed"));
  assert.equal((await service.getRun(failingRun.id))?.status, "running");
});

test("SpecRailService lists tracks and runs with basic filters", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-listing-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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
      const values = ["track-one", "track-two", "project-extra", "track-extra", "run-one", "run-two"];
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
  const extraProject = await service.createProject({ name: "Extra project", defaultPlanningSystem: "openspec" });
  const projectTrack = await service.createTrack({
    projectId: extraProject.id,
    title: "Project-specific track",
    description: "Track scoped to an explicit project",
  });

  assert.equal(projectTrack.projectId, extraProject.id);
  assert.equal(projectTrack.planningSystem, "openspec");

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
    [trackTwo.id, trackOne.id, projectTrack.id],
  );
  assert.deepEqual(
    (await service.listTracks({ priority: "low" })).map((track) => track.id),
    [trackTwo.id],
  );
  assert.deepEqual(
    (await service.listTracks({ projectId: extraProject.id })).map((track) => track.id),
    [projectTrack.id],
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

test("SpecRailService versions artifact revisions and applies approval transitions", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-revisions-"));
  const artifactRoot = path.join(rootDir, "artifacts");

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
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
      async writeApprovedArtifact(input) {
        const trackDir = path.join(artifactRoot, input.track.id);
        await mkdir(trackDir, { recursive: true });
        await writeFile(path.join(trackDir, `${input.artifact}.md`), input.content, "utf8");
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
      const values = [
        "2026-04-10T01:00:00.000Z",
        "2026-04-10T01:00:00.000Z",
        "2026-04-10T01:05:00.000Z",
        "2026-04-10T01:10:00.000Z",
        "2026-04-10T01:15:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T01:15:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-revision", "rev-1", "approval-1", "rev-2", "approval-2"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({
    title: "Revision workflow",
    description: "Track artifact revisions independently from approved current views.",
  });

  const proposedSpec = await service.proposeArtifactRevision({
    trackId: track.id,
    artifact: "spec",
    content: "# Spec revision v1\n\nApproved candidate.",
    summary: "Initial review draft",
    createdBy: "agent",
  });
  assert.equal(proposedSpec.revision.version, 1);
  assert.equal(proposedSpec.approvalRequest.status, "pending");

  const rejected = await service.rejectApprovalRequest({
    approvalRequestId: proposedSpec.approvalRequest.id,
    decidedBy: "user",
    comment: "Needs sharper scope.",
  });
  assert.equal(rejected.status, "rejected");

  const stillApprovedCurrent = await readFile(path.join(artifactRoot, track.id, "spec.md"), "utf8");
  assert.match(stillApprovedCurrent, /# Spec — Revision workflow/);

  const proposedSpecV2 = await service.proposeArtifactRevision({
    trackId: track.id,
    artifact: "spec",
    content: "# Spec revision v2\n\nApproved content.",
    summary: "Re-scoped draft",
    createdBy: "agent",
  });
  assert.equal(proposedSpecV2.revision.version, 2);

  const approved = await service.approveApprovalRequest({
    approvalRequestId: proposedSpecV2.approvalRequest.id,
    decidedBy: "user",
    comment: "Looks good.",
  });
  assert.equal(approved.status, "approved");

  const approvedCurrent = await readFile(path.join(artifactRoot, track.id, "spec.md"), "utf8");
  assert.equal(approvedCurrent, "# Spec revision v2\n\nApproved content.");

  const revisions = await service.listArtifactRevisions(track.id, "spec");
  assert.deepEqual(revisions.map((revision) => revision.version), [2, 1]);
  assert.equal(revisions[0]?.approvedAt, "2026-04-10T01:15:00.000Z");

  const approvalRequests = await service.listApprovalRequests(track.id, "spec");
  assert.deepEqual(approvalRequests.map((request) => request.status), ["approved", "rejected"]);

  const persistedTrack = await service.getTrack(track.id);
  assert.equal(persistedTrack?.specStatus, "approved");

  await assert.rejects(
    () => service.approveApprovalRequest({ approvalRequestId: proposedSpecV2.approvalRequest.id, decidedBy: "user" }),
    /already approved/,
  );
});

test("SpecRailService links runs to the latest approved planning context and detects stale context", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-planning-context-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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
              timestamp: "2026-04-10T02:10:00.000Z",
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
        "2026-04-10T02:00:00.000Z",
        "2026-04-10T02:00:00.000Z",
        "2026-04-10T02:01:00.000Z",
        "2026-04-10T02:02:00.000Z",
        "2026-04-10T02:03:00.000Z",
        "2026-04-10T02:04:00.000Z",
        "2026-04-10T02:05:00.000Z",
        "2026-04-10T02:06:00.000Z",
        "2026-04-10T02:07:00.000Z",
        "2026-04-10T02:08:00.000Z",
        "2026-04-10T02:09:00.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T02:09:00.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-ctx", "plan-session", "plan-rev-1", "plan-approval-1", "run-ctx", "plan-rev-2", "plan-approval-2"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({ title: "Planning-linked run", description: "Attach approved plan context" });
  const planningSession = await service.createPlanningSession({ trackId: track.id, status: "approved" });

  const planV1 = await service.proposeArtifactRevision({
    trackId: track.id,
    artifact: "plan",
    content: "# Plan v1",
    createdBy: "agent",
  });
  await service.approveApprovalRequest({ approvalRequestId: planV1.approvalRequest.id, decidedBy: "user" });

  const run = await service.startRun({ trackId: track.id, prompt: "Ship it", planningSessionId: planningSession.id });
  assert.equal(run.planningSessionId, planningSession.id);
  assert.equal(run.planRevisionId, planV1.revision.id);
  assert.equal(run.planningContextStale, false);

  const planV2 = await service.proposeArtifactRevision({
    trackId: track.id,
    artifact: "plan",
    content: "# Plan v2",
    createdBy: "agent",
  });
  await service.approveApprovalRequest({ approvalRequestId: planV2.approvalRequest.id, decidedBy: "user" });

  const staleRun = await service.getRun(run.id);
  assert.equal(staleRun?.planningContextStale, true);
  assert.equal(staleRun?.planningContextStaleReason, "Approved planning context changed for: plan");

  const planningContext = await service.getTrackPlanningContext(track.id);
  assert.equal(planningContext.planRevisionId, planV2.revision.id);
  assert.equal(planningContext.planningSessionId, planningSession.id);
});

test("SpecRailService blocks run start when planning revisions are pending approval", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-service-pending-planning-"));

  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(rootDir, "state")),
    trackRepository: new FileTrackRepository(path.join(rootDir, "state")),
    planningSessionRepository: new FilePlanningSessionRepository(path.join(rootDir, "state")),
    planningMessageStore: new JsonlPlanningMessageStore(path.join(rootDir, "state")),
    artifactRevisionRepository: new FileArtifactRevisionRepository(path.join(rootDir, "state")),
    approvalRequestRepository: new FileApprovalRequestRepository(path.join(rootDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(rootDir, "state")),
    eventStore: new JsonlEventStore(path.join(rootDir, "state")),
    artifactWriter: { async write() {}, async writeApprovedArtifact() {} },
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
    idGenerator: (() => {
      const values = ["track-pending", "plan-rev-1", "approval-1"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const track = await service.createTrack({ title: "Pending plan", description: "Do not run yet" });
  await service.proposeArtifactRevision({
    trackId: track.id,
    artifact: "plan",
    content: "# Plan candidate",
    createdBy: "agent",
  });

  await assert.rejects(() => service.startRun({ trackId: track.id, prompt: "Start anyway" }), /pending planning changes/);
});
