import { watch } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

import { ClaudeCodeAdapter, CodexAdapter } from "@specrail/adapters";
import { getTrackArtifactPaths, loadConfig, materializeTrackArtifacts, writeApprovedTrackArtifact } from "@specrail/config";
import {
  APPROVAL_STATUSES,
  APPROVAL_REQUEST_STATUSES,
  ARTIFACT_KINDS,
  ATTACHMENT_SOURCE_TYPES,
  CHANNEL_TYPES,
  PLANNING_SYSTEMS,
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
  NotFoundError,
  ValidationError,
  PLANNING_MESSAGE_KINDS,
  PLANNING_SESSION_STATUSES,
  getStatePaths,
  SpecRailService,
  TRACK_STATUSES,
  createExecutionWorkspaceManager,
  ExecutionWorkspaceCleanupApplier,
  planExecutionWorkspaceCleanup,
  type ExecutionWorkspaceMode,
  type ApplyExecutionWorkspaceCleanupResult,
  type ExecutionEvent,
  type ApprovalStatus,
  type ArtifactKind,
  type PlanningMessage,
  type PlanningMessageKind,
  type PlanningSystem,
  type PlanningSessionStatus,
  type SpecRailServiceDependencies,
  type TrackStatus,
} from "@specrail/core";

interface ApiDeps {
  artifactRoot: string;
  eventLogDir: string;
  service: SpecRailService;
  workspaceRoot: string;
  executionWorkspaceMode: ExecutionWorkspaceMode;
  localRepoPath?: string;
  cleanupApplier: ExecutionWorkspaceCleanupApplier;
}

interface TrackRequestBody {
  projectId?: string;
  title: string;
  description: string;
  priority?: "low" | "medium" | "high";
}

interface ProjectCreateRequestBody {
  name: string;
  repoUrl?: string;
  localRepoPath?: string;
  defaultWorkflowPolicy?: string;
  defaultPlanningSystem?: PlanningSystem;
}

interface ProjectUpdateRequestBody {
  name?: string;
  repoUrl?: string | null;
  localRepoPath?: string | null;
  defaultWorkflowPolicy?: string | null;
  defaultPlanningSystem?: PlanningSystem | null;
}

interface RunRequestBody {
  trackId: string;
  prompt: string;
  backend?: string;
  profile?: string;
  planningSessionId?: string;
}

interface UpdateTrackRequestBody {
  status?: TrackStatus;
  specStatus?: ApprovalStatus;
  planStatus?: ApprovalStatus;
}

interface CreatePlanningSessionRequestBody {
  status?: PlanningSessionStatus;
}

interface AppendPlanningMessageRequestBody {
  authorType: PlanningMessage["authorType"];
  kind?: PlanningMessageKind;
  body: string;
  relatedArtifact?: PlanningMessage["relatedArtifact"];
}

interface ResumeRunRequestBody {
  prompt: string;
  backend?: string;
  profile?: string;
}

const EXECUTION_BACKENDS = ["codex", "claude_code"] as const;

interface ProposeArtifactRevisionRequestBody {
  content: string;
  summary?: string;
  createdBy: "user" | "agent" | "system";
}

interface DecideApprovalRequestBody {
  decidedBy: "user" | "agent" | "system";
  comment?: string;
}

interface ResolveRuntimeApprovalRequestBody {
  decidedBy: "user" | "agent" | "system";
  comment?: string;
}

interface ApplyWorkspaceCleanupRequestBody {
  confirm: string;
}

interface BindChannelRequestBody {
  projectId: string;
  channelType: "telegram";
  externalChatId: string;
  externalThreadId?: string;
  externalUserId?: string;
  trackId?: string;
  planningSessionId?: string;
}

interface RegisterAttachmentRequestBody {
  sourceType: "telegram";
  externalFileId: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
  trackId?: string;
  planningSessionId?: string;
}

