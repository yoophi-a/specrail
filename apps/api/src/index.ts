import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CodexAdapterStub } from "@specrail/adapters";
import { getTrackArtifactPaths, loadConfig, materializeTrackArtifacts } from "@specrail/config";
import {
  FileExecutionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
  SpecRailService,
  type ExecutionEvent,
  type SpecRailServiceDependencies,
} from "@specrail/core";

interface ApiDeps {
  artifactRoot: string;
  service: SpecRailService;
}

interface TrackRequestBody {
  title: string;
  description: string;
  priority?: "low" | "medium" | "high";
}

interface RunRequestBody {
  trackId: string;
  prompt: string;
  profile?: string;
}

interface ResumeRunRequestBody {
  prompt: string;
}

interface DefaultDependencies {
  artifactRoot: string;
  serviceDependencies: SpecRailServiceDependencies;
}

function createDependencies(dataDir: string): DefaultDependencies {
  const stateDir = path.join(dataDir, "state");
  const artifactRoot = path.join(dataDir, "artifacts");
  const workspaceRoot = path.join(dataDir, "workspaces");
  const sessionsDir = path.join(dataDir, "sessions");
  const templateDir = path.resolve(process.cwd(), ".specrail-template");

  return {
    artifactRoot,
    serviceDependencies: {
      projectRepository: new FileProjectRepository(stateDir),
      trackRepository: new FileTrackRepository(stateDir),
      executionRepository: new FileExecutionRepository(stateDir),
      eventStore: new JsonlEventStore(stateDir),
      artifactWriter: {
        async write(input) {
          await materializeTrackArtifacts({
            rootDir: artifactRoot,
            templateDir,
            trackId: input.track.id,
            projectName: input.project.name,
            trackTitle: input.track.title,
            trackDescription: input.track.description,
            specContent: input.specContent,
            planContent: input.planContent,
            tasksContent: input.tasksContent,
          });
        },
      },
      executor: new CodexAdapterStub({ sessionsDir }),
      defaultProject: {
        id: "project-default",
        name: "SpecRail",
        repoUrl: "https://github.com/yoophi-a/specrail",
        localRepoPath: process.cwd(),
        defaultWorkflowPolicy: "artifact-first-mvp",
      },
      workspaceRoot,
    },
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function getPathSegments(request: IncomingMessage): string[] {
  return (request.url ?? "/")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
}

function writeSseEvent(response: ServerResponse, event: ExecutionEvent): void {
  response.write(`event: execution-event\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamRunEvents(
  response: ServerResponse,
  service: SpecRailService,
  runId: string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let closed = false;
  let sentCount = 0;

  const flushEvents = async (): Promise<void> => {
    const events = await service.listRunEvents(runId);
    const nextEvents = events.slice(sentCount);

    for (const event of nextEvents) {
      writeSseEvent(response, event);
      sentCount += 1;
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(interval);
    response.end();
  };

  await flushEvents();
  response.write(`: connected\n\n`);

  const interval = setInterval(() => {
    void flushEvents().catch(() => {
      close();
    });
  }, 50);

  response.on("close", close);
  response.on("error", close);
}

async function readTrackArtifacts(artifactRoot: string, trackId: string): Promise<{
  spec: string;
  plan: string;
  tasks: string;
}> {
  const artifactPaths = getTrackArtifactPaths(artifactRoot, trackId);
  const [spec, plan, tasks] = await Promise.all([
    readFile(artifactPaths.specPath, "utf8"),
    readFile(artifactPaths.planPath, "utf8"),
    readFile(artifactPaths.tasksPath, "utf8"),
  ]);

  return { spec, plan, tasks };
}

export function createSpecRailHttpServer(deps: ApiDeps): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const segments = getPathSegments(request);

      if (method === "POST" && segments.length === 1 && segments[0] === "tracks") {
        const body = await readJson<TrackRequestBody>(request);

        if (!body.title || !body.description) {
          sendJson(response, 400, { error: "title and description are required" });
          return;
        }

        const track = await deps.service.createTrack(body);
        sendJson(response, 201, { track });
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "tracks") {
        const track = await deps.service.getTrack(segments[1] ?? "");

        if (!track) {
          sendJson(response, 404, { error: "track not found" });
          return;
        }

        const artifacts = await readTrackArtifacts(deps.artifactRoot, track.id);
        sendJson(response, 200, { track, artifacts });
        return;
      }

      if (method === "POST" && segments.length === 1 && segments[0] === "runs") {
        const body = await readJson<RunRequestBody>(request);

        if (!body.trackId || !body.prompt) {
          sendJson(response, 400, { error: "trackId and prompt are required" });
          return;
        }

        const run = await deps.service.startRun(body);
        sendJson(response, 201, { run });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "runs" && segments[2] === "resume") {
        const body = await readJson<ResumeRunRequestBody>(request);

        if (!body.prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const existingRun = await deps.service.getRun(segments[1] ?? "");

        if (!existingRun) {
          sendJson(response, 404, { error: "run not found" });
          return;
        }

        const run = await deps.service.resumeRun({ runId: existingRun.id, prompt: body.prompt });
        sendJson(response, 200, { run });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
        const existingRun = await deps.service.getRun(segments[1] ?? "");

        if (!existingRun) {
          sendJson(response, 404, { error: "run not found" });
          return;
        }

        const run = await deps.service.cancelRun({ runId: existingRun.id });
        sendJson(response, 200, { run });
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "runs") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendJson(response, 404, { error: "run not found" });
          return;
        }

        sendJson(response, 200, { run });
        return;
      }

      if (method === "GET" && segments.length === 4 && segments[0] === "runs" && segments[2] === "events" && segments[3] === "stream") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendJson(response, 404, { error: "run not found" });
          return;
        }

        await streamRunEvents(response, deps.service, run.id);
        return;
      }

      if (method === "GET" && segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendJson(response, 404, { error: "run not found" });
          return;
        }

        const events = await deps.service.listRunEvents(run.id);
        sendJson(response, 200, { events });
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      sendJson(response, 500, { error: message });
    }
  });
}

export function createDefaultServer(): http.Server {
  const config = loadConfig();
  const dependencies = createDependencies(config.dataDir);

  return createSpecRailHttpServer({
    artifactRoot: dependencies.artifactRoot,
    service: new SpecRailService(dependencies.serviceDependencies),
  });
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  const config = loadConfig();
  const server = createDefaultServer();

  server.listen(config.port, () => {
    console.log(`[specrail] api listening on port ${config.port}`);
  });
}
