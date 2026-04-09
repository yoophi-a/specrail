import { watch } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CodexAdapter, GitHubRunCommentGhPublisher } from "@specrail/adapters";
import { getTrackArtifactPaths, loadConfig, materializeTrackArtifacts } from "@specrail/config";
import {
  APPROVAL_STATUSES,
  FileExecutionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
  NotFoundError,
  getStatePaths,
  SpecRailService,
  TRACK_STATUSES,
  type ExecutionEvent,
  type ApprovalStatus,
  type GitHubIssueReference,
  type GitHubPullRequestReference,
  type SpecRailServiceDependencies,
  type TrackStatus,
} from "@specrail/core";

interface ApiDeps {
  artifactRoot: string;
  eventLogDir: string;
  service: SpecRailService;
}

interface TrackRequestBody {
  title: string;
  description: string;
  priority?: "low" | "medium" | "high";
  githubIssue?: GitHubIssueReference;
  githubPullRequest?: GitHubPullRequestReference;
}

interface RunRequestBody {
  trackId: string;
  prompt: string;
  profile?: string;
}

interface UpdateTrackRequestBody {
  status?: TrackStatus;
  specStatus?: ApprovalStatus;
  planStatus?: ApprovalStatus;
  githubIssue?: GitHubIssueReference;
  githubPullRequest?: GitHubPullRequestReference;
}

interface ResumeRunRequestBody {
  prompt: string;
}

interface TrackListQuery {
  status?: TrackStatus;
  priority?: TrackRequestBody["priority"];
  page?: number;
  pageSize?: number;
  sortBy?: "updatedAt" | "createdAt" | "title" | "priority" | "status";
  sortOrder?: "asc" | "desc";
}

interface RunListQuery {
  trackId?: string;
  status?: "created" | "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "startedAt" | "finishedAt" | "status";
  sortOrder?: "asc" | "desc";
}

interface ListMeta {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: "asc" | "desc";
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface DefaultDependencies {
  artifactRoot: string;
  eventLogDir: string;
  serviceDependencies: SpecRailServiceDependencies;
}

interface ApiErrorDetail {
  field: string;
  message: string;
}

class BadRequestError extends Error {
  readonly statusCode = 400;
  readonly code = "bad_request";
}

class RequestValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "validation_error";

