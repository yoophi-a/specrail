import assert from "node:assert/strict";
import http from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultServer, normalizeExecutionBackendValue, sanitizeMarkdownFilenameComponent } from "../index.js";

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
setTimeout(() => process.exit(0), 10_000);
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

async function assertJsonResponseStatus(response: Response, expectedStatus: number): Promise<void> {
  if (response.status === expectedStatus) {
    return;
  }

  const body = await response.text().catch((error) => `failed to read response body: ${error instanceof Error ? error.message : String(error)}`);
  assert.equal(response.status, expectedStatus, `expected HTTP ${expectedStatus}, received HTTP ${response.status}: ${body}`);
}

async function waitForRunEvent(
  baseUrl: string,
  runId: string,
  matches: (event: { type: string; summary: string }) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const eventsResponse = await fetch(`${baseUrl}/runs/${runId}/events`);
    assert.equal(eventsResponse.status, 200);
    const eventsPayload = (await eventsResponse.json()) as { events: Array<{ type: string; summary: string }> };

    if (eventsPayload.events.some(matches)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`timed out waiting for run event on ${runId}`);
}

async function readRunEventsText(baseUrl: string, runId: string): Promise<string> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const eventsResponse = await fetch(`${baseUrl}/runs/${runId}/events`);
    const body = await eventsResponse.text();

    if (eventsResponse.status === 200) {
      try {
        JSON.parse(body);
        return body;
      } catch {
        // The JSONL-backed event list can be read while the fake executor is
        // appending a line; retry until the endpoint returns a complete JSON
        // response before using it as the report mutation baseline.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`timed out reading stable run events for ${runId}`);
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
  waitForEvent: (matches: (event: { id: string; summary: string }) => boolean) => Promise<Array<{ id: string; summary: string }>>;
  close: () => void;
}> {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { headers: { accept: "text/event-stream" } },
      (response) => {
        response.setEncoding("utf8");
        let buffer = "";
        response.on("data", (chunk: string) => {
          buffer += chunk;
        });

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

              const onData = (): void => {
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
          waitForEvent: async (matches) => {
            if (parseSseEvents(buffer).some(matches)) {
              return parseSseEvents(buffer);
            }

            return await new Promise((innerResolve, innerReject) => {
              const timeout = setTimeout(() => {
                cleanup();
                innerReject(new Error("timed out waiting for matching SSE event"));
              }, 10000);

              const onData = (): void => {
                const events = parseSseEvents(buffer);

                if (events.some(matches)) {
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

test("sanitizeMarkdownFilenameComponent keeps report filenames filesystem-safe", () => {
  assert.equal(sanitizeMarkdownFilenameComponent("run-1"), "run-1");
  assert.equal(sanitizeMarkdownFilenameComponent("run/one with spaces"), "run-one-with-spaces");
  assert.equal(sanitizeMarkdownFilenameComponent("***"), "unknown");
});

test("normalizeExecutionBackendValue accepts env-manager friendly backend spellings", () => {
  assert.equal(normalizeExecutionBackendValue(" Claude-Code "), "claude_code");
  assert.equal(normalizeExecutionBackendValue(" CODEX "), "codex");
  assert.equal(normalizeExecutionBackendValue(" wat "), "wat");
  assert.equal(normalizeExecutionBackendValue(undefined), undefined);
});

test("API serves a health check", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "specrail-api" });
  });
});

test("API serves the hosted operator UI shell", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/operator`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /SpecRail Operator/);
    assert.match(body, /Project scope/);
    assert.match(body, /Create project/);
    assert.match(body, /Update selected project/);
    assert.match(body, /Create track/);
    assert.match(body, /Update track workflow/);
    assert.match(body, /track-workflow-status/);
    assert.match(body, /Create planning session/);
    assert.match(body, /Append planning message/);
    assert.match(body, /Spec preview/);
    assert.match(body, /Approval actions/);
    assert.match(body, /data-approval-id/);
    assert.match(body, /data-artifact-proposal/);
    assert.match(body, /id="artifact-proposal-kind"/);
    assert.match(body, /Propose artifact/);
    assert.match(body, /data-run-start/);
    assert.match(body, /run-start-prompt/);
    assert.match(body, /data-run-resume/);
    assert.match(body, /run-resume-prompt/);
    assert.match(body, /data-run-cancel/);
    assert.match(body, /run-cancel-confirmation/);
    assert.match(body, /Run report/);
    assert.match(body, /data-run-report/);
    assert.match(body, /report\.md/);
    assert.match(body, /download>↗ Open\/download Markdown run report/);
    assert.match(body, /Recent events/);
    assert.match(body, /EventSource/);
    assert.match(body, /events\/stream/);
    assert.match(body, /Live event stream disconnected/);
    assert.match(body, /Workspace cleanup/);
    assert.match(body, /data-cleanup-request/);
    assert.match(body, /cleanup-confirmation/);
    assert.match(body, /data-cleanup-apply/);
    assert.match(body, /loadTrackDetail/);
    assert.match(body, /loadRunDetail/);
    assert.match(body, /\/projects/);
    assert.match(body, /\/tracks/);
    assert.match(body, /\/tracks\?page=1&pageSize=20/);
    assert.match(body, /\/runs\/.*\/events/);
    assert.match(body, /\/workspace-cleanup\/preview/);
    assert.match(body, /\/workspace-cleanup\/apply/);
    assert.match(body, /\/approval-requests\//);
    assert.match(body, /\/tracks\/.*\/planning-sessions/);
    assert.match(body, /\/planning-sessions\/.*\/messages/);
    assert.match(body, /\/tracks\/.*\/artifacts\//);
    assert.match(body, /\/runs/);
    assert.match(body, /\/resume/);
    assert.match(body, /\/cancel/);
    assert.match(body, /projectId=/);
  });
});

test("API supports project create, list, get, and update", async () => {
  await withServer(async (baseUrl) => {
    const initialListResponse = await fetch(`${baseUrl}/projects`);
    assert.equal(initialListResponse.status, 200);
    const initialListPayload = (await initialListResponse.json()) as { projects: Array<{ id: string; name: string }> };
    assert.deepEqual(initialListPayload.projects.map((project) => project.id), ["project-default"]);

    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: " Operator UI ",
        repoUrl: " https://github.com/yoophi-a/specrail-operator ",
        localRepoPath: " /work/specrail-operator ",
        defaultWorkflowPolicy: " artifact-first-mvp ",
        defaultPlanningSystem: " OpenSpec ",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = (await createResponse.json()) as {
      project: { id: string; name: string; repoUrl?: string; localRepoPath?: string; defaultPlanningSystem?: string };
    };
    assert.match(createPayload.project.id, /^project-/);
    assert.equal(createPayload.project.name, "Operator UI");
    assert.equal(createPayload.project.defaultPlanningSystem, "openspec");

    const getResponse = await fetch(`${baseUrl}/projects/${createPayload.project.id}`);
    assert.equal(getResponse.status, 200);
    const getPayload = (await getResponse.json()) as { project: { id: string; repoUrl?: string } };
    assert.equal(getPayload.project.id, createPayload.project.id);
    assert.equal(getPayload.project.repoUrl, "https://github.com/yoophi-a/specrail-operator");

    const updateResponse = await fetch(`${baseUrl}/projects/${createPayload.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: " Operator Console ",
        repoUrl: null,
        defaultPlanningSystem: " spec-kit ",
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updatePayload = (await updateResponse.json()) as {
      project: { id: string; name: string; repoUrl?: string; defaultPlanningSystem?: string; updatedAt: string };
    };
    assert.equal(updatePayload.project.name, "Operator Console");
    assert.equal(updatePayload.project.repoUrl, undefined);
    assert.equal(updatePayload.project.defaultPlanningSystem, "speckit");

    const listResponse = await fetch(`${baseUrl}/projects`);
    assert.equal(listResponse.status, 200);
    const listPayload = (await listResponse.json()) as { projects: Array<{ id: string; name: string }> };
    assert.deepEqual(
      listPayload.projects.map((project) => project.id).sort(),
      ["project-default", createPayload.project.id].sort(),
    );
  });
});

test("API bootstraps the default project on direct project access", async () => {
  await withServer(async (baseUrl) => {
    const getDefaultResponse = await fetch(`${baseUrl}/projects/project-default`);
    assert.equal(getDefaultResponse.status, 200);
    const getDefaultPayload = (await getDefaultResponse.json()) as { project: { id: string; name: string } };
    assert.equal(getDefaultPayload.project.id, "project-default");
    assert.equal(getDefaultPayload.project.name, "SpecRail");

    const updateDefaultResponse = await fetch(`${baseUrl}/projects/project-default`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " Default Project Updated " }),
    });
    assert.equal(updateDefaultResponse.status, 200);
    const updateDefaultPayload = (await updateDefaultResponse.json()) as { project: { id: string; name: string } };
    assert.equal(updateDefaultPayload.project.id, "project-default");
    assert.equal(updateDefaultPayload.project.name, "Default Project Updated");
  });
});

