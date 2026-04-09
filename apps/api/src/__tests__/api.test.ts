import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileExecutionRepository,
  FileGitHubRunCommentSyncStore,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
  SpecRailService,
} from "@specrail/core";

import { createDefaultServer, createSpecRailHttpServer } from "../index.js";

async function withServer(
  run: (baseUrl: string, paths: { dataDir: string; repoArtifactDir: string }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "specrail-api-"));
  const repoArtifactDir = path.join(dataDir, "repo-visible");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDataDir = process.env.SPECRAIL_DATA_DIR;
  const previousPort = process.env.SPECRAIL_PORT;
  const previousRepoArtifactDir = process.env.SPECRAIL_REPO_ARTIFACT_DIR;

  process.env.NODE_ENV = "test";
  process.env.SPECRAIL_DATA_DIR = dataDir;
  process.env.SPECRAIL_REPO_ARTIFACT_DIR = repoArtifactDir;
  process.env.SPECRAIL_PORT = "0";

  const server = createDefaultServer();

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`, { dataDir, repoArtifactDir });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.env.NODE_ENV = previousNodeEnv;
    process.env.SPECRAIL_DATA_DIR = previousDataDir;
    process.env.SPECRAIL_PORT = previousPort;
    process.env.SPECRAIL_REPO_ARTIFACT_DIR = previousRepoArtifactDir;
  }
}

function parseSseEvents(buffer: string): Array<{ id: string; summary: string }> {
  return buffer
    .split("\n\n")
    .filter((chunk) => chunk.includes("data: "))
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")) ?? "")
    .map((line) => JSON.parse(line.slice("data: ".length)) as { id: string; summary: string });
}

async function openSseStream(url: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  waitForEvents: (expectedCount: number) => Promise<Array<{ id: string; summary: string }>>;
  close: () => void;
}> {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { headers: { accept: "text/event-stream" } },
      (response) => {
        response.setEncoding("utf8");
        let buffer = "";

        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          waitForEvents: async (expectedCount: number) => {
            if (parseSseEvents(buffer).length >= expectedCount) {
              return parseSseEvents(buffer);
            }

            return await new Promise((innerResolve, innerReject) => {
              const timeout = setTimeout(() => {
                cleanup();
                innerReject(new Error(`timed out waiting for ${expectedCount} SSE events`));
              }, 5000);

              const onData = (chunk: string): void => {
                buffer += chunk;
                const events = parseSseEvents(buffer);

                if (events.length >= expectedCount) {
                  cleanup();
                  innerResolve(events);
                }
              };

              const onError = (error: Error): void => {
                cleanup();
                innerReject(error);
              };

              const cleanup = (): void => {
                clearTimeout(timeout);
                response.off("data", onData);
                response.off("error", onError);
              };

              response.on("data", onData);
              response.on("error", onError);
            });
          },
          close: () => {
            response.destroy();
            request.destroy();
          },
        });
      },
    );

    request.on("error", reject);
  });
}

test("API retries failed GitHub run comment syncs from the integrations route", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "specrail-api-retry-"));
  const artifactRoot = path.join(dataDir, "repo-visible");
  const service = new SpecRailService({
    projectRepository: new FileProjectRepository(path.join(dataDir, "state")),
    trackRepository: new FileTrackRepository(path.join(dataDir, "state")),
    executionRepository: new FileExecutionRepository(path.join(dataDir, "state")),
    eventStore: new JsonlEventStore(path.join(dataDir, "state")),
    githubRunCommentSyncStore: new FileGitHubRunCommentSyncStore(path.join(dataDir, "state")),
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
        return [
          {
            action: input.syncState ? "updated" : "created",
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
    workspaceRoot: path.join(dataDir, "workspaces"),
    now: (() => {
      const values = [
        "2026-04-10T03:00:00.000Z",
        "2026-04-10T03:00:01.000Z",
        "2026-04-10T03:00:02.000Z",
        "2026-04-10T03:00:03.000Z",
      ];
      return () => values.shift() ?? "2026-04-10T03:00:03.000Z";
    })(),
    idGenerator: (() => {
      const values = ["track-retry-route", "run-retry-route"];
      return () => values.shift() ?? "extra";
    })(),
  });

  const server = createSpecRailHttpServer({
    artifactRoot,
    eventLogDir: path.join(dataDir, "state", "events"),
    service,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind retry test server");
  }

  try {
    const track = await service.createTrack({
      title: "Retry integration sync",
      description: "Retry failed GitHub comment syncs.",
      githubIssue: { number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
    });
    const run = await service.startRun({ trackId: track.id, prompt: "retry failed sync" });

    await writeFile(
      path.join(dataDir, "state", "github-run-comment-sync", `${track.id}.json`),
      `${JSON.stringify(
        {
          id: track.id,
          trackId: track.id,
          updatedAt: "2026-04-10T03:00:02.000Z",
          comments: [
            {
              target: { kind: "issue", number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
              commentId: 3401,
              lastRunId: run.id,
              lastRunStatus: run.status,
              lastPublishedAt: "2026-04-10T03:00:02.000Z",
              lastCommentBody: "summary:running",
              lastSyncStatus: "failed",
              lastSyncError: "GitHub temporarily unavailable",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const retryResponse = await fetch(
      `http://127.0.0.1:${address.port}/tracks/${track.id}/integrations/github/run-comment-sync/retry`,
      { method: "POST" },
    );
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), {
      trackId: track.id,
      runId: run.id,
      results: [
        {
          action: "updated",
          target: { kind: "issue", number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
          body: "summary:running",
          commentId: 3401,
        },
      ],
      integrations: {
        trackId: track.id,
        github: {
          issue: { number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
          runCommentSync: {
            id: track.id,
            trackId: track.id,
            updatedAt: "2026-04-10T03:00:03.000Z",
            comments: [
              {
                target: { kind: "issue", number: 34, url: "https://github.com/yoophi-a/specrail/issues/34" },
                commentId: 3401,
                lastRunId: run.id,
                lastRunStatus: "running",
                lastPublishedAt: "2026-04-10T03:00:03.000Z",
                lastCommentBody: "summary:running",
                lastSyncStatus: "success",
              },
            ],
          },
          summary: {
            linkedTargetCount: 1,
            syncedTargetCount: 1,
            lastPublishedAt: "2026-04-10T03:00:03.000Z",
            lastSyncStatus: "success",
          },
        },
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("API exposes GitHub sync metadata on track and run inspection routes", async () => {
  await withServer(async (baseUrl, paths) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Sync inspection",
        description: "Expose persisted GitHub sync state.",
        githubIssue: {
          number: 32,
          url: "https://github.com/yoophi-a/specrail/issues/32",
        },
      }),
    });
    assert.equal(trackResponse.status, 201);
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const emptyIntegrationsResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/integrations`);
    assert.equal(emptyIntegrationsResponse.status, 200);
    assert.deepEqual(await emptyIntegrationsResponse.json(), {
      trackId: trackPayload.track.id,
      github: {
        issue: {
          number: 32,
          url: "https://github.com/yoophi-a/specrail/issues/32",
        },
        runCommentSync: null,
        summary: {
          linkedTargetCount: 1,
          syncedTargetCount: 0,
        },
      },
    });

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Inspect sync metadata",
      }),
    });
    assert.equal(runResponse.status, 201);
    const runPayload = (await runResponse.json()) as { run: { id: string } };

    const syncFilePath = path.join(paths.dataDir, "state", "github-run-comment-sync", `${trackPayload.track.id}.json`);
    await mkdir(path.dirname(syncFilePath), { recursive: true });
    await writeFile(
      syncFilePath,
      `${JSON.stringify(
        {
          id: trackPayload.track.id,
          trackId: trackPayload.track.id,
          updatedAt: "2026-04-10T03:00:00.000Z",
          comments: [
            {
              target: {
                kind: "issue",
                number: 32,
                url: "https://github.com/yoophi-a/specrail/issues/32",
              },
              commentId: 3201,
              lastRunId: runPayload.run.id,
              lastRunStatus: "running",
              lastPublishedAt: "2026-04-10T02:59:30.000Z",
              lastSyncStatus: "failed",
              lastSyncError: "GitHub temporarily unavailable",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const integrationsResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/integrations`);
    assert.equal(integrationsResponse.status, 200);
    assert.deepEqual(await integrationsResponse.json(), {
      trackId: trackPayload.track.id,
      github: {
        issue: {
          number: 32,
          url: "https://github.com/yoophi-a/specrail/issues/32",
        },
        runCommentSync: {
          id: trackPayload.track.id,
          trackId: trackPayload.track.id,
          updatedAt: "2026-04-10T03:00:00.000Z",
          comments: [
            {
              target: {
                kind: "issue",
                number: 32,
                url: "https://github.com/yoophi-a/specrail/issues/32",
              },
              commentId: 3201,
              lastRunId: runPayload.run.id,
              lastRunStatus: "running",
              lastPublishedAt: "2026-04-10T02:59:30.000Z",
              lastSyncStatus: "failed",
              lastSyncError: "GitHub temporarily unavailable",
            },
          ],
        },
        summary: {
          linkedTargetCount: 1,
          syncedTargetCount: 1,
          lastPublishedAt: "2026-04-10T02:59:30.000Z",
          lastSyncStatus: "failed",
          lastSyncError: "GitHub temporarily unavailable",
        },
      },
    });

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    assert.equal(getTrackResponse.status, 200);
    const getTrackPayload = (await getTrackResponse.json()) as {
      githubRunCommentSync: {
        updatedAt: string;
        comments: Array<{
          commentId?: number;
          lastRunId: string;
          lastRunStatus: string;
          lastPublishedAt: string;
          lastSyncStatus: string;
          lastSyncError?: string;
        }>;
      } | null;
    };
    assert.equal(getTrackPayload.githubRunCommentSync?.updatedAt, "2026-04-10T03:00:00.000Z");
    assert.deepEqual(getTrackPayload.githubRunCommentSync?.comments[0], {
      target: {
        kind: "issue",
        number: 32,
        url: "https://github.com/yoophi-a/specrail/issues/32",
      },
      commentId: 3201,
      lastRunId: runPayload.run.id,
      lastRunStatus: "running",
      lastPublishedAt: "2026-04-10T02:59:30.000Z",
      lastSyncStatus: "failed",
      lastSyncError: "GitHub temporarily unavailable",
    });

    const getRunResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}`);
    assert.equal(getRunResponse.status, 200);
    const getRunPayload = (await getRunResponse.json()) as {
      githubRunCommentSync: { comments: Array<{ commentId?: number; lastRunId: string }> } | null;
      githubRunCommentSyncForRun: Array<{ commentId?: number; lastRunId: string }>;
    };
    assert.equal(getRunPayload.githubRunCommentSync?.comments[0]?.commentId, 3201);
    assert.deepEqual(getRunPayload.githubRunCommentSyncForRun, [
      {
        target: {
          kind: "issue",
          number: 32,
          url: "https://github.com/yoophi-a/specrail/issues/32",
        },
        commentId: 3201,
        lastRunId: runPayload.run.id,
        lastRunStatus: "running",
        lastPublishedAt: "2026-04-10T02:59:30.000Z",
        lastSyncStatus: "failed",
        lastSyncError: "GitHub temporarily unavailable",
      },
    ]);
  });
});

test("API supports creating tracks, starting runs, and listing run events", async () => {
  await withServer(async (baseUrl, paths) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Executor MVP",
        description: "Persist command metadata and launch runs.",
        priority: "high",
      }),
    });

    assert.equal(trackResponse.status, 201);
    const trackPayload = (await trackResponse.json()) as { track: { id: string; title: string } };
    assert.equal(trackPayload.track.title, "Executor MVP");

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    assert.equal(getTrackResponse.status, 200);
    const getTrackPayload = (await getTrackResponse.json()) as {
      track: { id: string };
      artifacts: { spec: string; plan: string; tasks: string };
    };
    assert.equal(getTrackPayload.track.id, trackPayload.track.id);
    assert.match(getTrackPayload.artifacts.spec, /# Spec — Executor MVP/);
    assert.match(getTrackPayload.artifacts.plan, /# Plan/);
    assert.match(getTrackPayload.artifacts.tasks, /# Tasks — Executor MVP/);

    const repoVisibleSync = JSON.parse(
      await readFile(path.join(paths.repoArtifactDir, "tracks", trackPayload.track.id, "sync.json"), "utf8"),
    ) as { trackId: string; source: { runtimeDataRoot: string } };
    assert.equal(repoVisibleSync.trackId, trackPayload.track.id);
    assert.equal(repoVisibleSync.source.runtimeDataRoot, "../artifacts");

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Implement the issue",
        profile: "default",
      }),
    });

    assert.equal(runResponse.status, 201);
    const runPayload = (await runResponse.json()) as { run: { id: string; sessionRef?: string } };
    assert.ok(runPayload.run.sessionRef);

    const getRunResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}`);
    assert.equal(getRunResponse.status, 200);

    const eventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    assert.equal(eventsResponse.status, 200);
    const eventsPayload = (await eventsResponse.json()) as { events: Array<{ type: string }> };
    assert.equal(eventsPayload.events.length, 2);
    assert.deepEqual(
      eventsPayload.events.map((event) => event.type),
      ["task_status_changed", "shell_command"],
    );
  });
});

test("API exports and imports OpenSpec bundles through admin routes", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "OpenSpec track",
        description: "Export and re-import OpenSpec bundles.",
      }),
    });
    assert.equal(trackResponse.status, 201);
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const bundleDir = await mkdtemp(path.join(os.tmpdir(), "specrail-api-openspec-bundle-"));
    const exportResponse = await fetch(`${baseUrl}/admin/openspec/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        path: bundleDir,
        overwrite: true,
      }),
    });
    assert.equal(exportResponse.status, 200);

    const exported = (await exportResponse.json()) as {
      package: { track: { id: string } };
      target: { path: string; overwrite: boolean };
    };
    assert.equal(exported.package.track.id, trackPayload.track.id);
    assert.equal(exported.target.path, bundleDir);
    assert.equal(exported.target.overwrite, true);

    const manifest = JSON.parse(await readFile(path.join(bundleDir, "openspec.json"), "utf8")) as {
      track: { id: string };
    };
    assert.equal(manifest.track.id, trackPayload.track.id);

    await writeFile(path.join(bundleDir, "spec.md"), "# Imported spec\n", "utf8");

    const importResponse = await fetch(`${baseUrl}/admin/openspec/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: bundleDir }),
    });
    assert.equal(importResponse.status, 200);

    const imported = (await importResponse.json()) as { action: string; track: { id: string } };
    assert.equal(imported.action, "updated");
    assert.equal(imported.track.id, trackPayload.track.id);

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    const getTrackPayload = (await getTrackResponse.json()) as { artifacts: { spec: string } };
    assert.equal(getTrackPayload.artifacts.spec, "# Imported spec\n");
  });
});

test("API supports streaming run events over SSE", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "SSE run",
        description: "Exercise stream route.",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const createRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Start the work",
      }),
    });
    const runPayload = (await createRunResponse.json()) as { run: { id: string } };

    const stream = await openSseStream(`${baseUrl}/runs/${runPayload.run.id}/events/stream`);
    assert.equal(stream.statusCode, 200);
    assert.match(String(stream.headers["content-type"] ?? ""), /text\/event-stream/);

    const initialEvents = await stream.waitForEvents(2);
    assert.equal(initialEvents.length, 2);
    assert.equal(initialEvents[0]?.summary, "Run started");
    assert.match(initialEvents[1]?.summary ?? "", /Spawned Codex session/);

    const resumeResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue with verification" }),
    });
    assert.equal(resumeResponse.status, 200);

    const resumedEvents = await stream.waitForEvents(3);
    assert.equal(resumedEvents.length, 3);
    assert.match(resumedEvents[2]?.summary ?? "", /Resumed Codex session/);

    const cancelResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);

    const cancelledEvents = await stream.waitForEvents(4);
    assert.equal(cancelledEvents.length, 4);
    assert.match(cancelledEvents[3]?.summary ?? "", /Cancelled Codex session/);
    stream.close();
  });
});

test("API supports resuming and cancelling a run", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Resume executor run",
        description: "Exercise resume and cancel routes.",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const createRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Start the work",
      }),
    });
    const runPayload = (await createRunResponse.json()) as { run: { id: string; status: string } };

    const resumeResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue with verification" }),
    });

    assert.equal(resumeResponse.status, 200);
    const resumedPayload = (await resumeResponse.json()) as {
      run: {
        id: string;
        status: string;
        command?: { prompt?: string; resumeSessionRef?: string };
        summary?: { eventCount: number; lastEventSummary?: string };
      };
    };
    assert.equal(resumedPayload.run.id, runPayload.run.id);
    assert.equal(resumedPayload.run.status, "running");
    assert.equal(resumedPayload.run.command?.prompt, "Continue with verification");
    assert.ok(resumedPayload.run.command?.resumeSessionRef);
    assert.equal(resumedPayload.run.summary?.eventCount, 3);
    assert.match(resumedPayload.run.summary?.lastEventSummary ?? "", /Resumed Codex session/);

    const cancelResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/cancel`, {
      method: "POST",
    });

    assert.equal(cancelResponse.status, 200);
    const cancelledPayload = (await cancelResponse.json()) as {
      run: {
        status: string;
        finishedAt?: string;
        summary?: { eventCount: number; lastEventSummary?: string; lastEventAt?: string };
      };
    };
    assert.equal(cancelledPayload.run.status, "cancelled");
    assert.ok(cancelledPayload.run.finishedAt);
    assert.equal(cancelledPayload.run.summary?.eventCount, 4);
    assert.equal(cancelledPayload.run.summary?.lastEventSummary, `Cancelled Codex session ${runPayload.run.id}-codex`);

    const eventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    const eventsPayload = (await eventsResponse.json()) as { events: Array<{ type: string; summary: string }> };
    assert.equal(eventsPayload.events.length, 4);
    assert.equal(eventsPayload.events[0]?.summary, "Run started");
    assert.match(eventsPayload.events[1]?.summary ?? "", /Spawned Codex session/);
    assert.match(eventsPayload.events[2]?.summary ?? "", /Resumed Codex session/);
    assert.match(eventsPayload.events[3]?.summary ?? "", /Cancelled Codex session/);
  });
});

