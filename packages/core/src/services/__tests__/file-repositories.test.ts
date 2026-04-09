import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Execution, ExecutionEvent, Project, Track } from "../../domain/types.js";
import {
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
    githubIssue: { number: 28, url: "https://github.com/yoophi-a/specrail/issues/28" },
    githubPullRequest: { number: 29, url: "https://github.com/yoophi-a/specrail/pull/29" },
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

  await trackRepository.update({ ...track, status: "in_progress", updatedAt: "2026-04-09T00:10:00.000Z" });
  await executionRepository.update({ ...execution, status: "running", startedAt: "2026-04-09T00:11:00.000Z" });

  assert.deepEqual(await projectRepository.getById(project.id), project);
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