test("API validates project payloads and returns 404s for missing projects", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", defaultPlanningSystem: "unknown" }),
    });
    assert.equal(createResponse.status, 422);
    const createPayload = (await createResponse.json()) as { error: { code: string; details: Array<{ field: string }> } };
    assert.equal(createPayload.error.code, "validation_error");
    assert.deepEqual(createPayload.error.details.map((detail) => detail.field), ["name", "defaultPlanningSystem"]);

    const updateResponse = await fetch(`${baseUrl}/projects/project-missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Missing" }),
    });
    assert.equal(updateResponse.status, 404);
    const updatePayload = (await updateResponse.json()) as { error: { code: string; message: string } };
    assert.equal(updatePayload.error.code, "not_found");
    assert.equal(updatePayload.error.message, "Project not found: project-missing");

    const emptyUpdateResponse = await fetch(`${baseUrl}/projects/project-default`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(emptyUpdateResponse.status, 422);
    const emptyUpdatePayload = (await emptyUpdateResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(emptyUpdatePayload.error.code, "validation_error");
    assert.deepEqual(
      emptyUpdatePayload.error.details.map((detail) => detail.field),
      ["body"],
    );

    const invalidUpdateResponse = await fetch(`${baseUrl}/projects/project-default`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", defaultPlanningSystem: "unknown" }),
    });
    assert.equal(invalidUpdateResponse.status, 422);
    const invalidUpdatePayload = (await invalidUpdateResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidUpdatePayload.error.code, "validation_error");
    assert.deepEqual(
      invalidUpdatePayload.error.details.map((detail) => detail.field),
      ["name", "defaultPlanningSystem"],
    );

    const getResponse = await fetch(`${baseUrl}/projects/project-missing`);
    assert.equal(getResponse.status, 404);
    const getPayload = (await getResponse.json()) as { error: { code: string; message: string } };
    assert.equal(getPayload.error.code, "not_found");
    assert.equal(getPayload.error.message, "project not found");
  });
});

test("API creates and filters tracks by project", async () => {
  await withServer(async (baseUrl) => {
    const createProjectResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Project-scoped tracks",
        defaultPlanningSystem: " speckit ",
      }),
    });
    assert.equal(createProjectResponse.status, 201);
    const createProjectPayload = (await createProjectResponse.json()) as { project: { id: string } };

    const defaultTrackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Default project track",
        description: "Keeps old clients on the bootstrap project.",
      }),
    });
    assert.equal(defaultTrackResponse.status, 201);
    const defaultTrackPayload = (await defaultTrackResponse.json()) as {
      track: { id: string; projectId: string; planningSystem: string };
    };
    assert.equal(defaultTrackPayload.track.projectId, "project-default");
    assert.equal(defaultTrackPayload.track.planningSystem, "native");

    const scopedTrackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: ` ${createProjectPayload.project.id} `,
        title: "Scoped project track",
        description: "Uses the requested project metadata.",
      }),
    });
    assert.equal(scopedTrackResponse.status, 201);
    const scopedTrackPayload = (await scopedTrackResponse.json()) as {
      track: { id: string; projectId: string; planningSystem: string };
    };
    assert.equal(scopedTrackPayload.track.projectId, createProjectPayload.project.id);
    assert.equal(scopedTrackPayload.track.planningSystem, "speckit");

    const filteredTracksResponse = await fetch(`${baseUrl}/tracks?projectId=${createProjectPayload.project.id}`);
    assert.equal(filteredTracksResponse.status, 200);
    const filteredTracksPayload = (await filteredTracksResponse.json()) as { tracks: Array<{ id: string; projectId: string }> };
    assert.deepEqual(filteredTracksPayload.tracks.map((track) => track.id), [scopedTrackPayload.track.id]);

    const missingProjectTrackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-missing",
        title: "Missing project track",
        description: "This should fail before artifact creation.",
      }),
    });
    assert.equal(missingProjectTrackResponse.status, 404);
    const missingProjectTrackPayload = (await missingProjectTrackResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingProjectTrackPayload.error.code, "not_found");
    assert.equal(missingProjectTrackPayload.error.message, "Project not found: project-missing");

    const emptyProjectFilterResponse = await fetch(`${baseUrl}/tracks?projectId=`);
    assert.equal(emptyProjectFilterResponse.status, 422);
    const emptyProjectFilterPayload = (await emptyProjectFilterResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(emptyProjectFilterPayload.error.code, "validation_error");
    assert.deepEqual(
      emptyProjectFilterPayload.error.details.map((detail) => detail.field),
      ["projectId"],
    );
  });
});

test("API supports creating tracks, planning sessions, messages, starting runs, and listing run events", async () => {
  await withServer(async (baseUrl, paths) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Executor MVP",
        description: "Persist command metadata and launch runs.",
        priority: " High ",
      }),
    });

    assert.equal(trackResponse.status, 201);
    const trackPayload = (await trackResponse.json()) as { track: { id: string; title: string; planningSystem: string; priority: string } };
    assert.equal(trackPayload.track.title, "Executor MVP");
    assert.equal(trackPayload.track.priority, "high");

    const missingTrackPlanningSessionsResponse = await fetch(`${baseUrl}/tracks/missing-track/planning-sessions`);
    await assertJsonResponseStatus(missingTrackPlanningSessionsResponse, 404);
    const missingTrackPlanningSessionsPayload = (await missingTrackPlanningSessionsResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingTrackPlanningSessionsPayload.error.code, "not_found");
    assert.equal(missingTrackPlanningSessionsPayload.error.message, "track not found");

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
      body: JSON.stringify({ status: " Active " }),
    });
    assert.equal(planningSessionResponse.status, 201);
    const planningSessionPayload = (await planningSessionResponse.json()) as {
      planningSession: { id: string; trackId: string; status: string };
    };
    assert.equal(planningSessionPayload.planningSession.trackId, trackPayload.track.id);

    const invalidPlanningSessionCreateResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/planning-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    await assertJsonResponseStatus(invalidPlanningSessionCreateResponse, 422);
    const invalidPlanningSessionCreatePayload = (await invalidPlanningSessionCreateResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidPlanningSessionCreatePayload.error.code, "validation_error");
    assert.deepEqual(
      invalidPlanningSessionCreatePayload.error.details.map((detail) => detail.field),
      ["status"],
    );

    const planningSessionUpdateResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: " Waiting-Agent " }),
    });
    assert.equal(planningSessionUpdateResponse.status, 200);
    const planningSessionUpdatePayload = (await planningSessionUpdateResponse.json()) as {
      planningSession: { id: string; status: string; updatedAt: string };
    };
    assert.equal(planningSessionUpdatePayload.planningSession.id, planningSessionPayload.planningSession.id);
    assert.equal(planningSessionUpdatePayload.planningSession.status, "waiting_agent");

    const missingPlanningSessionLookupResponse = await fetch(`${baseUrl}/planning-sessions/missing-session`);
    await assertJsonResponseStatus(missingPlanningSessionLookupResponse, 404);
    const missingPlanningSessionLookupPayload = (await missingPlanningSessionLookupResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingPlanningSessionLookupPayload.error.code, "not_found");
    assert.equal(missingPlanningSessionLookupPayload.error.message, "planning session not found");

    const invalidPlanningSessionUpdateResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    await assertJsonResponseStatus(invalidPlanningSessionUpdateResponse, 422);
    const invalidPlanningSessionUpdatePayload = (await invalidPlanningSessionUpdateResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidPlanningSessionUpdatePayload.error.code, "validation_error");
    assert.deepEqual(
      invalidPlanningSessionUpdatePayload.error.details.map((detail) => detail.field),
      ["status"],
    );

    const missingPlanningSessionUpdateResponse = await fetch(`${baseUrl}/planning-sessions/missing-session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    await assertJsonResponseStatus(missingPlanningSessionUpdateResponse, 404);
    const missingPlanningSessionUpdatePayload = (await missingPlanningSessionUpdateResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingPlanningSessionUpdatePayload.error.code, "not_found");
    assert.equal(missingPlanningSessionUpdatePayload.error.message, "Planning session not found: missing-session");

    const invalidPlanningMessageResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorType: "bot",
        body: "",
        kind: "memo",
        relatedArtifact: "diagram",
      }),
    });
    await assertJsonResponseStatus(invalidPlanningMessageResponse, 422);
    const invalidPlanningMessagePayload = (await invalidPlanningMessageResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidPlanningMessagePayload.error.code, "validation_error");
    assert.deepEqual(
      invalidPlanningMessagePayload.error.details.map((detail) => detail.field),
      ["authorType", "body", "kind", "relatedArtifact"],
    );

    const missingPlanningMessageAppendResponse = await fetch(`${baseUrl}/planning-sessions/missing-session/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorType: "user",
        body: "Can we add a message?",
      }),
    });
    await assertJsonResponseStatus(missingPlanningMessageAppendResponse, 404);
    const missingPlanningMessageAppendPayload = (await missingPlanningMessageAppendResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingPlanningMessageAppendPayload.error.code, "not_found");
    assert.equal(missingPlanningMessageAppendPayload.error.message, "Planning session not found: missing-session");

    const planningMessageResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorType: " USER ",
        kind: " Question ",
        relatedArtifact: " Plan ",
        body: "Can we separate planning state from run events?",
      }),
    });
    assert.equal(planningMessageResponse.status, 201);

    const planningMessagesResponse = await fetch(`${baseUrl}/planning-sessions/${planningSessionPayload.planningSession.id}/messages`);
    assert.equal(planningMessagesResponse.status, 200);
    const planningMessagesPayload = (await planningMessagesResponse.json()) as {
      messages: Array<{ authorType: string; kind: string; relatedArtifact?: string; body: string }>;
    };
    assert.equal(planningMessagesPayload.messages.length, 1);
    assert.equal(planningMessagesPayload.messages[0]?.authorType, "user");
    assert.equal(planningMessagesPayload.messages[0]?.kind, "question");
    assert.equal(planningMessagesPayload.messages[0]?.relatedArtifact, "plan");
    assert.equal(planningMessagesPayload.messages[0]?.body, "Can we separate planning state from run events?");

    const missingPlanningMessagesResponse = await fetch(`${baseUrl}/planning-sessions/missing-session/messages`);
    await assertJsonResponseStatus(missingPlanningMessagesResponse, 404);
    const missingPlanningMessagesPayload = (await missingPlanningMessagesResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingPlanningMessagesPayload.error.code, "not_found");
    assert.equal(missingPlanningMessagesPayload.error.message, "Planning session not found: missing-session");

    const bindResponse = await fetch(`${baseUrl}/channel-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: " project-default ",
        channelType: " Telegram ",
        externalChatId: " chat-1 ",
        externalThreadId: " thread-1 ",
        externalUserId: " user-1 ",
        trackId: ` ${trackPayload.track.id} `,
        planningSessionId: ` ${planningSessionPayload.planningSession.id} `,
      }),
    });
    assert.equal(bindResponse.status, 201);
    const bindPayload = (await bindResponse.json()) as {
      binding: { id: string; channelType: string; externalChatId: string; externalThreadId?: string; externalUserId?: string; planningSessionId?: string };
    };
    assert.equal(bindPayload.binding.channelType, "telegram");
    assert.equal(bindPayload.binding.externalChatId, "chat-1");
    assert.equal(bindPayload.binding.externalThreadId, "thread-1");
    assert.equal(bindPayload.binding.externalUserId, "user-1");
    assert.equal(bindPayload.binding.planningSessionId, planningSessionPayload.planningSession.id);

    const getBindingResponse = await fetch(
      `${baseUrl}/channel-bindings?channelType=Telegram&externalChatId=chat-1&externalThreadId=thread-1`,
    );
    assert.equal(getBindingResponse.status, 200);
    const getBindingPayload = (await getBindingResponse.json()) as { binding: { id: string } };
    assert.equal(getBindingPayload.binding.id, bindPayload.binding.id);

    const githubBindResponse = await fetch(`${baseUrl}/channel-bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-default",
        channelType: "github",
        externalChatId: "yoophi-a/specrail",
        externalThreadId: "123",
        externalUserId: "octocat",
        trackId: trackPayload.track.id,
      }),
    });
    assert.equal(githubBindResponse.status, 201);
    const githubBindPayload = (await githubBindResponse.json()) as { binding: { id: string; channelType: string } };
    assert.equal(githubBindPayload.binding.channelType, "github");

    const getGithubBindingResponse = await fetch(
      `${baseUrl}/channel-bindings?channelType=GitHub&externalChatId=${encodeURIComponent("yoophi-a/specrail")}&externalThreadId=123`,
    );
    assert.equal(getGithubBindingResponse.status, 200);
    const getGithubBindingPayload = (await getGithubBindingResponse.json()) as { binding: { id: string } };
    assert.equal(getGithubBindingPayload.binding.id, githubBindPayload.binding.id);

    const missingBindingResponse = await fetch(`${baseUrl}/channel-bindings?channelType=Telegram&externalChatId=missing-chat`);
    assert.equal(missingBindingResponse.status, 404);
    const missingBindingPayload = (await missingBindingResponse.json()) as { error: { code: string; message: string } };
    assert.equal(missingBindingPayload.error.code, "not_found");
    assert.equal(missingBindingPayload.error.message, "channel binding not found");

    const invalidBindingLookupResponse = await fetch(`${baseUrl}/channel-bindings?channelType=Discord&externalChatId=%20`);
    assert.equal(invalidBindingLookupResponse.status, 422);
    const invalidBindingLookupPayload = (await invalidBindingLookupResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidBindingLookupPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidBindingLookupPayload.error.details.map((detail) => detail.field),
      ["channelType", "externalChatId"],
    );

    const attachmentResponse = await fetch(`${baseUrl}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: " Telegram ",
        externalFileId: " file-1 ",
        fileName: " brief.txt ",
        mimeType: " text/plain ",
        planningSessionId: ` ${planningSessionPayload.planningSession.id} `,
      }),
    });
    assert.equal(attachmentResponse.status, 201);
    const attachmentPayload = (await attachmentResponse.json()) as {
      attachment: { sourceType: string; externalFileId: string; fileName?: string; mimeType?: string; planningSessionId?: string };
    };
    assert.equal(attachmentPayload.attachment.sourceType, "telegram");
    assert.equal(attachmentPayload.attachment.externalFileId, "file-1");
    assert.equal(attachmentPayload.attachment.fileName, "brief.txt");
    assert.equal(attachmentPayload.attachment.mimeType, "text/plain");
    assert.equal(attachmentPayload.attachment.planningSessionId, planningSessionPayload.planningSession.id);

    const trackAttachmentResponse = await fetch(`${baseUrl}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "telegram",
        externalFileId: "track-file-1",
        fileName: "track-brief.txt",
        trackId: trackPayload.track.id,
      }),
    });
    assert.equal(trackAttachmentResponse.status, 201);
    const trackAttachmentPayload = (await trackAttachmentResponse.json()) as {
      attachment: { externalFileId: string; fileName?: string; trackId?: string };
    };
    assert.equal(trackAttachmentPayload.attachment.externalFileId, "track-file-1");
    assert.equal(trackAttachmentPayload.attachment.fileName, "track-brief.txt");
    assert.equal(trackAttachmentPayload.attachment.trackId, trackPayload.track.id);

    const invalidAttachmentResponse = await fetch(`${baseUrl}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "discord",
        externalFileId: " ",
      }),
    });
    assert.equal(invalidAttachmentResponse.status, 422);
    const invalidAttachmentPayload = (await invalidAttachmentResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidAttachmentPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidAttachmentPayload.error.details.map((detail) => detail.field),
      ["sourceType", "externalFileId", "body"],
    );

    const attachmentsResponse = await fetch(
      `${baseUrl}/attachments?planningSessionId=${encodeURIComponent(planningSessionPayload.planningSession.id)}`,
    );
    assert.equal(attachmentsResponse.status, 200);
    const attachmentsPayload = (await attachmentsResponse.json()) as { attachments: Array<{ externalFileId: string }> };
    assert.deepEqual(attachmentsPayload.attachments.map((attachment) => attachment.externalFileId), ["file-1"]);

    const trackAttachmentsResponse = await fetch(`${baseUrl}/attachments?trackId=${encodeURIComponent(trackPayload.track.id)}`);
    assert.equal(trackAttachmentsResponse.status, 200);
    const trackAttachmentsPayload = (await trackAttachmentsResponse.json()) as { attachments: Array<{ externalFileId: string }> };
    assert.deepEqual(trackAttachmentsPayload.attachments.map((attachment) => attachment.externalFileId), ["track-file-1"]);

    const invalidAttachmentsResponse = await fetch(`${baseUrl}/attachments`);
    assert.equal(invalidAttachmentsResponse.status, 422);
    const invalidAttachmentsPayload = (await invalidAttachmentsResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidAttachmentsPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidAttachmentsPayload.error.details.map((detail) => detail.field),
      ["query"],
    );

    const proposedPlanRevisionResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "# Approved plan\n\nUse the linked planning context.",
        createdBy: " Agent ",
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
        body: JSON.stringify({ decidedBy: " User ", comment: " approved " }),
      },
    );
    assert.equal(approvePlanResponse.status, 200);

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: ` ${trackPayload.track.id} `,
        prompt: " Implement the issue ",
        backend: " codex ",
        profile: " default ",
        planningSessionId: ` ${planningSessionPayload.planningSession.id} `,
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