test("API supports updating track workflow and approval state", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Approval workflow",
        description: "Exercise PATCH /tracks/:trackId.",
        githubIssue: {
          number: 28,
          url: "https://github.com/yoophi-a/specrail/issues/28",
        },
      }),
    });
    const trackPayload = (await trackResponse.json()) as {
      track: {
        id: string;
        status: string;
        specStatus: string;
        planStatus: string;
        updatedAt: string;
        githubIssue?: { number: number; url: string };
      };
    };
    assert.deepEqual(trackPayload.track.githubIssue, {
      number: 28,
      url: "https://github.com/yoophi-a/specrail/issues/28",
    });

    const patchResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "review",
        specStatus: "approved",
        planStatus: "pending",
        githubPullRequest: {
          number: 31,
          url: "https://github.com/yoophi-a/specrail/pull/31",
        },
      }),
    });

    assert.equal(patchResponse.status, 200);
    const patchPayload = (await patchResponse.json()) as {
      track: {
        id: string;
        status: string;
        specStatus: string;
        planStatus: string;
        updatedAt: string;
        githubIssue?: { number: number; url: string };
        githubPullRequest?: { number: number; url: string };
      };
    };
    assert.equal(patchPayload.track.id, trackPayload.track.id);
    assert.equal(patchPayload.track.status, "review");
    assert.equal(patchPayload.track.specStatus, "approved");
    assert.equal(patchPayload.track.planStatus, "pending");
    assert.deepEqual(patchPayload.track.githubIssue, {
      number: 28,
      url: "https://github.com/yoophi-a/specrail/issues/28",
    });
    assert.deepEqual(patchPayload.track.githubPullRequest, {
      number: 31,
      url: "https://github.com/yoophi-a/specrail/pull/31",
    });
    assert.notEqual(patchPayload.track.updatedAt, trackPayload.track.updatedAt);

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    const getTrackPayload = (await getTrackResponse.json()) as {
      track: {
        status: string;
        specStatus: string;
        planStatus: string;
        githubIssue?: { number: number; url: string };
        githubPullRequest?: { number: number; url: string };
      };
    };
    assert.equal(getTrackPayload.track.status, "review");
    assert.equal(getTrackPayload.track.specStatus, "approved");
    assert.equal(getTrackPayload.track.planStatus, "pending");
    assert.deepEqual(getTrackPayload.track.githubIssue, {
      number: 28,
      url: "https://github.com/yoophi-a/specrail/issues/28",
    });
    assert.deepEqual(getTrackPayload.track.githubPullRequest, {
      number: 31,
      url: "https://github.com/yoophi-a/specrail/pull/31",
    });
  });
});