interface TrackListQuery {
  projectId?: string;
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
  workspaceRoot: string;
  executionWorkspaceMode: ExecutionWorkspaceMode;
  localRepoPath?: string;
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

function createDependencies(dataDir: string, repoArtifactRoot: string): DefaultDependencies {
  const config = loadConfig();
  const stateDir = path.join(dataDir, "state");
  const artifactRoot = path.join(dataDir, "artifacts");
  const workspaceRoot = path.join(dataDir, "workspaces");
  const sessionsDir = path.join(dataDir, "sessions");
  const templateDir = path.resolve(PROJECT_ROOT, ".specrail-template");

  const eventStore = new JsonlEventStore(stateDir);
  const projectRepository = new FileProjectRepository(stateDir);
  const trackRepository = new FileTrackRepository(stateDir);
  const planningSessionRepository = new FilePlanningSessionRepository(stateDir);
  const planningMessageStore = new JsonlPlanningMessageStore(stateDir);
  const artifactRevisionRepository = new FileArtifactRevisionRepository(stateDir);
  const approvalRequestRepository = new FileApprovalRequestRepository(stateDir);
  const channelBindingRepository = new FileChannelBindingRepository(stateDir);
  const attachmentReferenceRepository = new FileAttachmentReferenceRepository(stateDir);
  const executionRepository = new FileExecutionRepository(stateDir);
  let service: SpecRailService | null = null;

  const codexExecutor = new CodexAdapter({
    sessionsDir,
    onEvent: async (event) => {
      if (service) {
        await service.recordExecutionEvent(event);
        return;
      }

      await eventStore.append(event);
    },
  });

  const claudeCodeExecutor = new ClaudeCodeAdapter({
    sessionsDir,
    onEvent: async (event) => {
      if (service) {
        await service.recordExecutionEvent(event);
        return;
      }

      await eventStore.append(event);
    },
  });

  const serviceDependencies: SpecRailServiceDependencies = {
    projectRepository,
    trackRepository,
    planningSessionRepository,
    planningMessageStore,
    artifactRevisionRepository,
    approvalRequestRepository,
    channelBindingRepository,
    attachmentReferenceRepository,
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
      async writeApprovedArtifact(input) {
        await writeApprovedTrackArtifact({
          rootDir: artifactRoot,
          repoVisibleRootDir: repoArtifactRoot,
          trackId: input.track.id,
          artifact: input.artifact,
          content: input.content,
        });
      },
    },
    executor: codexExecutor,
    executors: {
      codex: codexExecutor,
      claude_code: claudeCodeExecutor,
    },
    defaultExecutionBackend: config.executionBackend,
    defaultExecutionProfile: config.executionProfile,
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
      repoUrl: "https://github.com/yoophi-a/specrail",
      localRepoPath: process.cwd(),
      defaultWorkflowPolicy: "artifact-first-mvp",
    },
    workspaceRoot,
    workspaceManager: createExecutionWorkspaceManager(config.executionWorkspaceMode),
  };

  service = new SpecRailService(serviceDependencies);

  return {
    artifactRoot,
    eventLogDir: getStatePaths(stateDir).eventsDir,
    workspaceRoot,
    executionWorkspaceMode: config.executionWorkspaceMode,
    localRepoPath: serviceDependencies.defaultProject.localRepoPath,
    serviceDependencies,
  };
}

function buildWorkspaceCleanupConfirmation(runId: string): string {
  return `apply workspace cleanup for ${runId}`;
}