test("API serves completed run Markdown reports without mutating artifacts or events", async () => {
  await withServer(async (baseUrl, paths) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Report export",
        description: "Render a completed-run report.",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const createRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Generate the report",
      }),
    });
    const runPayload = (await createRunResponse.json()) as { run: { id: string } };

    await waitForRunEvent(baseUrl, runPayload.run.id, (event) => event.type === "message" && /STDOUT/.test(event.summary));

    const eventsBefore = await readRunEventsText(baseUrl, runPayload.run.id);
    const specPath = path.join(paths.repoArtifactDir, "tracks", trackPayload.track.id, "spec.md");
    const specBefore = await readFile(specPath, "utf8");

    const reportResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/report.md`);
    assert.equal(reportResponse.status, 200);
    assert.match(reportResponse.headers.get("content-type") ?? "", /text\/markdown; charset=utf-8/);
    assert.equal(
      reportResponse.headers.get("content-disposition"),
      `attachment; filename="specrail-run-${runPayload.run.id}-report.md"`,
    );

    const report = await reportResponse.text();
    assert.match(report, new RegExp(`# Run Report — ${runPayload.run.id}`));
    assert.match(report, /## Summary/);
    assert.match(report, /- Track: Report export/);
    assert.match(report, /## Timeline/);
    assert.match(report, /Run started/);
    assert.match(report, new RegExp("Generated from `state/events/" + runPayload.run.id + "\\.jsonl`"));
    assert.match(report, /does not mutate `spec.md`, `plan.md`, or `tasks.md`/);

    const eventsAfter = await readRunEventsText(baseUrl, runPayload.run.id);
    const specAfter = await readFile(specPath, "utf8");
    assert.equal(eventsAfter, eventsBefore);
    assert.equal(specAfter, specBefore);

    const missingResponse = await fetch(`${baseUrl}/runs/missing-run/report.md`);
    await assertJsonResponseStatus(missingResponse, 404);
    const missingPayload = (await missingResponse.json()) as { error: { code: string; message: string } };
    assert.equal(missingPayload.error.code, "not_found");
    assert.equal(missingPayload.error.message, "run not found");
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
        backend: " CoDeX ",
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
      body: JSON.stringify({ prompt: " Continue with verification ", backend: " codex ", profile: " default " }),
    });
    assert.equal(resumeResponse.status, 200);

    const resumedEvents = await stream.waitForEvent((event) => /Resumed Codex session/.test(event.summary));
    assert.ok(resumedEvents.some((event) => /Resumed Codex session/.test(event.summary)));

    const cancelResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);

    const cancelledEvents = await stream.waitForEvent((event) => /Cancelled Codex session/.test(event.summary));
    assert.ok(cancelledEvents.some((event) => /Cancelled Codex session/.test(event.summary)));
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
    const runPayload = (await createRunResponse.json()) as { run: { id: string; status: string; workspacePath: string } };

    const resumeResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue with verification", backend: " CoDeX " }),
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
    assert.ok((resumedPayload.run.summary?.eventCount ?? 0) >= 3);
    assert.match(resumedPayload.run.summary?.lastEventSummary ?? "", /Resumed Codex session/);

    const sessionResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/session`);
    await assertJsonResponseStatus(sessionResponse, 200);
    const sessionPayload = (await sessionResponse.json()) as {
      session?: { sessionRef?: string; providerSessionId?: string; codexSessionId?: string; resumeSessionRef?: string };
      capabilities?: { supportsResume?: boolean; supportsContextCopyFork?: boolean };
    };
    assert.equal(sessionPayload.session?.sessionRef, `${runPayload.run.id}-codex`);
    assert.ok(sessionPayload.session?.resumeSessionRef ?? sessionPayload.session?.providerSessionId ?? sessionPayload.session?.codexSessionId);
    assert.equal(sessionPayload.capabilities?.supportsResume, true);
    assert.equal(sessionPayload.capabilities?.supportsContextCopyFork, true);

    const folderRunsResponse = await fetch(`${baseUrl}/runs?workspacePath=${encodeURIComponent(runPayload.run.workspacePath)}`);
    await assertJsonResponseStatus(folderRunsResponse, 200);
    const folderRunsPayload = (await folderRunsResponse.json()) as { runs: Array<{ id: string; workspacePath: string }> };
    assert.ok(folderRunsPayload.runs.some((run) => run.id === runPayload.run.id));

    const parentFolderRunsResponse = await fetch(`${baseUrl}/runs?workspacePath=${encodeURIComponent(path.dirname(runPayload.run.workspacePath))}`);
    await assertJsonResponseStatus(parentFolderRunsResponse, 200);
    const parentFolderRunsPayload = (await parentFolderRunsResponse.json()) as { runs: Array<{ id: string; workspacePath: string }> };
    assert.ok(parentFolderRunsPayload.runs.some((run) => run.id === runPayload.run.id));

    const childFolderRunsResponse = await fetch(`${baseUrl}/runs?workspacePath=${encodeURIComponent(path.join(runPayload.run.workspacePath, "src"))}`);
    await assertJsonResponseStatus(childFolderRunsResponse, 200);
    const childFolderRunsPayload = (await childFolderRunsResponse.json()) as { runs: Array<{ id: string; workspacePath: string }> };
    assert.ok(childFolderRunsPayload.runs.some((run) => run.id === runPayload.run.id));

    const sessionPreviewResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/session-preview?eventLimit=%202%20`);
    await assertJsonResponseStatus(sessionPreviewResponse, 200);
    const sessionPreviewPayload = (await sessionPreviewResponse.json()) as { events: Array<{ summary: string }>; reportPath?: string };
    assert.ok(sessionPreviewPayload.events.length <= 2);
    assert.equal(sessionPreviewPayload.reportPath, `/runs/${runPayload.run.id}/report.md`);

    const forkResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: " Continue separately ", mode: " Context-Copy ", backend: " CoDeX ", profile: " default " }),
    });
    await assertJsonResponseStatus(forkResponse, 201);
    const forkPayload = (await forkResponse.json()) as {
      run: { id: string; sessionRef?: string; parentExecutionId?: string; parentSessionRef?: string; continuityMode?: string };
    };
    assert.notEqual(forkPayload.run.id, runPayload.run.id);
    assert.equal(forkPayload.run.parentExecutionId, runPayload.run.id);
    assert.equal(forkPayload.run.parentSessionRef, `${runPayload.run.id}-codex`);
    assert.equal(forkPayload.run.continuityMode, "context_copy");

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

    const cleanupPreviewResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/workspace-cleanup/preview`);
    await assertJsonResponseStatus(cleanupPreviewResponse, 200);
    const cleanupPreviewPayload = (await cleanupPreviewResponse.json()) as {
      cleanupPlan: {
        executionId: string;
        eligible: boolean;
        dryRun: boolean;
        mode: string;
        operations: Array<{ kind: string; path?: string }>;
        refusalReasons: string[];
      };
    };
    assert.equal(cleanupPreviewPayload.cleanupPlan.executionId, runPayload.run.id);
    assert.equal(cleanupPreviewPayload.cleanupPlan.eligible, true);
    assert.equal(cleanupPreviewPayload.cleanupPlan.dryRun, true);
    assert.equal(cleanupPreviewPayload.cleanupPlan.mode, "directory");
    assert.equal(cleanupPreviewPayload.cleanupPlan.operations[0]?.kind, "remove_directory");
    assert.deepEqual(cleanupPreviewPayload.cleanupPlan.refusalReasons, []);

    const refusedCleanupResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/workspace-cleanup/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "cleanup" }),
    });
    await assertJsonResponseStatus(refusedCleanupResponse, 200);
    const refusedCleanupPayload = (await refusedCleanupResponse.json()) as {
      cleanupResult: { status: string; applied: boolean; refusalReasons: string[] };
      expectedConfirmation: string;
    };
    assert.equal(refusedCleanupPayload.expectedConfirmation, `apply workspace cleanup for ${runPayload.run.id}`);
    assert.equal(refusedCleanupPayload.cleanupResult.status, "refused");
    assert.equal(refusedCleanupPayload.cleanupResult.applied, false);
    assert.deepEqual(refusedCleanupPayload.cleanupResult.refusalReasons, [
      "Workspace cleanup apply requires explicit confirmation",
    ]);

    const refusedEventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    const refusedEventsPayload = (await refusedEventsResponse.json()) as {
      events: Array<{ summary: string; payload?: { status?: string; refusalReasons?: string[] } }>;
    };
    assert.ok(
      refusedEventsPayload.events.some(
        (event) =>
          event.summary === `Workspace cleanup refused for execution ${runPayload.run.id}` &&
          event.payload?.status === "refused" &&
          event.payload.refusalReasons?.includes("Workspace cleanup apply requires explicit confirmation"),
      ),
    );

    const appliedCleanupResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/workspace-cleanup/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: `apply workspace cleanup for ${runPayload.run.id}` }),
    });
    await assertJsonResponseStatus(appliedCleanupResponse, 200);
    const appliedCleanupPayload = (await appliedCleanupResponse.json()) as {
      cleanupResult: { status: string; applied: boolean; operations: Array<{ status: string }> };
    };
    assert.equal(appliedCleanupPayload.cleanupResult.status, "applied");
    assert.equal(appliedCleanupPayload.cleanupResult.applied, true);
    assert.deepEqual(appliedCleanupPayload.cleanupResult.operations.map((operation) => operation.status), ["applied"]);
    await assert.rejects(() => access(cleanupPreviewPayload.cleanupPlan.operations[0]?.path ?? ""));

    const appliedEventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    const appliedEventsPayload = (await appliedEventsResponse.json()) as {
      events: Array<{ summary: string; payload?: { status?: string; operationCount?: number } }>;
    };
    assert.ok(
      appliedEventsPayload.events.some(
        (event) =>
          event.summary === `Workspace cleanup applied for execution ${runPayload.run.id}` &&
          event.payload?.status === "applied" &&
          event.payload.operationCount === 1,
      ),
    );
  });
});

test("API refuses workspace cleanup preview for active runs", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Cleanup active run",
        description: "Preview cleanup guardrails.",
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

    const cleanupPreviewResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/workspace-cleanup/preview`);
    assert.equal(cleanupPreviewResponse.status, 200);
    const cleanupPreviewPayload = (await cleanupPreviewResponse.json()) as {
      cleanupPlan: { eligible: boolean; operations: unknown[]; refusalReasons: string[] };
    };
    assert.equal(cleanupPreviewPayload.cleanupPlan.eligible, false);
    assert.deepEqual(cleanupPreviewPayload.cleanupPlan.operations, []);
    assert.deepEqual(cleanupPreviewPayload.cleanupPlan.refusalReasons, [
      "Execution status running is not eligible for workspace cleanup",
    ]);

    const missingCleanupPreviewResponse = await fetch(`${baseUrl}/runs/missing/workspace-cleanup/preview`);
    assert.equal(missingCleanupPreviewResponse.status, 404);
    const missingCleanupPreviewPayload = (await missingCleanupPreviewResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingCleanupPreviewPayload.error.code, "not_found");
    assert.equal(missingCleanupPreviewPayload.error.message, "run not found");

    const missingCleanupApplyResponse = await fetch(`${baseUrl}/runs/missing/workspace-cleanup/apply`, {
      method: "POST",
    });
    assert.equal(missingCleanupApplyResponse.status, 404);
    const missingCleanupApplyPayload = (await missingCleanupApplyResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingCleanupApplyPayload.error.code, "not_found");
    assert.equal(missingCleanupApplyPayload.error.message, "run not found");
  });
});