test("API lists tracks and runs with basic filters", async () => {
  await withServer(async (baseUrl) => {
    const trackOneResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "First track",
        description: "Used for run listing",
        priority: "high",
      }),
    });
    const trackOne = (await trackOneResponse.json()) as { track: { id: string } };

    const trackTwoResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Second track",
        description: "Used for completed run listing",
        priority: "low",
      }),
    });
    const trackTwo = (await trackTwoResponse.json()) as { track: { id: string } };

    await fetch(`${baseUrl}/tracks/${trackOne.track.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });

    const trackListResponse = await fetch(`${baseUrl}/tracks?priority=low`);
    assert.equal(trackListResponse.status, 200);
    const trackListPayload = (await trackListResponse.json()) as { tracks: Array<{ id: string; priority: string }> };
    assert.deepEqual(trackListPayload.tracks.map((track) => track.id), [trackTwo.track.id]);

    const trackStatusResponse = await fetch(`${baseUrl}/tracks?status=ready`);
    const trackStatusPayload = (await trackStatusResponse.json()) as { tracks: Array<{ id: string }> };
    assert.deepEqual(trackStatusPayload.tracks.map((track) => track.id), [trackOne.track.id]);

    const runOneResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackOne.track.id,
        prompt: "Start first run",
      }),
    });
    const runOne = (await runOneResponse.json()) as { run: { id: string } };

    const runTwoResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackTwo.track.id,
        prompt: "Start second run",
      }),
    });
    const runTwo = (await runTwoResponse.json()) as { run: { id: string } };

    const cancelRunTwoResponse = await fetch(`${baseUrl}/runs/${runTwo.run.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelRunTwoResponse.status, 200);

    const runListResponse = await fetch(`${baseUrl}/runs?trackId=${trackOne.track.id}`);
    assert.equal(runListResponse.status, 200);
    const runListPayload = (await runListResponse.json()) as { runs: Array<{ id: string; trackId: string }> };
    assert.deepEqual(runListPayload.runs.map((run) => run.id), [runOne.run.id]);

    const cancelledRunListResponse = await fetch(`${baseUrl}/runs?status=cancelled`);
    const cancelledRunListPayload = (await cancelledRunListResponse.json()) as { runs: Array<{ id: string; status: string }> };
    assert.deepEqual(cancelledRunListPayload.runs.map((run) => run.id), [runTwo.run.id]);
  });
});

