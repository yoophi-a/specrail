import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApprovalRequest, ArtifactRevision, Execution, ExecutionEvent, Project, Track } from "../../domain/types.js";
import {
  FileAttachmentReferenceRepository,
  FileApprovalRequestRepository,
  FileArtifactRevisionRepository,
  FileChannelBindingRepository,
  FileExecutionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
} from "../file-repositories.js";

test("file repositories persist and reload project/track/execution state", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-state-"));

  const projectRepository = new FileProjectRepository(rootDir);
  const trackRepository = new FileTrackRepository(rootDir);
  const executionRepository = new FileExecutionRepository(rootDir);

  const project: Project = {
    id: "project-1",
    name: "SpecRail",
    repoUrl: "https://github.com/yoophi-a/specrail",
    localRepoPath: "/tmp/specrail",
    defaultWorkflowPolicy: "default",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };

  const track: Track = {
    id: "track-1",
    projectId: project.id,
    title: "Persist run state",
    description: "Add file-backed repositories.",
    status: "planned",
    specStatus: "approved",
    planStatus: "approved",
    priority: "high",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  };

  const execution: Execution = {
    id: "execution-1",
    trackId: track.id,
    backend: "codex",
    profile: "default",
    workspacePath: "/tmp/specrail/worktrees/execution-1",
    branchName: "specrail/execution-1",
    sessionRef: "session-123",
    status: "created",
    createdAt: "2026-04-09T00:00:00.000Z",
  };

  await projectRepository.create(project);
  await trackRepository.create(track);
  await executionRepository.create(execution);

  await projectRepository.update({ ...project, name: "SpecRail Updated", updatedAt: "2026-04-09T00:09:00.000Z" });
  await trackRepository.update({ ...track, status: "in_progress", updatedAt: "2026-04-09T00:10:00.000Z" });
  await executionRepository.update({ ...execution, status: "running", startedAt: "2026-04-09T00:11:00.000Z" });

  assert.deepEqual(await projectRepository.getById(project.id), { ...project, name: "SpecRail Updated", updatedAt: "2026-04-09T00:09:00.000Z" });
  assert.deepEqual(await trackRepository.getById(track.id), {
    ...track,
    status: "in_progress",
    updatedAt: "2026-04-09T00:10:00.000Z",
  });
  assert.deepEqual(await executionRepository.getById(execution.id), {
    ...execution,
    status: "running",
    startedAt: "2026-04-09T00:11:00.000Z",
  });

  assert.deepEqual(await projectRepository.list(), [
    { ...project, name: "SpecRail Updated", updatedAt: "2026-04-09T00:09:00.000Z" },
  ]);
  assert.deepEqual(await trackRepository.list(), [
    {
      ...track,
      status: "in_progress",
      updatedAt: "2026-04-09T00:10:00.000Z",
    },
  ]);
  assert.deepEqual(await executionRepository.list(), [
    {
      ...execution,
      status: "running",
      startedAt: "2026-04-09T00:11:00.000Z",
    },
  ]);
});

test("jsonl event store appends and lists events in order", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-events-"));
  const eventStore = new JsonlEventStore(rootDir);

  const events: ExecutionEvent[] = [
    {
      id: "event-1",
      executionId: "execution-1",
      type: "task_status_changed",
      timestamp: "2026-04-09T00:00:00.000Z",
      source: "specrail",
      summary: "Execution created",
      payload: { status: "created" },
    },
    {
      id: "event-2",
      executionId: "execution-1",
      type: "message",
      timestamp: "2026-04-09T00:01:00.000Z",
      source: "codex",
      summary: "Execution started",
      payload: { text: "working" },
    },
  ];

  for (const event of events) {
    await eventStore.append(event);
  }

  assert.deepEqual(await eventStore.listByExecution("execution-1"), events);
  assert.deepEqual(await eventStore.listByExecution("missing-execution"), []);
});