function buildWorkspaceCleanupEvent(runId: string, result: ApplyExecutionWorkspaceCleanupResult): ExecutionEvent {
  const timestamp = new Date().toISOString();

  return {
    id: `${runId}:workspace-cleanup:${timestamp}`,
    executionId: runId,
    type: "summary",
    timestamp,
    source: "specrail",
    summary: `Workspace cleanup ${result.status} for execution ${runId}`,
    payload: {
      status: result.status,
      applied: result.applied,
      operationCount: result.operations.length,
      operations: result.operations,
      refusalReasons: result.refusalReasons,
    },
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

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function renderOperatorUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SpecRail Operator</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 2rem; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; display: grid; gap: 1rem; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 1.75rem; }
    section { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 0.75rem; padding: 1rem; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
    label { display: grid; gap: 0.35rem; font-weight: 600; }
    select, button { font: inherit; padding: 0.5rem 0.65rem; border-radius: 0.5rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
    button { cursor: pointer; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
    li { padding: 0.65rem; border-radius: 0.5rem; background: color-mix(in srgb, Canvas 90%, CanvasText 10%); }
    .muted { color: color-mix(in srgb, CanvasText 65%, transparent); }
    .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 999px; background: color-mix(in srgb, CanvasText 10%, transparent); font-size: 0.85em; }
    .detail-grid { display: grid; gap: 0.75rem; }
    .detail-grid dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 0.75rem; margin: 0; }
    .detail-grid dt { font-weight: 700; }
    .artifact-preview { max-height: 12rem; overflow: auto; padding: 0.65rem; border-radius: 0.5rem; background: color-mix(in srgb, Canvas 88%, CanvasText 12%); white-space: pre-wrap; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>SpecRail Operator</h1>
        <p class="muted">Thin hosted slice over the existing HTTP/SSE API.</p>
      </div>
      <button id="refresh">Refresh</button>
    </header>
    <section>
      <label>Project scope
        <select id="project-scope"><option value="">All projects</option></select>
      </label>
      <p id="status" class="muted">Loading…</p>
    </section>
    <div class="grid">
      <section><h2>Tracks</h2><ul id="tracks"></ul></section>
      <section><h2>Runs</h2><ul id="runs"></ul></section>
    </div>
    <section><h2>Selected detail</h2><div id="detail" class="muted">Select a track or run.</div></section>
  </main>
  <script type="module">
    const scope = document.querySelector('#project-scope');
    const status = document.querySelector('#status');
    const tracks = document.querySelector('#tracks');
    const runs = document.querySelector('#runs');
    const detail = document.querySelector('#detail');
    const refresh = document.querySelector('#refresh');

    async function api(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function item(label, meta, onClick) {
      const node = document.createElement('li');
      node.innerHTML = '<strong></strong><br><span class="muted"></span>';
      node.querySelector('strong').textContent = label;
      node.querySelector('span').textContent = meta;
      node.addEventListener('click', onClick);
      return node;
    }

    function text(value) {
      return value === undefined || value === null || value === '' ? 'unknown' : String(value);
    }

    function escapeHtml(value) {
      return text(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function metadata(fields) {
      return '<dl>' + fields.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('') + '</dl>';
    }

    function preview(label, value) {
      if (!value) return '';
      return '<h3>' + escapeHtml(label) + '</h3><div class="artifact-preview">' + escapeHtml(String(value).slice(0, 2000)) + '</div>';
    }

    function renderTrackDetail(payload) {
      const track = payload.track;
      const planning = payload.planningContext ?? {};
      detail.className = 'detail-grid';
      detail.innerHTML = '<h3>' + escapeHtml(track.title ?? track.id) + '</h3>'
        + metadata([
          ['Track ID', track.id],
          ['Project', track.projectId],
          ['Status', track.status],
          ['Priority', track.priority],
          ['Spec approval', track.specStatus],
          ['Plan approval', track.planStatus],
          ['Planning session', planning.planningSessionId],
          ['Pending planning changes', planning.hasPendingChanges ? 'yes' : 'no'],
          ['Updated', track.updatedAt],
        ])
        + preview('Spec preview', payload.artifacts?.spec)
        + preview('Plan preview', payload.artifacts?.plan)
        + preview('Tasks preview', payload.artifacts?.tasks);
    }

    function renderRunDetail(runPayload, eventsPayload) {
      const run = runPayload.run;
      const events = eventsPayload.events ?? [];
      detail.className = 'detail-grid';
      detail.innerHTML = '<h3>Run ' + escapeHtml(run.id) + '</h3>'
        + metadata([
          ['Run ID', run.id],
          ['Track ID', run.trackId],
          ['Status', run.status],
          ['Backend', run.backend],
          ['Profile', run.profile],
          ['Workspace', run.workspacePath],
          ['Branch', run.branchName],
          ['Planning session', run.planningSessionId],
          ['Started', run.startedAt],
          ['Finished', run.finishedAt],
        ])
        + '<h3>Recent events</h3><ul>' + events.slice(-10).map((event) => '<li><span class="pill">' + escapeHtml(event.type) + '</span> ' + escapeHtml(event.summary) + '<br><span class="muted">' + escapeHtml(event.timestamp) + '</span></li>').join('') + '</ul>';
    }

    async function loadTrackDetail(trackId) {
      detail.className = 'muted';
      detail.textContent = 'Loading track ' + trackId + '…';
      renderTrackDetail(await api('/tracks/' + encodeURIComponent(trackId)));
    }

    async function loadRunDetail(runId) {
      detail.className = 'muted';
      detail.textContent = 'Loading run ' + runId + '…';
      const [runPayload, eventsPayload] = await Promise.all([
        api('/runs/' + encodeURIComponent(runId)),
        api('/runs/' + encodeURIComponent(runId) + '/events'),
      ]);
      renderRunDetail(runPayload, eventsPayload);
    }

    async function load() {
      status.textContent = 'Loading…';
      const projectId = scope.value;
      const query = projectId ? '&projectId=' + encodeURIComponent(projectId) : '';
      const [projectPayload, trackPayload, runPayload] = await Promise.all([
        api('/projects'),
        api('/tracks?page=1&pageSize=20' + query),
        api('/runs?page=1&pageSize=20'),
      ]);

      const selectedProject = scope.value;
      scope.replaceChildren(new Option('All projects', ''), ...projectPayload.projects.map((project) => new Option(project.name + ' (' + project.id + ')', project.id)));
      scope.value = selectedProject;

      tracks.replaceChildren(...trackPayload.tracks.map((track) => item(
        track.title ?? track.id,
        track.id + ' · ' + (track.projectId ?? 'project?') + ' · ' + (track.status ?? 'unknown') + ' · ' + (track.priority ?? 'medium'),
        () => { loadTrackDetail(track.id).catch((error) => { detail.className = 'muted'; detail.textContent = error instanceof Error ? error.message : String(error); }); },
      )));
      runs.replaceChildren(...runPayload.runs.map((run) => item(
        run.id,
        run.trackId + ' · ' + (run.status ?? 'unknown') + ' · ' + (run.backend ?? 'backend?'),
        () => { loadRunDetail(run.id).catch((error) => { detail.className = 'muted'; detail.textContent = error instanceof Error ? error.message : String(error); }); },
      )));
      status.textContent = 'Loaded ' + projectPayload.projects.length + ' projects, ' + trackPayload.tracks.length + ' tracks, and ' + runPayload.runs.length + ' runs.';
    }

    scope.addEventListener('change', load);
    refresh.addEventListener('click', load);
    load().catch((error) => { status.textContent = error instanceof Error ? error.message : String(error); });
  </script>
</body>
</html>`;
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

function isPlanningSessionStatus(value: unknown): value is PlanningSessionStatus {
  return typeof value === "string" && PLANNING_SESSION_STATUSES.includes(value as PlanningSessionStatus);
}

function isPlanningMessageKind(value: unknown): value is PlanningMessageKind {
  return typeof value === "string" && PLANNING_MESSAGE_KINDS.includes(value as PlanningMessageKind);
}

function isPlanningSystem(value: unknown): value is PlanningSystem {
  return typeof value === "string" && PLANNING_SYSTEMS.includes(value as PlanningSystem);
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.includes(value as ArtifactKind);
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

  if (body.projectId !== undefined && !body.projectId.trim()) {
    details.push({ field: "projectId", message: "must not be empty" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidProjectCreateBody(body: ProjectCreateRequestBody): void {
  const details: ApiErrorDetail[] = [];

  const nameDetail = getNonEmptyStringDetail("name", body.name);
  if (nameDetail) {
    details.push(nameDetail);
  } else if (body.name.trim().length > 120) {
    details.push({ field: "name", message: "must be 120 characters or fewer" });
  }

  for (const field of ["repoUrl", "localRepoPath", "defaultWorkflowPolicy"] as const) {
    if (body[field] !== undefined) {
      const detail = getNonEmptyStringDetail(field, body[field]);
      if (detail) {
        details.push(detail);
      }
    }
  }

  if (body.defaultPlanningSystem !== undefined && !isPlanningSystem(body.defaultPlanningSystem)) {
    details.push({ field: "defaultPlanningSystem", message: `must be one of: ${PLANNING_SYSTEMS.join(", ")}` });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidProjectUpdateBody(body: ProjectUpdateRequestBody): void {
  const details: ApiErrorDetail[] = [];

  if (
    body.name === undefined &&
    body.repoUrl === undefined &&
    body.localRepoPath === undefined &&
    body.defaultWorkflowPolicy === undefined &&
    body.defaultPlanningSystem === undefined
  ) {
    details.push({ field: "body", message: "at least one project field is required" });
  }

  if (body.name !== undefined) {
    const nameDetail = getNonEmptyStringDetail("name", body.name);
    if (nameDetail) {
      details.push(nameDetail);
    } else if (body.name.trim().length > 120) {
      details.push({ field: "name", message: "must be 120 characters or fewer" });
    }
  }

  for (const field of ["repoUrl", "localRepoPath", "defaultWorkflowPolicy"] as const) {
    if (body[field] !== undefined && body[field] !== null) {
      const detail = getNonEmptyStringDetail(field, body[field]);
      if (detail) {
        details.push(detail);
      }
    }
  }

  if (body.defaultPlanningSystem !== undefined && body.defaultPlanningSystem !== null && !isPlanningSystem(body.defaultPlanningSystem)) {
    details.push({ field: "defaultPlanningSystem", message: `must be one of: ${PLANNING_SYSTEMS.join(", ")}` });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidTrackUpdateBody(body: UpdateTrackRequestBody): void {
  const details: ApiErrorDetail[] = [];

  if (body.status === undefined && body.specStatus === undefined && body.planStatus === undefined) {
    details.push({ field: "body", message: "at least one of status, specStatus, or planStatus is required" });
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

  if (body.backend !== undefined) {
    const backendDetail = getNonEmptyStringDetail("backend", body.backend);
    if (backendDetail) {
      details.push(backendDetail);
    } else if (!EXECUTION_BACKENDS.includes(body.backend as (typeof EXECUTION_BACKENDS)[number])) {
      details.push({ field: "backend", message: `must be one of: ${EXECUTION_BACKENDS.join(", ")}` });
    }
  }

  if (body.profile !== undefined) {
    const profileDetail = getNonEmptyStringDetail("profile", body.profile);
    if (profileDetail) {
      details.push(profileDetail);
    }
  }

  if (body.planningSessionId !== undefined) {
    const planningSessionIdDetail = getNonEmptyStringDetail("planningSessionId", body.planningSessionId);
    if (planningSessionIdDetail) {
      details.push(planningSessionIdDetail);
    }
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidCreatePlanningSessionBody(body: CreatePlanningSessionRequestBody): void {
  const details: ApiErrorDetail[] = [];

  if (body.status !== undefined && !isPlanningSessionStatus(body.status)) {
    details.push({
      field: "status",
      message: `status must be one of: ${PLANNING_SESSION_STATUSES.join(", ")}`,
    });
  }

  if (details.length > 0) {
    throw new RequestValidationError("invalid planning session payload", details);
  }
}

function assertValidAppendPlanningMessageBody(body: AppendPlanningMessageRequestBody): void {
  const details: ApiErrorDetail[] = [];

  if (body.authorType !== "user" && body.authorType !== "agent" && body.authorType !== "system") {
    details.push({ field: "authorType", message: "authorType must be one of: user, agent, system" });
  }

  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    details.push({ field: "body", message: "body is required" });
  }

  if (body.kind !== undefined && !isPlanningMessageKind(body.kind)) {
    details.push({ field: "kind", message: `kind must be one of: ${PLANNING_MESSAGE_KINDS.join(", ")}` });
  }

  if (body.relatedArtifact !== undefined && !["spec", "plan", "tasks"].includes(body.relatedArtifact)) {
    details.push({ field: "relatedArtifact", message: "relatedArtifact must be one of: spec, plan, tasks" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("invalid planning message payload", details);
  }
}

function assertValidResumeRunBody(body: ResumeRunRequestBody): void {
  const details: ApiErrorDetail[] = [];

  const promptDetail = getNonEmptyStringDetail("prompt", body.prompt);

  if (promptDetail) {
    details.push(promptDetail);
  }

  if (body.backend !== undefined) {
    const backendDetail = getNonEmptyStringDetail("backend", body.backend);
    if (backendDetail) {
      details.push(backendDetail);
    } else if (!EXECUTION_BACKENDS.includes(body.backend as (typeof EXECUTION_BACKENDS)[number])) {
      details.push({ field: "backend", message: `must be one of: ${EXECUTION_BACKENDS.join(", ")}` });
    }
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

function assertValidProposeArtifactRevisionBody(body: ProposeArtifactRevisionRequestBody): void {
  const details: ApiErrorDetail[] = [];
  const contentDetail = getNonEmptyStringDetail("content", body.content);
  if (contentDetail) {
    details.push(contentDetail);
  }

  if (body.summary !== undefined) {
    const summaryDetail = getNonEmptyStringDetail("summary", body.summary);
    if (summaryDetail) {
      details.push(summaryDetail);
    }
  }

  if (body.createdBy !== "user" && body.createdBy !== "agent" && body.createdBy !== "system") {
    details.push({ field: "createdBy", message: "createdBy must be one of: user, agent, system" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidDecideApprovalRequestBody(body: DecideApprovalRequestBody): void {
  const details = getDecisionBodyValidationDetails(body);

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidResolveRuntimeApprovalRequestBody(body: ResolveRuntimeApprovalRequestBody): void {
  const details = getDecisionBodyValidationDetails(body);

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function getDecisionBodyValidationDetails(body: DecideApprovalRequestBody | ResolveRuntimeApprovalRequestBody): ApiErrorDetail[] {
  const details: ApiErrorDetail[] = [];

  if (body.decidedBy !== "user" && body.decidedBy !== "agent" && body.decidedBy !== "system") {
    details.push({ field: "decidedBy", message: "decidedBy must be one of: user, agent, system" });
  }

  if (body.comment !== undefined) {
    const commentDetail = getNonEmptyStringDetail("comment", body.comment);
    if (commentDetail) {
      details.push(commentDetail);
    }
  }

  return details;
}

function assertValidBindChannelBody(body: BindChannelRequestBody): void {
  const details: ApiErrorDetail[] = [];

  for (const field of ["projectId", "externalChatId"] as const) {
    const detail = getNonEmptyStringDetail(field, body[field]);
    if (detail) {
      details.push(detail);
    }
  }

  if (!CHANNEL_TYPES.includes(body.channelType)) {
    details.push({ field: "channelType", message: `must be one of: ${CHANNEL_TYPES.join(", ")}` });
  }

  for (const field of ["externalThreadId", "externalUserId", "trackId", "planningSessionId"] as const) {
    if (body[field] !== undefined) {
      const detail = getNonEmptyStringDetail(field, body[field]);
      if (detail) {
        details.push(detail);
      }
    }
  }

  if (body.trackId === undefined && body.planningSessionId === undefined) {
    details.push({ field: "body", message: "trackId or planningSessionId is required" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
  }
}

function assertValidRegisterAttachmentBody(body: RegisterAttachmentRequestBody): void {
  const details: ApiErrorDetail[] = [];

  if (!ATTACHMENT_SOURCE_TYPES.includes(body.sourceType)) {
    details.push({ field: "sourceType", message: `must be one of: ${ATTACHMENT_SOURCE_TYPES.join(", ")}` });
  }

  const externalFileIdDetail = getNonEmptyStringDetail("externalFileId", body.externalFileId);
  if (externalFileIdDetail) {
    details.push(externalFileIdDetail);
  }

  for (const field of ["fileName", "mimeType", "localPath", "trackId", "planningSessionId"] as const) {
    if (body[field] !== undefined) {
      const detail = getNonEmptyStringDetail(field, body[field]);
      if (detail) {
        details.push(detail);
      }
    }
  }

  if (body.trackId === undefined && body.planningSessionId === undefined) {
    details.push({ field: "body", message: "trackId or planningSessionId is required" });
  }

  if (details.length > 0) {
    throw new RequestValidationError("request validation failed", details);
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

  if (query.projectId !== undefined && !query.projectId.trim()) {
    details.push({ field: "projectId", message: "must not be empty" });
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
  let flushInFlight: Promise<void> | null = null;
  const sentEventIds = new Set<string>();
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

        const event = JSON.parse(line) as ExecutionEvent;
        if (sentEventIds.has(event.id)) {
          continue;
        }

        sentEventIds.add(event.id);
        writeSseEvent(response, event);
      }
    } finally {
      await handle.close();
    }
  };

  const scheduleFlush = (): void => {
    if (closed || flushInFlight) {
      return;
    }

    flushInFlight = flushAppendedEvents()
      .catch(() => {
        close();
      })
      .finally(() => {
        flushInFlight = null;
      });
  };

  const initialEvents = await service.listRunEvents(runId);
  for (const event of initialEvents) {
    sentEventIds.add(event.id);
    writeSseEvent(response, event);
  }

  response.write(`: connected\n\n`);
  scheduleFlush();

  const watcher = watch(eventLogDir, (_eventType, filename) => {
    if (closed || filename !== `${runId}.jsonl`) {
      return;
    }

    scheduleFlush();
  });

  const poller = setInterval(scheduleFlush, 250);

  const heartbeat = setInterval(() => {
    response.write(`: keep-alive\n\n`);
  }, 15000);

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(heartbeat);
    clearInterval(poller);
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

      if (method === "GET" && segments.length === 1 && segments[0] === "operator") {
        sendHtml(response, 200, renderOperatorUiHtml());
        return;
      }

      if (method === "GET" && segments.length === 1 && segments[0] === "projects") {
        const projects = await deps.service.listProjects();
        sendJson(response, 200, { projects });
        return;
      }

      if (method === "POST" && segments.length === 1 && segments[0] === "projects") {
        const body = await readJson<ProjectCreateRequestBody>(request);
        assertValidProjectCreateBody(body);

        const project = await deps.service.createProject(body);
        sendJson(response, 201, { project });
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "projects") {
        const project = await deps.service.getProject(segments[1] ?? "");
        if (!project) {
          sendError(response, 404, "not_found", "project not found");
          return;
        }

        sendJson(response, 200, { project });
        return;
      }

      if (method === "PATCH" && segments.length === 2 && segments[0] === "projects") {
        const body = await readJson<ProjectUpdateRequestBody>(request);
        assertValidProjectUpdateBody(body);

        const project = await deps.service.updateProject({
          projectId: segments[1] ?? "",
          name: body.name,
          repoUrl: body.repoUrl,
          localRepoPath: body.localRepoPath,
          defaultWorkflowPolicy: body.defaultWorkflowPolicy,
          defaultPlanningSystem: body.defaultPlanningSystem,
        });
        sendJson(response, 200, { project });
        return;
      }

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
          projectId: searchParams.get("projectId") ?? undefined,
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
        const planningContext = await deps.service.getTrackPlanningContext(track.id);
        sendJson(response, 200, { track, artifacts, planningContext });
        return;
      }

      if (method === "POST" && segments.length === 4 && segments[0] === "tracks" && segments[2] === "artifacts") {
        const artifact = segments[3];
        if (!isArtifactKind(artifact)) {
          sendError(response, 404, "not_found", "not found");
          return;
        }

        const body = await readJson<ProposeArtifactRevisionRequestBody>(request);
        assertValidProposeArtifactRevisionBody(body);

        const result = await deps.service.proposeArtifactRevision({
          trackId: segments[1] ?? "",
          artifact,
          content: body.content,
          summary: body.summary,
          createdBy: body.createdBy,
        });
        sendJson(response, 201, result);
        return;
      }

      if (method === "GET" && segments.length === 4 && segments[0] === "tracks" && segments[2] === "artifacts") {
        const artifact = segments[3];
        if (!isArtifactKind(artifact)) {
          sendError(response, 404, "not_found", "not found");
          return;
        }

        const track = await deps.service.getTrack(segments[1] ?? "");
        if (!track) {
          sendError(response, 404, "not_found", "track not found");
          return;
        }

        const [revisions, approvalRequests] = await Promise.all([
          deps.service.listArtifactRevisions(track.id, artifact),
          deps.service.listApprovalRequests(track.id, artifact),
        ]);
        sendJson(response, 200, { revisions, approvalRequests });
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
        });
        sendJson(response, 200, { track });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "tracks" && segments[2] === "planning-sessions") {
        const body = await readJson<CreatePlanningSessionRequestBody>(request);
        assertValidCreatePlanningSessionBody(body);

        const planningSession = await deps.service.createPlanningSession({
          trackId: segments[1] ?? "",
          status: body.status,
        });
        sendJson(response, 201, { planningSession });
        return;
      }

      if (method === "GET" && segments.length === 3 && segments[0] === "tracks" && segments[2] === "planning-sessions") {
        const track = await deps.service.getTrack(segments[1] ?? "");

        if (!track) {
          sendError(response, 404, "not_found", "track not found");
          return;
        }

        const planningSessions = await deps.service.listPlanningSessions(track.id);
        sendJson(response, 200, { planningSessions });
        return;
      }

      if (method === "GET" && segments.length === 2 && segments[0] === "planning-sessions") {
        const planningSession = await deps.service.getPlanningSession(segments[1] ?? "");

        if (!planningSession) {
          sendError(response, 404, "not_found", "planning session not found");
          return;
        }

        sendJson(response, 200, { planningSession });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "planning-sessions" && segments[2] === "messages") {
        const body = await readJson<AppendPlanningMessageRequestBody>(request);
        assertValidAppendPlanningMessageBody(body);

        const message = await deps.service.appendPlanningMessage({
          planningSessionId: segments[1] ?? "",
          authorType: body.authorType,
          kind: body.kind,
          body: body.body,
          relatedArtifact: body.relatedArtifact,
        });
        sendJson(response, 201, { message });
        return;
      }

      if (method === "GET" && segments.length === 3 && segments[0] === "planning-sessions" && segments[2] === "messages") {
        const messages = await deps.service.listPlanningMessages(segments[1] ?? "");
        sendJson(response, 200, { messages });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "approval-requests" && segments[2] === "approve") {
        const body = await readJson<DecideApprovalRequestBody>(request);
        assertValidDecideApprovalRequestBody(body);
        const approvalRequest = await deps.service.approveApprovalRequest({
          approvalRequestId: segments[1] ?? "",
          decidedBy: body.decidedBy,
          comment: body.comment,
        });
        sendJson(response, 200, { approvalRequest });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "approval-requests" && segments[2] === "reject") {
        const body = await readJson<DecideApprovalRequestBody>(request);
        assertValidDecideApprovalRequestBody(body);
        const approvalRequest = await deps.service.rejectApprovalRequest({
          approvalRequestId: segments[1] ?? "",
          decidedBy: body.decidedBy,
          comment: body.comment,
        });
        sendJson(response, 200, { approvalRequest });
        return;
      }

      if (
        method === "POST" &&
        segments.length === 5 &&
        segments[0] === "runs" &&
        segments[2] === "approval-requests" &&
        (segments[4] === "approve" || segments[4] === "reject")
      ) {
        const body = await readJson<ResolveRuntimeApprovalRequestBody>(request);
        assertValidResolveRuntimeApprovalRequestBody(body);
        const result = await deps.service.resolveRuntimeApprovalRequest({
          runId: segments[1] ?? "",
          requestId: segments[3] ?? "",
          outcome: segments[4] === "approve" ? "approved" : "rejected",
          decidedBy: body.decidedBy,
          comment: body.comment,
        });
        sendJson(response, 200, { event: result.event });
        return;
      }

      if (method === "POST" && segments.length === 1 && segments[0] === "channel-bindings") {
        const body = await readJson<BindChannelRequestBody>(request);
        assertValidBindChannelBody(body);
        const binding = await deps.service.bindChannel(body);
        sendJson(response, 201, { binding });
        return;
      }

      if (method === "GET" && segments.length === 1 && segments[0] === "channel-bindings") {
        const searchParams = getSearchParams(request);
        const channelType = searchParams.get("channelType");
        const externalChatId = searchParams.get("externalChatId");
        const externalThreadId = searchParams.get("externalThreadId") ?? undefined;

        if (!channelType || !externalChatId || !CHANNEL_TYPES.includes(channelType as "telegram")) {
          throw new RequestValidationError("request validation failed", [
            { field: "channelType", message: `must be one of: ${CHANNEL_TYPES.join(", ")}` },
            { field: "externalChatId", message: "must not be empty" },
          ].filter((detail, index) => (index === 0 ? !channelType || !CHANNEL_TYPES.includes(channelType as "telegram") : !externalChatId)));
        }

        const binding = await deps.service.findChannelBindingByExternalRef({
          channelType: channelType as "telegram",
          externalChatId,
          externalThreadId,
        });

        if (!binding) {
          sendError(response, 404, "not_found", "channel binding not found");
          return;
        }

        sendJson(response, 200, { binding });
        return;
      }

      if (method === "POST" && segments.length === 1 && segments[0] === "attachments") {
        const body = await readJson<RegisterAttachmentRequestBody>(request);
        assertValidRegisterAttachmentBody(body);
        const attachment = await deps.service.registerAttachmentReference(body);
        sendJson(response, 201, { attachment });
        return;
      }

      if (method === "GET" && segments.length === 1 && segments[0] === "attachments") {
        const searchParams = getSearchParams(request);
        const trackId = searchParams.get("trackId") ?? undefined;
        const planningSessionId = searchParams.get("planningSessionId") ?? undefined;

        if (!trackId && !planningSessionId) {
          throw new RequestValidationError("request validation failed", [
            { field: "query", message: "trackId or planningSessionId is required" },
          ]);
        }

        const attachments = await deps.service.listAttachmentReferences({ trackId, planningSessionId });
        sendJson(response, 200, { attachments });
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

        const run = await deps.service.resumeRun({
          runId: segments[1] ?? "",
          prompt: body.prompt,
          backend: body.backend,
          profile: body.profile,
        });
        sendJson(response, 200, { run });
        return;
      }

      if (method === "POST" && segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
        const run = await deps.service.cancelRun({ runId: segments[1] ?? "" });
        sendJson(response, 200, { run });
        return;
      }

      if (method === "GET" && segments.length === 4 && segments[0] === "runs" && segments[2] === "workspace-cleanup" && segments[3] === "preview") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendError(response, 404, "not_found", "run not found");
          return;
        }

        const cleanupPlan = planExecutionWorkspaceCleanup({
          execution: run,
          workspaceRoot: deps.workspaceRoot,
          mode: deps.executionWorkspaceMode,
          localRepoPath: deps.localRepoPath,
        });
        sendJson(response, 200, { cleanupPlan });
        return;
      }

      if (method === "POST" && segments.length === 4 && segments[0] === "runs" && segments[2] === "workspace-cleanup" && segments[3] === "apply") {
        const run = await deps.service.getRun(segments[1] ?? "");

        if (!run) {
          sendError(response, 404, "not_found", "run not found");
          return;
        }

        const body = await readJson<ApplyWorkspaceCleanupRequestBody>(request);
        const expectedConfirmation = buildWorkspaceCleanupConfirmation(run.id);
        const cleanupPlan = planExecutionWorkspaceCleanup({
          execution: run,
          workspaceRoot: deps.workspaceRoot,
          mode: deps.executionWorkspaceMode,
          localRepoPath: deps.localRepoPath,
        });
        const cleanupResult = await deps.cleanupApplier.apply({
          plan: cleanupPlan,
          confirm: body.confirm === expectedConfirmation,
        });
        await deps.service.recordExecutionEvent(buildWorkspaceCleanupEvent(run.id, cleanupResult));
        sendJson(response, 200, { cleanupResult, expectedConfirmation });
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

      if (error instanceof ValidationError) {
        sendError(response, 422, "validation_error", error.message);
        return;
      }

      const message = error instanceof Error ? error.message : "unknown error";
      sendError(response, 500, "internal_error", message);
    }
  });
}

export function createDefaultServer(): http.Server {
  const config = loadConfig();
  const dependencies = createDependencies(config.dataDir, config.repoArtifactDir);

  return createSpecRailHttpServer({
    artifactRoot: dependencies.artifactRoot,
    eventLogDir: dependencies.eventLogDir,
    service: new SpecRailService(dependencies.serviceDependencies),
    workspaceRoot: dependencies.workspaceRoot,
    executionWorkspaceMode: dependencies.executionWorkspaceMode,
    localRepoPath: dependencies.localRepoPath,
    cleanupApplier: new ExecutionWorkspaceCleanupApplier(),
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