test("API paginates track listings and returns sort metadata", async () => {
  await withServer(async (baseUrl) => {
    const titles = ["Charlie", "Alpha", "Bravo"];

    for (const title of titles) {
      const response = await fetch(`${baseUrl}/tracks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: `${title} description`,
        }),
      });

      assert.equal(response.status, 201);
    }

    const listResponse = await fetch(`${baseUrl}/tracks?page=2&pageSize=1&sortBy=title&sortOrder=asc`);
    assert.equal(listResponse.status, 200);

    const listPayload = (await listResponse.json()) as {
      tracks: Array<{ title: string }>;
      meta: {
        page: number;
        pageSize: number;
        sortBy: string;
        sortOrder: string;
        total: number;
        totalPages: number;
        hasNextPage: boolean;
        hasPrevPage: boolean;
      };
    };

    assert.deepEqual(listPayload.tracks.map((track) => track.title), ["Bravo"]);
    assert.deepEqual(listPayload.meta, {
      page: 2,
      pageSize: 1,
      sortBy: "title",
      sortOrder: "asc",
      total: 3,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });
});

test("API paginates run listings with explicit sort order", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Run pagination track",
        description: "Exercise run pagination",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const runIds: string[] = [];
    for (const prompt of ["Run 1", "Run 2", "Run 3"]) {
      const runResponse = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackId: trackPayload.track.id,
          prompt,
        }),
      });

      assert.equal(runResponse.status, 201);
      const runPayload = (await runResponse.json()) as { run: { id: string } };
      runIds.push(runPayload.run.id);
    }

    const listResponse = await fetch(`${baseUrl}/runs?trackId=${trackPayload.track.id}&page=2&pageSize=1&sortBy=createdAt&sortOrder=asc`);
    assert.equal(listResponse.status, 200);

    const listPayload = (await listResponse.json()) as {
      runs: Array<{ id: string }>;
      meta: {
        page: number;
        pageSize: number;
        sortBy: string;
        sortOrder: string;
        total: number;
        totalPages: number;
        hasNextPage: boolean;
        hasPrevPage: boolean;
      };
    };

    assert.deepEqual(listPayload.runs.map((run) => run.id), [runIds[1]]);
    assert.deepEqual(listPayload.meta, {
      page: 2,
      pageSize: 1,
      sortBy: "createdAt",
      sortOrder: "asc",
      total: 3,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });
});

test("API validates track updates and returns 404 for missing tracks", async () => {
  await withServer(async (baseUrl) => {
    const missingTrackResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "review" }),
    });
    assert.equal(missingTrackResponse.status, 404);
    const missingTrackPayload = (await missingTrackResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingTrackPayload.error.code, "not_found");

    const emptyBodyResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(emptyBodyResponse.status, 422);

    const invalidStatusResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "oops" }),
    });
    assert.equal(invalidStatusResponse.status, 422);

    const invalidSpecStatusResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specStatus: "oops" }),
    });
    assert.equal(invalidSpecStatusResponse.status, 422);

    const invalidPlanStatusResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planStatus: "oops" }),
    });
    assert.equal(invalidPlanStatusResponse.status, 422);

    const invalidGitHubIssueResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubIssue: { number: 0, url: "https://example.com/not-github" } }),
    });
    assert.equal(invalidGitHubIssueResponse.status, 422);
  });
});

test("API returns structured validation and bad-request errors", async () => {
  await withServer(async (baseUrl) => {
    const invalidTrackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "",
        description: 123,
        priority: "urgent",
        githubPullRequest: { number: -1, url: "wat" },
      }),
    });
    assert.equal(invalidTrackResponse.status, 422);
    const invalidTrackPayload = (await invalidTrackResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidTrackPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidTrackPayload.error.details.map((detail) => detail.field),
      ["title", "description", "priority", "githubPullRequest.number", "githubPullRequest.url"],
    );

    const invalidRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: "",
        prompt: "",
        profile: "",
      }),
    });
    assert.equal(invalidRunResponse.status, 422);

    const invalidResumeResponse = await fetch(`${baseUrl}/runs/run-1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    assert.equal(invalidResumeResponse.status, 422);

    const invalidTrackListResponse = await fetch(`${baseUrl}/tracks?priority=urgent&status=wat`);
    assert.equal(invalidTrackListResponse.status, 422);

    const invalidTrackPaginationResponse = await fetch(`${baseUrl}/tracks?page=0&pageSize=101&sortBy=nope&sortOrder=sideways`);
    assert.equal(invalidTrackPaginationResponse.status, 422);

    const invalidRunListResponse = await fetch(`${baseUrl}/runs?trackId=&status=wat`);
    assert.equal(invalidRunListResponse.status, 422);

    const invalidRunPaginationResponse = await fetch(`${baseUrl}/runs?page=abc&pageSize=0&sortBy=nope&sortOrder=sideways`);
    assert.equal(invalidRunPaginationResponse.status, 422);

    const malformedJsonResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformedJsonResponse.status, 400);
    const malformedJsonPayload = (await malformedJsonResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(malformedJsonPayload.error.code, "bad_request");

    const invalidOpenSpecExportResponse = await fetch(`${baseUrl}/admin/openspec/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: "", path: 123, overwrite: "yes" }),
    });
    assert.equal(invalidOpenSpecExportResponse.status, 422);

    const invalidOpenSpecImportResponse = await fetch(`${baseUrl}/admin/openspec/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    assert.equal(invalidOpenSpecImportResponse.status, 422);
  });
});

test("API returns 404s for unknown tracks and runs", async () => {
  await withServer(async (baseUrl) => {
    const missingTrack = await fetch(`${baseUrl}/tracks/missing`);
    assert.equal(missingTrack.status, 404);
    const missingTrackPayload = (await missingTrack.json()) as { error: { code: string } };
    assert.equal(missingTrackPayload.error.code, "not_found");

    const missingRun = await fetch(`${baseUrl}/runs/missing/events`);
    assert.equal(missingRun.status, 404);
    const missingRunPayload = (await missingRun.json()) as { error: { code: string } };
    assert.equal(missingRunPayload.error.code, "not_found");

    const missingStream = await fetch(`${baseUrl}/runs/missing/events/stream`, {
      headers: { accept: "text/event-stream" },
    });
    assert.equal(missingStream.status, 404);
    const missingStreamPayload = (await missingStream.json()) as { error: { code: string } };
    assert.equal(missingStreamPayload.error.code, "not_found");

    const missingResume = await fetch(`${baseUrl}/runs/missing/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "nope" }),
    });
    assert.equal(missingResume.status, 404);
    const missingResumePayload = (await missingResume.json()) as { error: { code: string } };
    assert.equal(missingResumePayload.error.code, "not_found");

    const missingCancel = await fetch(`${baseUrl}/runs/missing/cancel`, {
      method: "POST",
    });
    assert.equal(missingCancel.status, 404);
    const missingCancelPayload = (await missingCancel.json()) as { error: { code: string } };
    assert.equal(missingCancelPayload.error.code, "not_found");
  });
});