  constructor(
    message: string,
    readonly details: ApiErrorDetail[],
  ) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function createDependencies(dataDir: string, repoArtifactRoot: string, githubPublishEnabled = false): DefaultDependencies {
  const stateDir = path.join(dataDir, "state");
  const artifactRoot = path.join(dataDir, "artifacts");
  const workspaceRoot = path.join(dataDir, "workspaces");
  const sessionsDir = path.join(dataDir, "sessions");
  const templateDir = path.resolve(process.cwd(), ".specrail-template");

  const eventStore = new JsonlEventStore(stateDir);
  const projectRepository = new FileProjectRepository(stateDir);
  const trackRepository = new FileTrackRepository(stateDir);
  const executionRepository = new FileExecutionRepository(stateDir);
  let service: SpecRailService | null = null;

  const serviceDependencies: SpecRailServiceDependencies = {
    projectRepository,
    trackRepository,
    executionRepository,
    eventStore,
    artifactWriter: {
      async write(input) {
        await materializeTrackArtifacts({
          rootDir: artifactRoot,
          repoVisibleRootDir: repoArtifactRoot,
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
    executor: new CodexAdapter({
      sessionsDir,
      onEvent: async (event) => {
        if (service) {
          await service.recordExecutionEvent(event);
          return;
        }

        await eventStore.append(event);
      },
    }),
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
      repoUrl: "https://github.com/yoophi-a/specrail",
      localRepoPath: process.cwd(),
      defaultWorkflowPolicy: "artifact-first-mvp",
    },
    workspaceRoot,
    githubRunCommentPublisher: githubPublishEnabled ? new GitHubRunCommentGhPublisher() : undefined,
  };

  service = new SpecRailService(serviceDependencies);

  return {
    artifactRoot,
    eventLogDir: getStatePaths(stateDir).eventsDir,
    serviceDependencies,
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: ApiErrorDetail[],
): void {
  sendJson(response, statusCode, {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function getPathSegments(request: IncomingMessage): string[] {
  return (request.url ?? "/")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
}

function getSearchParams(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://localhost").searchParams;
}

function writeSseEvent(response: ServerResponse, event: ExecutionEvent): void {
  response.write(`event: execution-event\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isTrackStatus(value: unknown): value is TrackStatus {
  return typeof value === "string" && TRACK_STATUSES.includes(value as TrackStatus);
}

function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && APPROVAL_STATUSES.includes(value as ApprovalStatus);
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    return Number.NaN;
  }

  return Number.parseInt(value, 10);
}

function buildListMeta(
  query: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: "asc" | "desc" },
  defaults: {
    sortBy: string;
    sortOrder: "asc" | "desc";
  },
  pagination: Pick<ListMeta, "total" | "totalPages" | "hasNextPage" | "hasPrevPage">,
): ListMeta {
  return {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 20,
    sortBy: query.sortBy ?? defaults.sortBy,
    sortOrder: query.sortOrder ?? defaults.sortOrder,
    ...pagination,
  };
}

function getNonEmptyStringDetail(field: string, value: unknown): ApiErrorDetail | null {
  if (typeof value !== "string") {
    return { field, message: "must be a string" };
  }

  if (!value.trim()) {
    return { field, message: "must not be empty" };
  }

  return null;
}

function getGitHubReferenceDetails(
  field: string,
  value: unknown,
): ApiErrorDetail[] {
  const details: ApiErrorDetail[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ field, message: "must be an object" }];
  }

  const numberValue = (value as { number?: unknown }).number;
  if (!Number.isInteger(numberValue) || (numberValue as number) < 1) {
    details.push({ field: `${field}.number`, message: "must be an integer greater than or equal to 1" });
  }

  const urlDetail = getNonEmptyStringDetail(`${field}.url`, (value as { url?: unknown }).url);
  if (urlDetail) {
    details.push(urlDetail);
  } else {
    const url = String((value as { url: string }).url).trim();
    if (!/^https:\/\/github\.com\/.+\/(issues|pull)\/\d+$/u.test(url)) {
      details.push({ field: `${field}.url`, message: "must be a valid GitHub issue or pull request URL" });
    }
  }

  return details;
}

function assertValidTrackCreateBody(body: TrackRequestBody): void {
  const details: ApiErrorDetail[] = [];

  const titleDetail = getNonEmptyStringDetail("title", body.title);
  if (titleDetail) {
    details.push(titleDetail);
  } else if (body.title.trim().length > 120) {
    details.push({ field: "title", message: "must be 120 characters or fewer" });
  }

  const descriptionDetail = getNonEmptyStringDetail("description", body.description);
  if (descriptionDetail) {
    details.push(descriptionDetail);
  } else if (body.description.trim().length > 4000) {
    details.push({ field: "description", message: "must be 4000 characters or fewer" });
  }

  if (body.priority !== undefined && !["low", "medium", "high"].includes(body.priority)) {
    details.push({ field: "priority", message: "must be one of low, medium, high" });
  }

  if (body.githubIssue !== undefined) {
    details.push(...getGitHubReferenceDetails("githubIssue", body.githubIssue));
  }

  if (body.githubPullRequest !== undefined) {
    details.push(...getGitHubReferenceDetails("githubPullRequest", body.githubPullRequest));
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidTrackUpdateBody(body: UpdateTrackRequestBody): void {
  const details: ApiErrorDetail[] = [];

  if (
    body.status === undefined &&
    body.specStatus === undefined &&
    body.planStatus === undefined &&
    body.githubIssue === undefined &&
    body.githubPullRequest === undefined
  ) {
    details.push({
      field: "body",
      message: "at least one of status, specStatus, planStatus, githubIssue, or githubPullRequest is required",
    });
  }

  if (body.status !== undefined && !isTrackStatus(body.status)) {
    details.push({ field: "status", message: "must be a valid track status" });
  }

  if (body.specStatus !== undefined && !isApprovalStatus(body.specStatus)) {
    details.push({ field: "specStatus", message: "must be a valid approval status" });
  }

  if (body.planStatus !== undefined && !isApprovalStatus(body.planStatus)) {
    details.push({ field: "planStatus", message: "must be a valid approval status" });
  }

  if (body.githubIssue !== undefined) {
    details.push(...getGitHubReferenceDetails("githubIssue", body.githubIssue));
  }

  if (body.githubPullRequest !== undefined) {
    details.push(...getGitHubReferenceDetails("githubPullRequest", body.githubPullRequest));
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidRunCreateBody(body: RunRequestBody): void {
  const details: ApiErrorDetail[] = [];

  const trackIdDetail = getNonEmptyStringDetail("trackId", body.trackId);
  if (trackIdDetail) {
    details.push(trackIdDetail);
  }

  const promptDetail = getNonEmptyStringDetail("prompt", body.prompt);
  if (promptDetail) {
    details.push(promptDetail);
  }

  if (body.profile !== undefined) {
    const profileDetail = getNonEmptyStringDetail("profile", body.profile);
    if (profileDetail) {
      details.push(profileDetail);
    }
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidResumeRunBody(body: ResumeRunRequestBody): void {
  const promptDetail = getNonEmptyStringDetail("prompt", body.prompt);

  if (promptDetail) {
    throw new RequestValidationError("request validation failed", [promptDetail]);
  }
}

function assertValidTrackListQuery(query: TrackListQuery): void {
  const details: ApiErrorDetail[] = [];

  if (query.status !== undefined && !isTrackStatus(query.status)) {
    details.push({ field: "status", message: "must be a valid track status" });
  }

  if (query.priority !== undefined && !["low", "medium", "high"].includes(query.priority)) {
    details.push({ field: "priority", message: "must be one of low, medium, high" });
  }

  if (query.page !== undefined && (!Number.isInteger(query.page) || query.page < 1)) {
    details.push({ field: "page", message: "must be an integer greater than or equal to 1" });
  }

  if (query.pageSize !== undefined && (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100)) {
    details.push({ field: "pageSize", message: "must be an integer between 1 and 100" });
  }

  if (query.sortBy !== undefined && !["updatedAt", "createdAt", "title", "priority", "status"].includes(query.sortBy)) {
    details.push({ field: "sortBy", message: "must be one of updatedAt, createdAt, title, priority, status" });
  }

  if (query.sortOrder !== undefined && !["asc", "desc"].includes(query.sortOrder)) {
    details.push({ field: "sortOrder", message: "must be one of asc, desc" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidRunListQuery(query: RunListQuery): void {
  const details: ApiErrorDetail[] = [];

  if (query.trackId !== undefined && !query.trackId.trim()) {
    details.push({ field: "trackId", message: "must not be empty" });
  }

  if (
    query.status !== undefined &&
    !["created", "queued", "running", "waiting_approval", "completed", "failed", "cancelled"].includes(query.status)
  ) {
    details.push({ field: "status", message: "must be a valid run status" });
  }

  if (query.page !== undefined && (!Number.isInteger(query.page) || query.page < 1)) {
    details.push({ field: "page", message: "must be an integer greater than or equal to 1" });
  }

  if (query.pageSize !== undefined && (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100)) {
    details.push({ field: "pageSize", message: "must be an integer between 1 and 100" });
  }

  if (query.sortBy !== undefined && !["createdAt", "startedAt", "finishedAt", "status"].includes(query.sortBy)) {
    details.push({ field: "sortBy", message: "must be one of createdAt, startedAt, finishedAt, status" });
  }

  if (query.sortOrder !== undefined && !["asc", "desc"].includes(query.sortOrder)) {
    details.push({ field: "sortOrder", message: "must be one of asc, desc" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

async function streamRunEvents(
  response: ServerResponse,
  service: SpecRailService,
  eventLogDir: string,
  runId: string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let closed = false;
  let offset = 0;
  let pendingLine = "";
  const eventLogPath = path.join(eventLogDir, `${runId}.jsonl`);

  const flushAppendedEvents = async (): Promise<void> => {
    const fileStat = await stat(eventLogPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });

    if (!fileStat || fileStat.size <= offset) {
      return;
    }

    const handle = await open(eventLogPath, "r");

    try {
      const chunkLength = fileStat.size - offset;
      const buffer = Buffer.alloc(chunkLength);
      const { bytesRead } = await handle.read(buffer, 0, chunkLength, offset);
      offset += bytesRead;

      pendingLine += buffer.subarray(0, bytesRead).toString("utf8");
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        writeSseEvent(response, JSON.parse(line) as ExecutionEvent);
      }
    } finally {
      await handle.close();
    }
  };

  const initialEvents = await service.listRunEvents(runId);
  for (const event of initialEvents) {
    writeSseEvent(response, event);
  }

  offset = (await stat(eventLogPath).catch(() => null))?.size ?? 0;
  response.write(`: connected\n\n`);

  const watcher = watch(eventLogDir, (_eventType, filename) => {
    if (closed || filename !== `${runId}.jsonl`) {
      return;
    }

    void flushAppendedEvents().catch(() => {
      close();
    });
  });

  const heartbeat = setInterval(() => {
    response.write(`: keep-alive\n\n`);
  }, 15000);

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    response.end();
  };

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
        assertValidTrackCreateBody(body);

        const track = await deps.service.createTrack(body);
        sendJson(response, 201, { track });
        return;
      }

      if (method === "GET" && segments.length === 1 && segments[0] === "tracks") {
        const searchParams = getSearchParams(request);
        const query: TrackListQuery = {
          status: (searchParams.get("status") ?? undefined) as TrackStatus | undefined,
          priority: (searchParams.get("priority") ?? undefined) as TrackRequestBody["priority"] | undefined,
          page: parsePositiveInteger(searchParams.get("page")),
          pageSize: parsePositiveInteger(searchParams.get("pageSize")),
          sortBy: (searchParams.get("sortBy") ?? undefined) as TrackListQuery["sortBy"],
          sortOrder: (searchParams.get("sortOrder") ?? undefined) as TrackListQuery["sortOrder"],
        };
        assertValidTrackListQuery(query);

        const trackPage = await deps.service.listTracksPage(query);
        sendJson(response, 200, {
          tracks: trackPage.items,
          meta: buildListMeta(query, { sortBy: "updatedAt", sortOrder: "desc" }, trackPage.meta),
        });
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "tracks") {
        const track = await deps.service.getTrack(segments[1] ?? "");

        if (!track) {
          sendError(response, 404, "not_found", "track not found");
          return;
        }

        const artifacts = await readTrackArtifacts(deps.artifactRoot, track.id);
        sendJson(response, 200, { track, artifacts });
        return;
      }

      if (method === "PATCH" && segments.length === 2 && segments[0] === "tracks") {
        const body = await readJson<UpdateTrackRequestBody>(request);
        assertValidTrackUpdateBody(body);

        const track = await deps.service.updateTrack({
          trackId: segments[1] ?? "",
          status: body.status,
          specStatus: body.specStatus,
          planStatus: body.planStatus,
          githubIssue: body.githubIssue,
          githubPullRequest: body.githubPullRequest,
        });
        sendJson(response, 200, { track });
        return;
      }

      if (method === "POST" && segments.length === 1 && segments[0] === "runs") {
        const body = await readJson<RunRequestBody>(request);
        assertValidRunCreateBody(body);

        const run = await deps.service.startRun(body);
        sendJson(response, 201, { run });
        return;
      }

      if (method === "GET" && segments.length === 1 && segments[0] === "runs") {
        const searchParams = getSearchParams(request);
        const query: RunListQuery = {
          trackId: searchParams.get("trackId") ?? undefined,
          status: (searchParams.get("status") ?? undefined) as RunListQuery["status"],
          page: parsePositiveInteger(searchParams.get("page")),
          pageSize: parsePositiveInteger(searchParams.get("pageSize")),
          sortBy: (searchParams.get("sortBy") ?? undefined) as RunListQuery["sortBy"],
          sortOrder: (searchParams.get("sortOrder") ?? undefined) as RunListQuery["sortOrder"],
        };
        assertValidRunListQuery(query);

        const runPage = await deps.service.listRunsPage(query);
        sendJson(response, 200, {
          runs: runPage.items,
          meta: buildListMeta(query, { sortBy: "createdAt", sortOrder: "desc" }, runPage.meta),
        });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "runs" && segments[2] === "resume") {
        const body = await readJson<ResumeRunRequestBody>(request);
        assertValidResumeRunBody(body);

        const run = await deps.service.resumeRun({ runId: segments[1] ?? "", prompt: body.prompt });
        sendJson(response, 200, { run });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
        const run = await deps.service.cancelRun({ runId: segments[1] ?? "" });
        sendJson(response, 200, { run });
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "runs") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendError(response, 404, "not_found", "run not found");
          return;
        }

        sendJson(response, 200, { run });
        return;
      }

      if (method === "GET" && segments.length === 4 && segments[0] === "runs" && segments[2] === "events" && segments[3] === "stream") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendError(response, 404, "not_found", "run not found");
          return;
        }

        await streamRunEvents(response, deps.service, deps.eventLogDir, run.id);
        return;
      }

      if (method === "GET" && segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendError(response, 404, "not_found", "run not found");
          return;
        }

        const events = await deps.service.listRunEvents(run.id);
        sendJson(response, 200, { events });
        return;
      }

      sendError(response, 404, "not_found", "not found");
    } catch (error) {
      if (error instanceof RequestValidationError) {
        sendError(response, error.statusCode, error.code, error.message, error.details);
        return;
      }

      if (error instanceof BadRequestError) {
        sendError(response, error.statusCode, error.code, error.message);
        return;
      }

      if (error instanceof NotFoundError) {
        sendError(response, 404, "not_found", error.message);
        return;
      }

      const message = error instanceof Error ? error.message : "unknown error";
      sendError(response, 500, "internal_error", message);
    }
  });
}

export function createDefaultServer(): http.Server {
  const config = loadConfig();
  const dependencies = createDependencies(config.dataDir, config.repoArtifactDir, config.githubPublishEnabled);

  return createSpecRailHttpServer({
    artifactRoot: dependencies.artifactRoot,
    eventLogDir: dependencies.eventLogDir,
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
