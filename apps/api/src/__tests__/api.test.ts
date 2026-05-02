import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultServer } from "../index.js";

async function withServer(
  run: (baseUrl: string, paths: { dataDir: string; repoArtifactDir: string }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "specrail-api-"));
  const repoArtifactDir = path.join(dataDir, "repo-visible");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDataDir = process.env.SPECRAIL_DATA_DIR;
  const previousPort = process.env.SPECRAIL_PORT;
  const previousRepoArtifactDir = process.env.SPECRAIL_REPO_ARTIFACT_DIR;
  const previousPath = process.env.PATH;

  process.env.NODE_ENV = "test";
  process.env.SPECRAIL_DATA_DIR = dataDir;
  process.env.SPECRAIL_REPO_ARTIFACT_DIR = repoArtifactDir;
  process.env.SPECRAIL_PORT = "0";

  const fakeBinDir = path.join(dataDir, "bin");
  const fakeCodexPath = path.join(fakeBinDir, "codex");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
console.log(JSON.stringify({ session_id: "fake-codex-" + process.pid }));
setTimeout(() => process.exit(0), 25);
`,
    "utf8",
  );
  await chmod(fakeCodexPath, 0o755);
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath ?? ""}`;

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
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closePromise;
    process.env.NODE_ENV = previousNodeEnv;
    process.env.SPECRAIL_DATA_DIR = previousDataDir;
    process.env.SPECRAIL_PORT = previousPort;
    process.env.SPECRAIL_REPO_ARTIFACT_DIR = previousRepoArtifactDir;
    process.env.PATH = previousPath;
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