test("artifact revision and approval request repositories persist and query by track", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-artifact-state-"));
  const revisionRepository = new FileArtifactRevisionRepository(rootDir);
  const approvalRequestRepository = new FileApprovalRequestRepository(rootDir);

  const revisionOne: ArtifactRevision = {
    id: "revision-1",
    trackId: "track-1",
    artifact: "spec",
    version: 1,
    content: "spec v1",
    createdAt: "2026-04-10T00:00:00.000Z",
    createdBy: "agent",
    approvalRequestId: "approval-1",
  };
  const revisionTwo: ArtifactRevision = {
    ...revisionOne,
    id: "revision-2",
    version: 2,
    content: "spec v2",
    createdAt: "2026-04-10T00:10:00.000Z",
    approvalRequestId: "approval-2",
  };
  const approvalOne: ApprovalRequest = {
    id: "approval-1",
    trackId: "track-1",
    artifact: "spec",
    revisionId: "revision-1",
    status: "rejected",
    requestedBy: "agent",
    requestedAt: "2026-04-10T00:00:00.000Z",
    decidedAt: "2026-04-10T00:05:00.000Z",
    decidedBy: "user",
  };
  const approvalTwo: ApprovalRequest = {
    ...approvalOne,
    id: "approval-2",
    revisionId: "revision-2",
    status: "pending",
    requestedAt: "2026-04-10T00:10:00.000Z",
    decidedAt: undefined,
    decidedBy: undefined,
  };

  await revisionRepository.create(revisionOne);
  await revisionRepository.create(revisionTwo);
  await approvalRequestRepository.create(approvalOne);
  await approvalRequestRepository.create(approvalTwo);

  assert.equal(await revisionRepository.getLatestVersion("track-1", "spec"), 2);
  assert.deepEqual(
    (await revisionRepository.listByTrack("track-1", "spec")).map((revision) => revision.id),
    ["revision-2", "revision-1"],
  );
  assert.deepEqual(
    (await approvalRequestRepository.listByTrack("track-1", "spec")).map((request) => request.id),
    ["approval-2", "approval-1"],
  );
});

test("channel binding and attachment repositories persist thin-frontend references", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-channel-state-"));
  const channelBindingRepository = new FileChannelBindingRepository(rootDir);
  const attachmentReferenceRepository = new FileAttachmentReferenceRepository(rootDir);

  await channelBindingRepository.create({
    id: "binding-1",
    projectId: "project-1",
    channelType: "telegram",
    externalChatId: "chat-1",
    externalThreadId: "thread-1",
    trackId: "track-1",
    planningSessionId: "planning-1",
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-10T10:00:00.000Z",
  });
  await attachmentReferenceRepository.create({
    id: "attachment-1",
    sourceType: "telegram",
    externalFileId: "file-1",
    fileName: "spec.pdf",
    mimeType: "application/pdf",
    trackId: "track-1",
    planningSessionId: "planning-1",
    uploadedAt: "2026-04-10T10:05:00.000Z",
  });

  assert.equal(
    (await channelBindingRepository.findByExternalRef({
      channelType: "telegram",
      externalChatId: "chat-1",
      externalThreadId: "thread-1",
    }))?.id,
    "binding-1",
  );

  await channelBindingRepository.create({
    id: "binding-github-1",
    projectId: "project-1",
    channelType: "github",
    externalChatId: "yoophi-a/specrail",
    externalThreadId: "123",
    externalUserId: "octocat",
    trackId: "track-1",
    createdAt: "2026-04-10T10:10:00.000Z",
    updatedAt: "2026-04-10T10:10:00.000Z",
  });
  assert.equal(
    (await channelBindingRepository.findByExternalRef({
      channelType: "github",
      externalChatId: "yoophi-a/specrail",
      externalThreadId: "123",
    }))?.id,
    "binding-github-1",
  );
  assert.deepEqual(
    (await attachmentReferenceRepository.listByTarget({ planningSessionId: "planning-1" })).map((attachment) => attachment.id),
    ["attachment-1"],
  );
});