test("API resolves runtime approval requests", async () => {
  await withServer(async (baseUrl, { dataDir }) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Runtime approval",
        description: "Exercise runtime approval resolution route.",
      }),
    });
    const trackPayload = (await trackResponse.json()) as { track: { id: string } };

    const createRunResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Start gated work",
      }),
    });
    const runPayload = (await createRunResponse.json()) as { run: { id: string } };
    const requestId = `${runPayload.run.id}:approval-requested`;

    await writeFile(
      path.join(dataDir, "state", "events", `${runPayload.run.id}.jsonl`),
      `${JSON.stringify({
        id: requestId,
        executionId: runPayload.run.id,
        type: "approval_requested",
        timestamp: "2026-04-09T07:00:00.000Z",
        source: "codex",
        summary: "Approve Bash",
        payload: { toolName: "Bash", toolUseId: "toolu-runtime" },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    const approveResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/approval-requests/${requestId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user", comment: "approved" }),
    });
    assert.equal(approveResponse.status, 200);
    const approvePayload = (await approveResponse.json()) as {
      event: { type: string; payload: { requestId: string; outcome: string; status: string; toolName: string } };
    };
    assert.equal(approvePayload.event.type, "approval_resolved");
    assert.equal(approvePayload.event.payload.requestId, requestId);
    assert.equal(approvePayload.event.payload.outcome, "approved");
    assert.equal(approvePayload.event.payload.status, "running");
    assert.equal(approvePayload.event.payload.toolName, "Bash");

    const invalidDecisionResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/approval-requests/${requestId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "reviewer", comment: "" }),
    });
    assert.equal(invalidDecisionResponse.status, 422);
    const invalidDecisionPayload = (await invalidDecisionResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidDecisionPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidDecisionPayload.error.details.map((detail) => detail.field),
      ["decidedBy", "comment"],
    );

    const invalidRejectDecisionResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/approval-requests/${requestId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "reviewer", comment: "" }),
    });
    assert.equal(invalidRejectDecisionResponse.status, 422);
    const invalidRejectDecisionPayload = (await invalidRejectDecisionResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidRejectDecisionPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidRejectDecisionPayload.error.details.map((detail) => detail.field),
      ["decidedBy", "comment"],
    );

    const duplicateResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/approval-requests/${requestId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user" }),
    });
    assert.equal(duplicateResponse.status, 422);
    const duplicatePayload = (await duplicateResponse.json()) as { error: { code: string; message: string } };
    assert.equal(duplicatePayload.error.code, "validation_error");
    assert.equal(duplicatePayload.error.message, `Runtime approval request is already resolved: ${requestId}`);

    const unknownResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/approval-requests/missing-request/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user" }),
    });
    assert.equal(unknownResponse.status, 404);
    const unknownPayload = (await unknownResponse.json()) as { error: { code: string; message: string } };
    assert.equal(unknownPayload.error.code, "not_found");
    assert.equal(unknownPayload.error.message, "Runtime approval request not found: missing-request");

    const unknownRejectResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/approval-requests/missing-request/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user" }),
    });
    assert.equal(unknownRejectResponse.status, 404);
    const unknownRejectPayload = (await unknownRejectResponse.json()) as { error: { code: string; message: string } };
    assert.equal(unknownRejectPayload.error.code, "not_found");
    assert.equal(unknownRejectPayload.error.message, "Runtime approval request not found: missing-request");
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
    const payload = (await runResponse.json()) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "validation_error");
    assert.equal(
      payload.error.message,
      `Track has pending planning changes and cannot start a run: ${trackPayload.track.id}`,
    );
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
        status: " Review ",
        specStatus: " Approved ",
        planStatus: " Pending ",
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
      body: JSON.stringify({ status: "in_progress" }),
    });

    const trackListResponse = await fetch(`${baseUrl}/tracks?priority=%20Low%20&page=%201%20&pageSize=%2020%20&sortBy=%20updated_at%20&sortOrder=%20DESC%20`);
    assert.equal(trackListResponse.status, 200);
    const trackListPayload = (await trackListResponse.json()) as { tracks: Array<{ id: string; priority: string }> };
    assert.deepEqual(trackListPayload.tracks.map((track) => track.id), [trackTwo.track.id]);

    const trackStatusResponse = await fetch(`${baseUrl}/tracks?status=%20In-Progress%20`);
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

    const runListResponse = await fetch(`${baseUrl}/runs?trackId=${encodeURIComponent(` ${trackOne.track.id} `)}`);
    assert.equal(runListResponse.status, 200);
    const runListPayload = (await runListResponse.json()) as { runs: Array<{ id: string; trackId: string }> };
    assert.deepEqual(runListPayload.runs.map((run) => run.id), [runOne.run.id]);

    const cancelledRunListResponse = await fetch(`${baseUrl}/runs?status=%20Cancelled%20`);
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

    const listResponse = await fetch(`${baseUrl}/tracks?page=%202%20&pageSize=%201%20&sortBy=%20Title%20&sortOrder=%20ASC%20`);
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

    const listResponse = await fetch(
      `${baseUrl}/runs?trackId=${encodeURIComponent(` ${trackPayload.track.id} `)}&page=%202%20&pageSize=%201%20&sortBy=%20created-at%20&sortOrder=%20ASC%20`,
    );
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
    assert.equal(missingTrackPayload.error.message, "Track not found: missing");

    const emptyBodyResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(emptyBodyResponse.status, 422);
    const emptyBodyPayload = (await emptyBodyResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(emptyBodyPayload.error.code, "validation_error");
    assert.deepEqual(
      emptyBodyPayload.error.details.map((detail) => detail.field),
      ["body"],
    );

    const invalidStatusResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "oops" }),
    });
    assert.equal(invalidStatusResponse.status, 422);
    const invalidStatusPayload = (await invalidStatusResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidStatusPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidStatusPayload.error.details.map((detail) => detail.field),
      ["status"],
    );

    const invalidSpecStatusResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specStatus: "oops" }),
    });
    assert.equal(invalidSpecStatusResponse.status, 422);
    const invalidSpecStatusPayload = (await invalidSpecStatusResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidSpecStatusPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidSpecStatusPayload.error.details.map((detail) => detail.field),
      ["specStatus"],
    );

    const invalidPlanStatusResponse = await fetch(`${baseUrl}/tracks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planStatus: "oops" }),
    });
    assert.equal(invalidPlanStatusResponse.status, 422);
    const invalidPlanStatusPayload = (await invalidPlanStatusResponse.json()) as {
      error: { code: string; details: Array<{ field: string; message: string }> };
    };
    assert.equal(invalidPlanStatusPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidPlanStatusPayload.error.details.map((detail) => detail.field),
      ["planStatus"],
    );
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
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidRunPayload.error.code, "validation_error");
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
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidResumePayload.error.code, "validation_error");
    assert.deepEqual(
      invalidResumePayload.error.details.map((detail) => detail.field),
      ["prompt", "backend", "profile"],
    );

    const invalidForkResponse = await fetch(`${baseUrl}/runs/run-1/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "", mode: "same-run", backend: "wat", profile: "" }),
    });
    assert.equal(invalidForkResponse.status, 422);
    const invalidForkPayload = (await invalidForkResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidForkPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidForkPayload.error.details.map((detail) => detail.field),
      ["prompt", "mode", "backend", "profile"],
    );

    const invalidTrackListResponse = await fetch(`${baseUrl}/tracks?priority=urgent&status=wat&projectId=%20`);
    assert.equal(invalidTrackListResponse.status, 422);
    const invalidTrackListPayload = (await invalidTrackListResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidTrackListPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidTrackListPayload.error.details.map((detail) => detail.field),
      ["status", "priority", "projectId"],
    );

    const invalidTrackPaginationResponse = await fetch(`${baseUrl}/tracks?page=0&pageSize=101&sortBy=nope&sortOrder=sideways`);
    assert.equal(invalidTrackPaginationResponse.status, 422);
    const invalidTrackPaginationPayload = (await invalidTrackPaginationResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidTrackPaginationPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidTrackPaginationPayload.error.details.map((detail) => detail.field),
      ["page", "pageSize", "sortBy", "sortOrder"],
    );

    const invalidRunListResponse = await fetch(`${baseUrl}/runs?trackId=&workspacePath=%20&status=wat`);
    assert.equal(invalidRunListResponse.status, 422);
    const invalidRunListPayload = (await invalidRunListResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidRunListPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidRunListPayload.error.details.map((detail) => detail.field),
      ["trackId", "workspacePath", "status"],
    );

    const invalidRunPaginationResponse = await fetch(`${baseUrl}/runs?page=abc&pageSize=0&sortBy=nope&sortOrder=sideways`);
    assert.equal(invalidRunPaginationResponse.status, 422);
    const invalidRunPaginationPayload = (await invalidRunPaginationResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidRunPaginationPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidRunPaginationPayload.error.details.map((detail) => detail.field),
      ["page", "pageSize", "sortBy", "sortOrder"],
    );

    const invalidSessionPreviewResponse = await fetch(`${baseUrl}/runs/run-1/session-preview?eventLimit=abc`);
    assert.equal(invalidSessionPreviewResponse.status, 422);
    const invalidSessionPreviewPayload = (await invalidSessionPreviewResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidSessionPreviewPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidSessionPreviewPayload.error.details.map((detail) => detail.field),
      ["eventLimit"],
    );

    const overLimitSessionPreviewResponse = await fetch(`${baseUrl}/runs/run-1/session-preview?eventLimit=51`);
    assert.equal(overLimitSessionPreviewResponse.status, 422);
    const overLimitSessionPreviewPayload = (await overLimitSessionPreviewResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(overLimitSessionPreviewPayload.error.code, "validation_error");
    assert.deepEqual(
      overLimitSessionPreviewPayload.error.details.map((detail) => detail.field),
      ["eventLimit"],
    );

    const zeroLimitSessionPreviewResponse = await fetch(`${baseUrl}/runs/run-1/session-preview?eventLimit=0`);
    assert.equal(zeroLimitSessionPreviewResponse.status, 422);
    const zeroLimitSessionPreviewPayload = (await zeroLimitSessionPreviewResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(zeroLimitSessionPreviewPayload.error.code, "validation_error");
    assert.deepEqual(
      zeroLimitSessionPreviewPayload.error.details.map((detail) => detail.field),
      ["eventLimit"],
    );

    const unsafeTrackPageResponse = await fetch(`${baseUrl}/tracks?page=999999999999999999999`);
    assert.equal(unsafeTrackPageResponse.status, 422);
    const unsafeTrackPagePayload = (await unsafeTrackPageResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(unsafeTrackPagePayload.error.code, "validation_error");
    assert.deepEqual(
      unsafeTrackPagePayload.error.details.map((detail) => detail.field),
      ["page"],
    );

    const unsafeRunEventLimitResponse = await fetch(`${baseUrl}/runs/run-1/session-preview?eventLimit=999999999999999999999`);
    assert.equal(unsafeRunEventLimitResponse.status, 422);
    const unsafeRunEventLimitPayload = (await unsafeRunEventLimitResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(unsafeRunEventLimitPayload.error.code, "validation_error");
    assert.deepEqual(
      unsafeRunEventLimitPayload.error.details.map((detail) => detail.field),
      ["eventLimit"],
    );

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
    assert.equal(malformedJsonPayload.error.message, "request body must be valid JSON");
  });
});

test("API returns 404s for unknown tracks and runs", async () => {
  await withServer(async (baseUrl) => {
    const missingTrack = await fetch(`${baseUrl}/tracks/missing`);
    assert.equal(missingTrack.status, 404);
    const missingTrackPayload = (await missingTrack.json()) as { error: { code: string; message: string } };
    assert.equal(missingTrackPayload.error.code, "not_found");
    assert.equal(missingTrackPayload.error.message, "track not found");

    const missingRunMetadata = await fetch(`${baseUrl}/runs/missing`);
    assert.equal(missingRunMetadata.status, 404);
    const missingRunMetadataPayload = (await missingRunMetadata.json()) as { error: { code: string; message: string } };
    assert.equal(missingRunMetadataPayload.error.code, "not_found");
    assert.equal(missingRunMetadataPayload.error.message, "run not found");

    const missingRun = await fetch(`${baseUrl}/runs/missing/events`);
    assert.equal(missingRun.status, 404);
    const missingRunPayload = (await missingRun.json()) as { error: { code: string; message: string } };
    assert.equal(missingRunPayload.error.code, "not_found");
    assert.equal(missingRunPayload.error.message, "run not found");

    const missingStream = await fetch(`${baseUrl}/runs/missing/events/stream`, {
      headers: { accept: "text/event-stream" },
    });
    assert.equal(missingStream.status, 404);
    const missingStreamPayload = (await missingStream.json()) as { error: { code: string; message: string } };
    assert.equal(missingStreamPayload.error.code, "not_found");
    assert.equal(missingStreamPayload.error.message, "run not found");

    const missingSession = await fetch(`${baseUrl}/runs/missing/session`);
    assert.equal(missingSession.status, 404);
    const missingSessionPayload = (await missingSession.json()) as { error: { code: string; message: string } };
    assert.equal(missingSessionPayload.error.code, "not_found");
    assert.equal(missingSessionPayload.error.message, "Run not found: missing");

    const missingSessionPreview = await fetch(`${baseUrl}/runs/missing/session-preview`);
    assert.equal(missingSessionPreview.status, 404);
    const missingSessionPreviewPayload = (await missingSessionPreview.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingSessionPreviewPayload.error.code, "not_found");
    assert.equal(missingSessionPreviewPayload.error.message, "Run not found: missing");

    const missingResume = await fetch(`${baseUrl}/runs/missing/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "nope" }),
    });
    assert.equal(missingResume.status, 404);
    const missingResumePayload = (await missingResume.json()) as { error: { code: string; message: string } };
    assert.equal(missingResumePayload.error.code, "not_found");
    assert.equal(missingResumePayload.error.message, "Run not found: missing");

    const missingFork = await fetch(`${baseUrl}/runs/missing/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "nope" }),
    });
    assert.equal(missingFork.status, 404);
    const missingForkPayload = (await missingFork.json()) as { error: { code: string; message: string } };
    assert.equal(missingForkPayload.error.code, "not_found");
    assert.equal(missingForkPayload.error.message, "Run not found: missing");

    const missingCancel = await fetch(`${baseUrl}/runs/missing/cancel`, {
      method: "POST",
    });
    assert.equal(missingCancel.status, 404);
    const missingCancelPayload = (await missingCancel.json()) as { error: { code: string; message: string } };
    assert.equal(missingCancelPayload.error.code, "not_found");
    assert.equal(missingCancelPayload.error.message, "Run not found: missing");
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

    const invalidProposalResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "", summary: "", createdBy: "reviewer" }),
    });
    assert.equal(invalidProposalResponse.status, 422);
    const invalidProposalPayload = (await invalidProposalResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidProposalPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidProposalPayload.error.details.map((detail) => detail.field),
      ["content", "summary", "createdBy"],
    );

    const unsupportedArtifactProposalResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/wireframes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "unsupported artifact proposal", createdBy: "agent" }),
    });
    assert.equal(unsupportedArtifactProposalResponse.status, 404);
    const unsupportedArtifactProposalPayload = (await unsupportedArtifactProposalResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(unsupportedArtifactProposalPayload.error.code, "not_found");
    assert.equal(unsupportedArtifactProposalPayload.error.message, "not found");

    const unsupportedArtifactLookupResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}/artifacts/wireframes`);
    assert.equal(unsupportedArtifactLookupResponse.status, 404);
    const unsupportedArtifactLookupPayload = (await unsupportedArtifactLookupResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(unsupportedArtifactLookupPayload.error.code, "not_found");
    assert.equal(unsupportedArtifactLookupPayload.error.message, "not found");

    const missingTrackProposalResponse = await fetch(`${baseUrl}/tracks/missing-track/artifacts/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "missing track proposal", createdBy: "agent" }),
    });
    assert.equal(missingTrackProposalResponse.status, 404);
    const missingTrackProposalPayload = (await missingTrackProposalResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingTrackProposalPayload.error.code, "not_found");
    assert.equal(missingTrackProposalPayload.error.message, "Track not found: missing-track");

    const missingTrackArtifactResponse = await fetch(`${baseUrl}/tracks/missing-track/artifacts/spec`);
    assert.equal(missingTrackArtifactResponse.status, 404);
    const missingTrackArtifactPayload = (await missingTrackArtifactResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingTrackArtifactPayload.error.code, "not_found");
    assert.equal(missingTrackArtifactPayload.error.message, "track not found");

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

    const duplicateRejectResponse = await fetch(`${baseUrl}/approval-requests/${rejectProposal.approvalRequest.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user", comment: "Still not ready" }),
    });
    assert.equal(duplicateRejectResponse.status, 422);
    const duplicateRejectPayload = (await duplicateRejectResponse.json()) as { error: { code: string; message: string } };
    assert.equal(duplicateRejectPayload.error.code, "validation_error");
    assert.equal(
      duplicateRejectPayload.error.message,
      `Approval request is already rejected: ${rejectProposal.approvalRequest.id}`,
    );

    const missingApprovalRequestResponse = await fetch(`${baseUrl}/approval-requests/missing-approval/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user", comment: "Cannot find it" }),
    });
    assert.equal(missingApprovalRequestResponse.status, 404);
    const missingApprovalRequestPayload = (await missingApprovalRequestResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingApprovalRequestPayload.error.code, "not_found");
    assert.equal(missingApprovalRequestPayload.error.message, "Approval request not found: missing-approval");

    const missingApprovalRejectResponse = await fetch(`${baseUrl}/approval-requests/missing-approval/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "user", comment: "Cannot find it" }),
    });
    assert.equal(missingApprovalRejectResponse.status, 404);
    const missingApprovalRejectPayload = (await missingApprovalRejectResponse.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(missingApprovalRejectPayload.error.code, "not_found");
    assert.equal(missingApprovalRejectPayload.error.message, "Approval request not found: missing-approval");

    const invalidDecisionResponse = await fetch(`${baseUrl}/approval-requests/${rejectProposal.approvalRequest.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "reviewer", comment: "" }),
    });
    assert.equal(invalidDecisionResponse.status, 422);
    const invalidDecisionPayload = (await invalidDecisionResponse.json()) as {
      error: { code: string; details: Array<{ field: string }> };
    };
    assert.equal(invalidDecisionPayload.error.code, "validation_error");
    assert.deepEqual(
      invalidDecisionPayload.error.details.map((detail) => detail.field),
      ["decidedBy", "comment"],
    );

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
      revision: { id: string; version: number };
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
      artifact: { kind: string; content: string };
      revisions: Array<{ version: number; approvedAt?: string }>;
      approvalRequests: Array<{ status: string }>;
    };
    assert.deepEqual(artifactPayload.artifact, { kind: "spec", content: "approved spec revision" });
    assert.deepEqual(artifactPayload.revisions.map((revision) => revision.version), [2, 1]);
    assert.ok(artifactPayload.revisions[0]?.approvedAt);
    assert.deepEqual(artifactPayload.approvalRequests.map((request) => request.status), ["approved", "rejected"]);

    const revisionResponse = await fetch(`${baseUrl}/artifact-revisions/${pendingProposal.revision.id}`);
    assert.equal(revisionResponse.status, 200);
    const revisionPayload = (await revisionResponse.json()) as {
      revision: { id: string; trackId: string; artifact: string; content: string; approvedAt?: string };
    };
    assert.equal(revisionPayload.revision.id, pendingProposal.revision.id);
    assert.equal(revisionPayload.revision.trackId, trackPayload.track.id);
    assert.equal(revisionPayload.revision.artifact, "spec");
    assert.equal(revisionPayload.revision.content, "approved spec revision");
    assert.ok(revisionPayload.revision.approvedAt);

    const missingRevisionResponse = await fetch(`${baseUrl}/artifact-revisions/missing-revision`);
    assert.equal(missingRevisionResponse.status, 404);
    const missingRevisionPayload = (await missingRevisionResponse.json()) as { error: { code: string; message: string } };
    assert.equal(missingRevisionPayload.error.code, "not_found");
    assert.equal(missingRevisionPayload.error.message, "Artifact revision not found: missing-revision");

    const getTrackResponse = await fetch(`${baseUrl}/tracks/${trackPayload.track.id}`);
    const getTrackPayload = (await getTrackResponse.json()) as {
      track: { specStatus: string };
      artifacts: { spec: string };
    };
    assert.equal(getTrackPayload.track.specStatus, "approved");
    assert.equal(getTrackPayload.artifacts.spec, "approved spec revision");
  });
});