test("API supports creating tracks, planning sessions, messages, starting runs, and listing run events", async () => {
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
    const trackPayload = (await trackResponse.json()) as { track: { id: string; title: string; planningSystem: string } };
    assert.equal(trackPayload.track.title, "Executor MVP");

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    assert.equal(getTrackResponse.status, 200);
    const getTrackPayload = (await getTrackResponse.json()) as {
      track: { id: string };
      artifacts: { spec: string; plan: string; tasks: string };
      planningContext: { hasPendingChanges: boolean };
    };
    assert.equal(getTrackPayload.track.id, trackPayload.track.id);
    assert.match(getTrackPayload.artifacts.spec, /# Spec — Executor MVP/);
    assert.match(getTrackPayload.artifacts.plan, /# Plan/);
    assert.match(getTrackPayload.artifacts.tasks, /# Tasks — Executor MVP/);
    assert.equal(getTrackPayload.planningContext.hasPendingChanges, false);

    const repoVisibleSync = JSON.parse(
      await readFile(path.join(paths.repoArtifactDir, "tracks", trackPayload.track.id, "sync.json"), "utf8"),
    ) as { trackId: string; source: { runtimeDataRoot: string } };
    assert.equal(repoVisibleSync.trackId, trackPayload.track.id);
    assert.equal(repoVisibleSync.source.runtimeDataRoot, "../artifacts");
    assert.equal(trackPayload.track.planningSystem, "native");

    const planningSessionResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/planning-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(planningSessionResponse.status, 201);
    const planningSessionPayload = (await planningSessionResponse.json()) as {
      planningSession: { id: string; trackId: string; status: string };
    };
    assert.equal(planningSessionPayload.planningSession.trackId, trackPayload.track.id);

    const planningMessageResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorType: "user",
        kind: "question",
        relatedArtifact: "plan",
        body: "Can we separate planning state from run events?",
      }),
    });
    assert.equal(planningMessageResponse.status, 201);

    const planningMessagesResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}/messages`);
    assert.equal(planningMessagesResponse.status, 200);
    const planningMessagesPayload = (await planningMessagesResponse.json()) as {
      messages: Array<{ body: string }>;
    };
    assert.equal(planningMessagesPayload.messages.length, 1);
    assert.equal(planningMessagesPayload.messages[0]?.body, "Can we separate planning state from run events?");

    const bindResponse = await fetch(`${baseUrl}/channel-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-default",
        channelType: "telegram",
        externalChatId: "chat-1",
        externalThreadId: "thread-1",
        externalUserId: "user-1",
        trackId: trackPayload.track.id,
        planningSessionId: planningSessionPayload.planningSession.id,
      }),
    });
    assert.equal(bindResponse.status, 201);
    const bindPayload = (await bindResponse.json()) as { binding: { id: string; planningSessionId?: string } };
    assert.equal(bindPayload.binding.planningSessionId, planningSessionPayload.planningSession.id);

    const getBindingResponse = await fetch(
      `${baseUrl}/channel-bindings?channelType=telegram&externalChatId=chat-1&externalThreadId=thread-1`,
    );
    assert.equal(getBindingResponse.status, 200);
    const getBindingPayload = (await getBindingResponse.json()) as { binding: { id: string } };
    assert.equal(getBindingPayload.binding.id, bindPayload.binding.id);

    const attachmentResponse = await fetch(`${baseUrl}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "telegram",
        externalFileId: "file-1",
        fileName: "brief.txt",
        planningSessionId: planningSessionPayload.planningSession.id,
      }),
    });
    assert.equal(attachmentResponse.status, 201);

    const attachmentsResponse = await fetch(
      `${baseUrl}/attachments?planningSessionId=${planningSessionPayload.planningSession.id}`,
    );
    assert.equal(attachmentsResponse.status, 200);
    const attachmentsPayload = (await attachmentsResponse.json()) as { attachments: Array<{ externalFileId: string }> };
    assert.deepEqual(attachmentsPayload.attachments.map((attachment) => attachment.externalFileId), ["file-1"]);

    const proposedPlanRevisionResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "# Approved plan\n\nUse the linked planning context.",
        createdBy: "agent",
      }),
    });
    assert.equal(proposedPlanRevisionResponse.status, 201);
    const proposedPlanRevisionPayload = (await proposedPlanRevisionResponse.json()) as {
      revision: { id: string };
      approvalRequest: { id: string };
    };

    const approvePlanResponse = await fetch(
      `${baseUrl}/approval-requests/${proposedPlanRevisionPayload.approvalRequest.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decidedBy: "user", comment: "approved" }),
      },
    );
    assert.equal(approvePlanResponse.status, 200);

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Implement the issue",
        profile: "default",
        planningSessionId: planningSessionPayload.planningSession.id,
      }),
    });

    assert.equal(runResponse.status, 201);
    const runPayload = (await runResponse.json()) as {
      run: { id: string; sessionRef?: string; planningSessionId?: string; planRevisionId?: string; planningContextStale?: boolean };
    };
    assert.ok(runPayload.run.sessionRef);
    assert.equal(runPayload.run.planningSessionId, planningSessionPayload.planningSession.id);
    assert.equal(runPayload.run.planRevisionId, proposedPlanRevisionPayload.revision.id);
    assert.equal(runPayload.run.planningContextStale, false);

    const getRunResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}`);
    assert.equal(getRunResponse.status, 200);

    const eventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    assert.equal(eventsResponse.status, 200);
    const eventsPayload = (await eventsResponse.json()) as { events: Array<{ type: string; summary: string }> };
    assert.ok(eventsPayload.events.length >= 2);
    assert.equal(eventsPayload.events[0]?.summary, "Run started");
    assert.ok(eventsPayload.events.some((event) => event.type === "shell_command" && /Spawned Codex session/.test(event.summary)));
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
    assert.ok((cancelledPayload.run.summary?.eventCount ?? 0) >= 4);
    assert.equal(cancelledPayload.run.summary?.lastEventSummary, `Cancelled Codex session ${runPayload.run.id}-codex`);

    const eventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    const eventsPayload = (await eventsResponse.json()) as { events: Array<{ type: string; summary: string }> };
    assert.ok(eventsPayload.events.length >= 4);
    assert.equal(eventsPayload.events[0]?.summary, "Run started");
    assert.match(eventsPayload.events[1]?.summary ?? "", /Spawned Codex session/);
    assert.ok(eventsPayload.events.some((event) => /Resumed Codex session/.test(event.summary)));
    assert.ok(eventsPayload.events.some((event) => /Cancelled Codex session/.test(event.summary)));
  });
});

test("API blocks run start when planning revisions are still pending approval", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Blocked by pending plan",
        description: "Do not start until approval lands.",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const pendingPlanResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "# Plan waiting approval",
        createdBy: "agent",
      }),
    });
    assert.equal(pendingPlanResponse.status, 201);

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Start anyway",
      }),
    });

    assert.equal(runResponse.status, 422);
    const payload = (await runResponse.json()) as { error: { message: string } };
    assert.match(payload.error.message, /pending planning changes/);
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
      }),
    });
    const trackPayload = (await trackResponse.json()) as {
      track: { id: string; status: string; specStatus: string; planStatus: string; updatedAt: string };
    };

    const patchResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "review",
        specStatus: "approved",
        planStatus: "pending",
      }),
    });

    assert.equal(patchResponse.status, 200);
    const patchPayload = (await patchResponse.json()) as {
      track: { id: string; status: string; specStatus: string; planStatus: string; updatedAt: string };
    };
    assert.equal(patchPayload.track.id, trackPayload.track.id);
    assert.equal(patchPayload.track.status, "review");
    assert.equal(patchPayload.track.specStatus, "approved");
    assert.equal(patchPayload.track.planStatus, "pending");
    assert.notEqual(patchPayload.track.updatedAt, trackPayload.track.updatedAt);

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    const getTrackPayload = (await getTrackResponse.json()) as {
      track: { status: string; specStatus: string; planStatus: string };
    };
    assert.equal(getTrackPayload.track.status, "review");
    assert.equal(getTrackPayload.track.specStatus, "approved");
    assert.equal(getTrackPayload.track.planStatus, "pending");
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
      }),
    });
    assert.equal(invalidTrackResponse.status, 422);
    const invalidTrackPayload = (await invalidTrackResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidTrackPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidTrackPayload.error.details.map((detail) => detail.field),
      ["title", "description", "priority"],
    );

    const invalidRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: "",
        prompt: "",
        backend: "wat",
        profile: "",
      }),
    });
    assert.equal(invalidRunResponse.status, 422);
    const invalidRunPayload = (await invalidRunResponse.json()) as {
      error: { details: Array<{ field: string }> };
    };
    assert.deepEqual(
      invalidRunPayload.error.details.map((detail) => detail.field),
      ["trackId", "prompt", "backend", "profile"],
    );

    const invalidResumeResponse = await fetch(`${baseUrl}/runs/run-1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "", backend: "wat", profile: "" }),
    });
    assert.equal(invalidResumeResponse.status, 422);
    const invalidResumePayload = (await invalidResumeResponse.json()) as {
      error: { details: Array<{ field: string }> };
    };
    assert.deepEqual(
      invalidResumePayload.error.details.map((detail) => detail.field),
      ["prompt", "backend", "profile"],
    );

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

test("API supports proposing, approving, and rejecting artifact revisions", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Revision approvals",
        description: "Exercise artifact revision workflow.",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const rejectProposalResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "spec revision v1",
        summary: "first pass",
        createdBy: "agent",
      }),
    });
    assert.equal(rejectProposalResponse.status, 201);
    const rejectProposal = (await rejectProposalResponse.json()) as {
      revision: { version: number };
      approvalRequest: { id: string; status: string };
    };
    assert.equal(rejectProposal.revision.version, 1);
    assert.equal(rejectProposal.approvalRequest.status, "pending");

    const rejectResponse = await fetch(`${baseUrl}/approval-requests/${rejectProposal.approvalRequest.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user", comment: "Need more detail" }),
    });
    assert.equal(rejectResponse.status, 200);

    const pendingProposalResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "approved spec revision",
        summary: "second pass",
        createdBy: "agent",
      }),
    });
    const pendingProposal = (await pendingProposalResponse.json()) as {
      revision: { version: number };
      approvalRequest: { id: string };
    };
    assert.equal(pendingProposal.revision.version, 2);

    const approveResponse = await fetch(`${baseUrl}/approval-requests/${pendingProposal.approvalRequest.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user", comment: "Ship it" }),
    });
    assert.equal(approveResponse.status, 200);

    const artifactResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/spec`);
    assert.equal(artifactResponse.status, 200);
    const artifactPayload = (await artifactResponse.json()) as {
      revisions: Array<{ version: number; approvedAt?: string }>;
      approvalRequests: Array<{ status: string }>;
    };
    assert.deepEqual(artifactPayload.revisions.map((revision) => revision.version), [2, 1]);
    assert.ok(artifactPayload.revisions[0]?.approvedAt);
    assert.deepEqual(artifactPayload.approvalRequests.map((request) => request.status), ["approved", "rejected"]);

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    const getTrackPayload = (await getTrackResponse.json()) as {
      track: { specStatus: string };
      artifacts: { spec: string };
    };
    assert.equal(getTrackPayload.track.specStatus, "approved");
    assert.equal(getTrackPayload.artifacts.spec, "approved spec revision");
  });
});
