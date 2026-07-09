import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadTerminalClientConfig, type SpecRailTerminalClientConfig } from "@specrail/config";

export type TerminalScreenId = "home" | "tracks" | "runs" | "settings";
export type RunEventConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "paused" | "closed" | "error";
export type RunFilterMode = "all" | "active" | "terminal";
export type ArtifactKind = "spec" | "plan" | "tasks";
export type ExecutionActionKind = "start" | "resume" | "fork" | "cancel";
export type PlanningSessionStatus = "active" | "waiting_user" | "waiting_agent" | "approved" | "archived";
export type PlanningMessageTemplateKind = "message" | "question" | "decision" | "note";
const PLANNING_MESSAGE_TEMPLATE_KINDS = ["message", "question", "decision", "note"] as const satisfies readonly PlanningMessageTemplateKind[];
const PLANNING_MESSAGE_TEMPLATE_ARTIFACTS = ["none", "spec", "plan", "tasks"] as const satisfies readonly (ArtifactKind | "none")[];

export interface PlanningMessageTemplate {
  name: string;
  kind: PlanningMessageTemplateKind;
  relatedArtifact: ArtifactKind | "none";
  body: string;
}

export interface RevisionDiffExportManifestEntry {
  exportedAt: string;
  filePath: string;
  trackId: string;
  artifact: ArtifactKind;
  revisionId: string;
  version: number;
}

const EXECUTION_BACKEND_OPTIONS = ["codex", "claude_code"] as const;
const PLANNING_SESSION_STATUS_OPTIONS = ["active", "waiting_user", "waiting_agent", "approved", "archived"] as const;
const EXECUTION_PROFILE_OPTIONS: Record<string, string[]> = {
  codex: ["default", "gpt-5.4", "gpt-5.4-mini"],
  claude_code: ["default", "sonnet", "opus"],
};
const REFRESH_INTERVAL_STEP_MS = 1_000;
const MAX_REFRESH_INTERVAL_MS = 60_000;

const PLANNING_MESSAGE_TEMPLATES = [
  {
    name: "handoff",
    kind: "note",
    relatedArtifact: "plan",
    body: "Handoff:\n- Current state:\n- Next step:\n- Blocker/risk:",
  },
  {
    name: "question",
    kind: "question",
    relatedArtifact: "spec",
    body: "Question:\n- What needs a decision?\n- Options considered:\n- Recommended answer:",
  },
  {
    name: "decision",
    kind: "decision",
    relatedArtifact: "plan",
    body: "Decision:\n- Chosen direction:\n- Reason:\n- Follow-up:",
  },
  {
    name: "test note",
    kind: "note",
    relatedArtifact: "tasks",
    body: "Test note:\n- Command:\n- Result:\n- Remaining coverage:",
  },
] as const satisfies readonly PlanningMessageTemplate[];

function nextPlanningSessionStatus(status: PlanningSessionStatus): PlanningSessionStatus {
  const currentIndex = PLANNING_SESSION_STATUS_OPTIONS.findIndex((candidate) => candidate === status);
  return PLANNING_SESSION_STATUS_OPTIONS[(currentIndex + 1 + PLANNING_SESSION_STATUS_OPTIONS.length) % PLANNING_SESSION_STATUS_OPTIONS.length] ?? status;
}

function isPlanningMessageTemplateKind(value: unknown): value is PlanningMessageTemplateKind {
  return typeof value === "string" && PLANNING_MESSAGE_TEMPLATE_KINDS.includes(value as PlanningMessageTemplateKind);
}

function isPlanningMessageTemplateArtifact(value: unknown): value is PlanningMessageTemplate["relatedArtifact"] {
  return typeof value === "string" && PLANNING_MESSAGE_TEMPLATE_ARTIFACTS.includes(value as PlanningMessageTemplate["relatedArtifact"]);
}

function normalizePlanningMessageTemplateEnum(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

export function parsePlanningMessageTemplatesJson(content: string, source = "planning message template file"): PlanningMessageTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid ${source}: ${error instanceof Error ? error.message : "malformed JSON"}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Invalid ${source}: expected a non-empty JSON array of templates.`);
  }

  return parsed.map((item, index) => {
    const prefix = `Invalid ${source} at index ${index}`;
    if (!item || typeof item !== "object") {
      throw new Error(`${prefix}: expected an object.`);
    }

    const template = item as Partial<PlanningMessageTemplate>;
    const kind = normalizePlanningMessageTemplateEnum(template.kind);
    const relatedArtifact = normalizePlanningMessageTemplateEnum(template.relatedArtifact);
    if (typeof template.name !== "string" || template.name.trim().length === 0) {
      throw new Error(`${prefix}: name must be a non-empty string.`);
    }
    if (!isPlanningMessageTemplateKind(kind)) {
      throw new Error(`${prefix}: kind must be one of message, question, decision, note.`);
    }
    if (!isPlanningMessageTemplateArtifact(relatedArtifact)) {
      throw new Error(`${prefix}: relatedArtifact must be one of none, spec, plan, tasks.`);
    }
    if (typeof template.body !== "string" || template.body.trim().length === 0) {
      throw new Error(`${prefix}: body must be a non-empty string.`);
    }

    return {
      name: template.name.trim(),
      kind,
      relatedArtifact,
      body: template.body,
    };
  });
}

async function loadPlanningMessageTemplates(path: string | null): Promise<PlanningMessageTemplate[]> {
  if (!path) {
    return [...PLANNING_MESSAGE_TEMPLATES];
  }

  const content = await readFile(path, "utf8");
  return parsePlanningMessageTemplatesJson(content, path);
}

export interface TrackListItem {
  id: string;
  projectId?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  specStatus?: string;
  planStatus?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  localRepoPath?: string;
  defaultPlanningSystem?: string;
  updatedAt?: string;
}

export interface RunListItem {
  id: string;
  trackId: string;
  status: string;
  backend?: string;
  profile?: string;
  branchName?: string;
  workspacePath?: string;
  sessionRef?: string;
  parentExecutionId?: string;
  parentSessionRef?: string;
  continuityMode?: string;
  sourceRunId?: string;
  planningSessionId?: string;
  planningContextStale?: boolean;
  planningContextUpdatedAt?: string;
  planningContextStaleReason?: string;
  summary?: {
    eventCount: number;
    lastEventSummary?: string;
    lastEventAt?: string;
  };
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ExecutionEvent {
  id: string;
  executionId: string;
  type: string;
  subtype?: string;
  timestamp: string;
  source: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface RunSessionPreview {
  execution: RunListItem;
  session?: { sessionRef?: string; providerSessionId?: string; resumeSessionRef?: string } | null;
  capabilities?: { supportsResume?: boolean; supportsProviderFork?: boolean; supportsContextCopyFork?: boolean };
  events: ExecutionEvent[];
  reportPath?: string;
}

export interface WorkspaceCleanupOperation {
  kind: "remove_directory" | "git_worktree_remove" | "git_branch_delete";
  path?: string;
  branchName?: string;
  command?: string;
}

export interface WorkspaceCleanupPlan {
  dryRun: true;
  eligible: boolean;
  operations: WorkspaceCleanupOperation[];
  refusalReasons: string[];
}

export interface WorkspaceCleanupPreviewResponse {
  cleanupPlan: WorkspaceCleanupPlan;
}

export interface AppliedWorkspaceCleanupOperation extends WorkspaceCleanupOperation {
  status: "applied" | "failed";
  error?: string;
}

export interface WorkspaceCleanupApplyResult {
  applied: boolean;
  status: "applied" | "refused" | "failed";
  operations: AppliedWorkspaceCleanupOperation[];
  refusalReasons: string[];
}

export interface WorkspaceCleanupApplyResponse {
  cleanupResult: WorkspaceCleanupApplyResult;
  expectedConfirmation: string;
}

export interface PlanningSessionSummary {
  id: string;
  trackId: string;
  status: string;
  latestRevisionId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlanningMessage {
  id: string;
  planningSessionId: string;
  authorType: string;
  kind: string;
  relatedArtifact?: ArtifactKind;
  body: string;
  createdAt: string;
}

export interface ArtifactRevisionSummary {
  id: string;
  trackId: string;
  artifact: ArtifactKind;
  version: number;
  createdBy: string;
  content: string;
  approvalRequestId?: string;
  approvedAt?: string;
  createdAt: string;
}

export interface ApprovalRequestSummary {
  id: string;
  trackId: string;
  artifact: ArtifactKind;
  revisionId: string;
  status: string;
  requestedBy: string;
  decisionNote?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface TrackPlanningWorkspace {
  planningSessions: PlanningSessionSummary[];
  planningMessages: PlanningMessage[];
  revisions: Record<ArtifactKind, ArtifactRevisionSummary[]>;
  approvalRequests: Record<ArtifactKind, ApprovalRequestSummary[]>;
  selectedPlanningSessionId?: string;
  selectedArtifact: ArtifactKind;
  selectedRevisionId?: string;
  selectedApprovalRequestId?: string;
}

export interface TrackDetailSnapshot {
  track: TrackListItem;
  artifacts: {
    spec: string;
    plan: string;
    tasks: string;
  };
  planningContext?: {
    planningSessionId?: string;
    specRevisionId?: string;
    planRevisionId?: string;
    tasksRevisionId?: string;
    hasPendingChanges?: boolean;
    updatedAt?: string;
  };
  planningWorkspace?: TrackPlanningWorkspace;
}

export interface RunDetailSnapshot {
  run: RunListItem;
}

export interface TerminalSummarySnapshot {
  projects?: ProjectListItem[];
  tracks: TrackListItem[];
  runs: RunListItem[];
  fetchedAt: string;
}

export interface DetailPanelState<T> {
  selectedId: string | null;
  selectedIndex: number;
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface RunEventFeedState {
  runId: string | null;
  items: ExecutionEvent[];
  connection: RunEventConnectionState;
  paused: boolean;
  reconnectAttempts: number;
  lastError: string | null;
  lastEventAt: string | null;
}

export interface PendingTrackActionState {
  kind: "approve" | "reject";
  approvalRequestId: string;
}

export interface PendingExecutionActionState {
  kind: ExecutionActionKind;
  scope: "track" | "run";
  trackId?: string;
  runId?: string;
  planningSessionId?: string;
  backend: string;
  profile: string;
  prompt: string;
  workspacePath?: string;
  activeField?: "prompt" | "workspacePath";
  folderSessions?: RunListItem[];
  selectedFolderSessionIndex?: number;
  folderSessionPreview?: RunSessionPreview | null;
  submitting: boolean;
  message: string | null;
}

export interface PendingProposalActionState {
  trackId: string;
  artifact: ArtifactKind;
  summary: string;
  content: string;
  createdBy: "user" | "agent" | "system";
  activeField: "summary" | "content";
  submitting: boolean;
  message: string | null;
}

export interface PendingPlanningMessageActionState {
  trackId: string;
  planningSessionId: string;
  authorType: "user" | "agent" | "system";
  kind: "message" | "question" | "decision" | "note";
  relatedArtifact: ArtifactKind | "none";
  body: string;
  templateIndex: number;
  submitting: boolean;
  message: string | null;
}

export interface PendingPlanningSessionSelectionState {
  trackId: string;
  selectedIndex: number;
  submitting: boolean;
  message: string | null;
}

export interface PendingPlanningSessionCreateState {
  trackId: string;
  status: PlanningSessionStatus;
  submitting: boolean;
  message: string | null;
}

export interface PendingWorkspaceCleanupActionState {
  runId: string;
  preview: WorkspaceCleanupPreviewResponse;
  result: WorkspaceCleanupApplyResponse | null;
  phase: "preview" | "confirmation_ready" | "applying" | "done";
  submitting: boolean;
  message: string | null;
}

export interface TerminalPreferenceState {
  selectedProjectId: string | null;
  runFilter: RunFilterMode;
  liveTailPaused: boolean;
  showRunEventDetail: boolean;
  refreshIntervalMs: number;
}

export interface TerminalAppState {
  screen: TerminalScreenId;
  statusLine: string;
  summary: TerminalSummarySnapshot | null;
  selectedProjectId?: string | null;
  apiBaseUrl: string;
  refreshIntervalMs: number;
  loading: boolean;
  error: string | null;
  tracks: DetailPanelState<TrackDetailSnapshot>;
  runs: DetailPanelState<RunDetailSnapshot>;
  runFilter: RunFilterMode;
  runEvents: RunEventFeedState;
  planningMessageTemplates?: PlanningMessageTemplate[];
  showRunEventDetail?: boolean;
  showRevisionDiffDetail?: boolean;
  runEventDetailIndex?: number | null;
  pendingTrackAction: PendingTrackActionState | null;
  pendingExecutionAction: PendingExecutionActionState | null;
  pendingProposalAction: PendingProposalActionState | null;
  pendingPlanningMessageAction?: PendingPlanningMessageActionState | null;
  pendingPlanningSessionSelection?: PendingPlanningSessionSelectionState | null;
  pendingPlanningSessionCreate?: PendingPlanningSessionCreateState | null;
  pendingWorkspaceCleanupAction?: PendingWorkspaceCleanupActionState | null;
}

interface TracksResponse {
  tracks: TrackListItem[];
}

interface ProjectsResponse {
  projects: ProjectListItem[];
}

interface RunsResponse {
  runs: RunListItem[];
}

interface TrackDetailResponse {
  track: TrackListItem;
  artifacts: TrackDetailSnapshot["artifacts"];
  planningContext?: TrackDetailSnapshot["planningContext"];
}

interface PlanningSessionsResponse {
  planningSessions: PlanningSessionSummary[];
}

interface PlanningMessagesResponse {
  messages: PlanningMessage[];
}

interface PlanningSessionResponse {
  planningSession: PlanningSessionSummary;
}

interface PlanningMessageResponse {
  message: PlanningMessage;
}

interface ArtifactWorkflowResponse {
  revisions: ArtifactRevisionSummary[];
  approvalRequests: ApprovalRequestSummary[];
}

interface ArtifactProposalResponse {
  revision: ArtifactRevisionSummary;
  approvalRequest: ApprovalRequestSummary;
}

interface RunDetailResponse {
  run: RunListItem;
}

interface RunEventsResponse {
  events: ExecutionEvent[];
}

type RunSessionPreviewResponse = RunSessionPreview;

interface ApiErrorResponse {
  error?: {
    message?: string;
    details?: Array<{ field?: string; message?: string }>;
  };
}

function getPlanningContextRevisionId(
  planningContext: TrackDetailSnapshot["planningContext"] | undefined,
  artifact: ArtifactKind,
): string | undefined {
  if (!planningContext) {
    return undefined;
  }

  return artifact === "spec"
    ? planningContext.specRevisionId
    : artifact === "plan"
      ? planningContext.planRevisionId
      : planningContext.tasksRevisionId;
}

export class SpecRailTerminalApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(resolveSpecRailApiUrl(this.baseUrl, pathname), init);
    if (!response.ok) {
      throw new Error(await this.buildRequestError(response, pathname));
    }

    return (await response.json()) as T;
  }

  private async requestText(pathname: string, init?: RequestInit): Promise<string> {
    const response = await this.fetchImpl(resolveSpecRailApiUrl(this.baseUrl, pathname), init);
    if (!response.ok) {
      throw new Error(await this.buildRequestError(response, pathname));
    }

    return response.text();
  }

  private async buildRequestError(response: Response, pathname: string): Promise<string> {
    const fallback = `SpecRail API request failed (${response.status}) for ${pathname}`;

    try {
      const payload = (await response.json()) as ApiErrorResponse;
      const message = payload.error?.message?.trim();
      const details = payload.error?.details
        ?.map((detail) => [detail.field, detail.message].filter(Boolean).join(": "))
        .filter((detail) => detail.length > 0);

      if (message && details && details.length > 0) {
        return `${message} (${details.join("; ")})`;
      }

      if (message) {
        return message;
      }
    } catch {
      // ignore parse failures and fall back to the generic message
    }

    return fallback;
  }

  async loadSummary(projectId?: string | null): Promise<TerminalSummarySnapshot> {
    const projectQuery = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
    const [projectsPayload, tracksPayload, runsPayload] = await Promise.all([
      this.request<ProjectsResponse>("/projects"),
      this.request<TracksResponse>(`/tracks?page=1&pageSize=20${projectQuery}`),
      this.request<RunsResponse>("/runs?page=1&pageSize=20"),
    ]);

    return {
      projects: projectsPayload.projects,
      tracks: tracksPayload.tracks,
      runs: runsPayload.runs,
      fetchedAt: new Date().toISOString(),
    };
  }

  async loadTrackDetail(trackId: string): Promise<TrackDetailSnapshot> {
    const encodedTrackId = encodeURIComponent(trackId);
    const payload = await this.request<TrackDetailResponse>(`/tracks/${encodedTrackId}`);
    const planningSessionsPayload = await this.request<PlanningSessionsResponse>(`/tracks/${encodedTrackId}/planning-sessions`);
    const planningSessions = planningSessionsPayload.planningSessions;
    const selectedPlanningSessionId = payload.planningContext?.planningSessionId ?? planningSessions[0]?.id;
    const planningMessages = selectedPlanningSessionId
      ? (await this.request<PlanningMessagesResponse>(`/planning-sessions/${encodeURIComponent(selectedPlanningSessionId)}/messages`)).messages
      : [];

    const artifacts = ["spec", "plan", "tasks"] as const;
    const workflowPayloads = await Promise.all(
      artifacts.map(
        async (artifact) => [
          artifact,
          await this.request<ArtifactWorkflowResponse>(`/tracks/${encodedTrackId}/artifacts/${encodeURIComponent(artifact)}`),
        ] as const,
      ),
    );

    const revisions = Object.fromEntries(workflowPayloads.map(([artifact, data]) => [artifact, data.revisions])) as TrackPlanningWorkspace["revisions"];
    const approvalRequests = Object.fromEntries(
      workflowPayloads.map(([artifact, data]) => [artifact, data.approvalRequests]),
    ) as TrackPlanningWorkspace["approvalRequests"];

    const pendingApproval = artifacts
      .flatMap((artifact) => approvalRequests[artifact])
      .find((request) => request.status === "pending");
    const selectedArtifact = pendingApproval?.artifact ?? (payload.planningContext?.planRevisionId ? "plan" : "spec");

    return {
      track: payload.track,
      artifacts: payload.artifacts,
      planningContext: payload.planningContext,
      planningWorkspace: {
        planningSessions,
        planningMessages,
        revisions,
        approvalRequests,
        selectedPlanningSessionId,
        selectedArtifact,
        selectedRevisionId: pendingApproval?.revisionId
          ?? getPlanningContextRevisionId(payload.planningContext, selectedArtifact)
          ?? revisions[selectedArtifact][0]?.id,
        selectedApprovalRequestId: pendingApproval?.id,
      },
    };
  }

  async loadPlanningMessages(planningSessionId: string): Promise<PlanningMessage[]> {
    const payload = await this.request<PlanningMessagesResponse>(`/planning-sessions/${encodeURIComponent(planningSessionId)}/messages`);
    return payload.messages;
  }

  async createPlanningSession(trackId: string, status: PlanningSessionStatus = "active"): Promise<PlanningSessionSummary> {
    const payload = await this.request<PlanningSessionResponse>(`/tracks/${encodeURIComponent(trackId)}/planning-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return payload.planningSession;
  }

  async updatePlanningSession(planningSessionId: string, status: PlanningSessionStatus): Promise<PlanningSessionSummary> {
    const payload = await this.request<PlanningSessionResponse>(`/planning-sessions/${encodeURIComponent(planningSessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return payload.planningSession;
  }

  async proposeArtifactRevision(input: {
    trackId: string;
    artifact: ArtifactKind;
    content: string;
    summary?: string;
    createdBy: "user" | "agent" | "system";
  }): Promise<ArtifactProposalResponse> {
    return this.request<ArtifactProposalResponse>(`/tracks/${encodeURIComponent(input.trackId)}/artifacts/${encodeURIComponent(input.artifact)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: input.content,
        summary: input.summary,
        createdBy: input.createdBy,
      }),
    });
  }

  async appendPlanningMessage(input: {
    planningSessionId: string;
    authorType: "user" | "agent" | "system";
    kind: "message" | "question" | "decision" | "note";
    body: string;
    relatedArtifact?: ArtifactKind;
  }): Promise<PlanningMessage> {
    const payload = await this.request<PlanningMessageResponse>(`/planning-sessions/${encodeURIComponent(input.planningSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorType: input.authorType,
        kind: input.kind,
        body: input.body,
        relatedArtifact: input.relatedArtifact,
      }),
    });

    return payload.message;
  }

  async decideApprovalRequest(approvalRequestId: string, decision: "approve" | "reject"): Promise<void> {
    await this.request(`/approval-requests/${encodeURIComponent(approvalRequestId)}/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "terminal" }),
    });
  }

  async loadRunDetail(runId: string): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${encodeURIComponent(runId)}`);
    return { run: payload.run };
  }

  async loadRunEvents(runId: string): Promise<ExecutionEvent[]> {
    const payload = await this.request<RunEventsResponse>(`/runs/${encodeURIComponent(runId)}/events`);
    return payload.events;
  }

  async listRunsByWorkspacePath(workspacePath: string): Promise<RunListItem[]> {
    const payload = await this.request<RunsResponse>(`/runs?page=1&pageSize=10&workspacePath=${encodeURIComponent(workspacePath)}`);
    return payload.runs;
  }

  async loadRunSessionPreview(runId: string, eventLimit = 5): Promise<RunSessionPreview> {
    return this.request<RunSessionPreviewResponse>(`/runs/${encodeURIComponent(runId)}/session-preview?eventLimit=${eventLimit}`);
  }

  async loadRunReportMarkdown(runId: string): Promise<string> {
    return this.requestText(formatRunReportUrl(runId));
  }

  async startRun(input: { trackId: string; prompt: string; backend?: string; profile?: string; planningSessionId?: string }): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    return { run: payload.run };
  }

  async resumeRun(input: { runId: string; prompt: string; backend?: string; profile?: string }): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${encodeURIComponent(input.runId)}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, backend: input.backend, profile: input.profile }),
    });

    return { run: payload.run };
  }

  async forkRun(input: { runId: string; prompt: string; backend?: string; profile?: string }): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${encodeURIComponent(input.runId)}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, backend: input.backend, profile: input.profile }),
    });

    return { run: payload.run };
  }

  async cancelRun(runId: string): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });

    return { run: payload.run };
  }

  async previewWorkspaceCleanup(runId: string): Promise<WorkspaceCleanupPreviewResponse> {
    return this.request<WorkspaceCleanupPreviewResponse>(`/runs/${encodeURIComponent(runId)}/workspace-cleanup/preview`);
  }

  async applyWorkspaceCleanup(runId: string, confirmation: string): Promise<WorkspaceCleanupApplyResponse> {
    return this.request<WorkspaceCleanupApplyResponse>(`/runs/${encodeURIComponent(runId)}/workspace-cleanup/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: confirmation }),
    });
  }

  async *streamRunEvents(runId: string, signal?: AbortSignal): AsyncGenerator<ExecutionEvent> {
    const response = await this.fetchImpl(resolveSpecRailApiUrl(this.baseUrl, `/runs/${encodeURIComponent(runId)}/events/stream`), {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SpecRail API request failed (${response.status}) for /runs/${runId}/events/stream`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });

        while (true) {
          const separatorIndex = buffer.indexOf("\n\n");
          if (separatorIndex === -1) {
            break;
          }

          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim();

          if (!dataLine) {
            continue;
          }

          yield JSON.parse(dataLine) as ExecutionEvent;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function resolveSpecRailApiUrl(baseUrl: string, pathname: string): URL {
  const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, normalizedBaseUrl);
}

export function createEmptyRunEventFeedState(runId: string | null = null, paused = false): RunEventFeedState {
  return {
    runId,
    items: [],
    connection: paused ? "paused" : "idle",
    paused,
    reconnectAttempts: 0,
    lastError: null,
    lastEventAt: null,
  };
}

export function appendRunEvents(feed: RunEventFeedState, events: ExecutionEvent[], maxItems = 12): RunEventFeedState {
  if (events.length === 0) {
    return feed;
  }

  const seenIds = new Set(feed.items.map((event) => event.id));
  const deduped = events.filter((event) => !seenIds.has(event.id));
  if (deduped.length === 0) {
    return feed;
  }

  const items = [...feed.items, ...deduped].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-maxItems);
  return {
    ...feed,
    items,
    lastEventAt: items.at(-1)?.timestamp ?? feed.lastEventAt,
  };
}

export function createEmptyTerminalState(config: SpecRailTerminalClientConfig): TerminalAppState {
  return {
    screen: config.initialScreen,
    statusLine: "Loading terminal snapshot...",
    summary: null,
    selectedProjectId: config.initialProjectId,
    apiBaseUrl: config.apiBaseUrl,
    refreshIntervalMs: config.refreshIntervalMs,
    loading: true,
    error: null,
    tracks: createEmptyDetailState<TrackDetailSnapshot>(),
    runs: createEmptyDetailState<RunDetailSnapshot>(),
    runFilter: config.initialRunFilter,
    runEvents: createEmptyRunEventFeedState(),
    planningMessageTemplates: [...PLANNING_MESSAGE_TEMPLATES],
    showRunEventDetail: false,
    showRevisionDiffDetail: false,
    runEventDetailIndex: null,
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    pendingPlanningMessageAction: null,
    pendingWorkspaceCleanupAction: null,
  };
}

function getFilteredRuns(summary: TerminalSummarySnapshot | null, mode: RunFilterMode): RunListItem[] {
  const runs = summary?.runs ?? [];
  if (mode === "active") {
    return runs.filter((run) => !isTerminalRunStatus(run.status));
  }

  if (mode === "terminal") {
    return runs.filter((run) => isTerminalRunStatus(run.status));
  }

  return runs;
}

function cycleRunFilterMode(current: RunFilterMode): RunFilterMode {
  return current === "all" ? "active" : current === "active" ? "terminal" : "all";
}

export function resolveTrackDefaultWorkspacePath(input: {
  track?: Pick<TrackListItem, "projectId"> | null;
  projects?: ProjectListItem[] | null;
  fallbackPath: string;
}): string {
  const project = input.projects?.find((candidate) => candidate.id === input.track?.projectId);
  return project?.localRepoPath?.trim() || input.fallbackPath;
}

export function createExecutionActionDraft(input: {
  kind: ExecutionActionKind;
  scope: "track" | "run";
  trackId?: string;
  runId?: string;
  planningSessionId?: string;
  backend?: string;
  profile?: string;
  prompt?: string;
  workspacePath?: string;
  message?: string | null;
}): PendingExecutionActionState {
  return {
    kind: input.kind,
    scope: input.scope,
    trackId: input.trackId,
    runId: input.runId,
    planningSessionId: input.planningSessionId,
    backend: input.backend ?? "codex",
    profile: input.profile ?? "default",
    prompt: input.prompt ?? "",
    workspacePath: input.workspacePath,
    activeField: "prompt",
    folderSessions: undefined,
    selectedFolderSessionIndex: 0,
    folderSessionPreview: null,
    submitting: false,
    message: input.message ?? null,
  };
}

function createEmptyDetailState<T>(): DetailPanelState<T> {
  return {
    selectedId: null,
    selectedIndex: 0,
    data: null,
    loading: false,
    error: null,
  };
}

export async function bootstrapTerminalState(
  config: SpecRailTerminalClientConfig,
  client: Pick<SpecRailTerminalApiClient, "loadSummary" | "loadTrackDetail" | "loadRunDetail">,
): Promise<TerminalAppState> {
  const summary = await client.loadSummary(config.initialProjectId);
  const tracks = await populateTrackPanel(createEmptyDetailState<TrackDetailSnapshot>(), summary, client);
  const runs = await populateRunPanel(createEmptyDetailState<RunDetailSnapshot>(), summary, client, config.initialRunFilter);

  return syncRunEventSelection({
    screen: config.initialScreen,
    statusLine: `Loaded ${summary.tracks.length} tracks and ${summary.runs.length} runs.`,
    summary,
    selectedProjectId: config.initialProjectId,
    apiBaseUrl: config.apiBaseUrl,
    refreshIntervalMs: config.refreshIntervalMs,
    loading: false,
    error: null,
    tracks,
    runs,
    runFilter: config.initialRunFilter,
    runEvents: createEmptyRunEventFeedState(runs.selectedId),
    showRunEventDetail: false,
    showRevisionDiffDetail: false,
    runEventDetailIndex: null,
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    pendingPlanningMessageAction: null,
  });
}

export async function refreshTerminalState(
  state: TerminalAppState,
  client: Pick<SpecRailTerminalApiClient, "loadSummary" | "loadTrackDetail" | "loadRunDetail">,
): Promise<TerminalAppState> {
  const summary = await client.loadSummary(state.selectedProjectId);
  const tracks = await populateTrackPanel(state.tracks, summary, client);
  const runs = await populateRunPanel(state.runs, summary, client, state.runFilter);

  return syncRunEventSelection({
    ...state,
    summary,
    loading: false,
    error: null,
    statusLine: `Refreshed ${summary.tracks.length} tracks and ${summary.runs.length} runs at ${summary.fetchedAt}.`,
    tracks,
    runs,
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    pendingPlanningMessageAction: null,
  });
}

async function populateTrackPanel(
  previous: DetailPanelState<TrackDetailSnapshot>,
  summary: TerminalSummarySnapshot,
  client: Pick<SpecRailTerminalApiClient, "loadTrackDetail">,
): Promise<DetailPanelState<TrackDetailSnapshot>> {
  const selection = resolveSelection(summary.tracks, previous.selectedId, previous.selectedIndex);
  if (!selection.selectedId) {
    return { ...previous, selectedId: null, selectedIndex: 0, data: null, loading: false, error: null };
  }

  try {
    const detail = await client.loadTrackDetail(selection.selectedId);
    return { ...previous, ...selection, data: detail, loading: false, error: null };
  } catch (error) {
    return {
      ...previous,
      ...selection,
      data: previous.data?.track.id === selection.selectedId ? previous.data : null,
      loading: false,
      error: error instanceof Error ? error.message : "Failed to load track detail.",
    };
  }
}

async function populateRunPanel(
  previous: DetailPanelState<RunDetailSnapshot>,
  summary: TerminalSummarySnapshot,
  client: Pick<SpecRailTerminalApiClient, "loadRunDetail">,
  filterMode: RunFilterMode,
): Promise<DetailPanelState<RunDetailSnapshot>> {
  const selection = resolveSelection(getFilteredRuns(summary, filterMode), previous.selectedId, previous.selectedIndex);
  if (!selection.selectedId) {
    return { ...previous, selectedId: null, selectedIndex: 0, data: null, loading: false, error: null };
  }

  try {
    const detail = await client.loadRunDetail(selection.selectedId);
    return { ...previous, ...selection, data: detail, loading: false, error: null };
  } catch (error) {
    return {
      ...previous,
      ...selection,
      data: previous.data?.run.id === selection.selectedId ? previous.data : null,
      loading: false,
      error: error instanceof Error ? error.message : "Failed to load run detail.",
    };
  }
}

function resolveSelection<T extends { id: string }>(items: T[], selectedId: string | null, selectedIndex: number) {
  if (items.length === 0) {
    return { selectedId: null, selectedIndex: 0 };
  }

  const indexFromId = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;
  const nextIndex = indexFromId >= 0 ? indexFromId : clampIndex(selectedIndex, items.length);
  return {
    selectedId: items[nextIndex]?.id ?? null,
    selectedIndex: nextIndex,
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, length - 1));
}

export function selectPreviousItem(state: TerminalAppState): TerminalAppState {
  return updateSelection(state, -1);
}

export function selectNextItem(state: TerminalAppState): TerminalAppState {
  return updateSelection(state, 1);
}

function updateSelection(state: TerminalAppState, delta: number): TerminalAppState {
  if (!state.summary) {
    return state;
  }

  if (state.screen === "tracks") {
    const nextIndex = clampIndex(state.tracks.selectedIndex + delta, state.summary.tracks.length);
    const selectedId = state.summary.tracks[nextIndex]?.id ?? null;
    return {
      ...state,
      statusLine: selectedId ? `Selected track ${selectedId}. Press r to refresh details.` : state.statusLine,
      tracks: {
        ...state.tracks,
        selectedIndex: nextIndex,
        selectedId,
        data: state.tracks.data?.track.id === selectedId ? state.tracks.data : null,
        error: null,
      },
    };
  }

  if (state.screen === "runs") {
    const filteredRuns = getFilteredRuns(state.summary, state.runFilter);
    const nextIndex = clampIndex(state.runs.selectedIndex + delta, filteredRuns.length);
    const selectedId = filteredRuns[nextIndex]?.id ?? null;
    return syncRunEventSelection({
      ...state,
      statusLine: selectedId ? `Selected run ${selectedId}. Press r to refresh details.` : state.statusLine,
      runs: {
        ...state.runs,
        selectedIndex: nextIndex,
        selectedId,
        data: state.runs.data?.run.id === selectedId ? state.runs.data : null,
        error: null,
      },
    });
  }

  return state;
}

export function resolveSelectedPendingApproval(state: TerminalAppState): ApprovalRequestSummary | null {
  const workspace = state.tracks.data?.planningWorkspace;
  if (!workspace) {
    return null;
  }

  return getPendingApprovalRequests(workspace).find((request) => request.id === workspace.selectedApprovalRequestId)
    ?? getPendingApprovalRequests(workspace)[0]
    ?? null;
}

export function syncRunEventSelection(state: TerminalAppState): TerminalAppState {
  const selectedId = state.runs.selectedId;
  if (selectedId === state.runEvents.runId) {
    return state;
  }

  return {
    ...state,
    runEvents: createEmptyRunEventFeedState(selectedId, state.runEvents.paused),
    runEventDetailIndex: null,
  };
}

export function setRunFilter(state: TerminalAppState, filter: RunFilterMode): TerminalAppState {
  const filteredRuns = getFilteredRuns(state.summary, filter);
  const selection = resolveSelection(filteredRuns, state.runs.selectedId, state.runs.selectedIndex);

  return syncRunEventSelection({
    ...state,
    runFilter: filter,
    statusLine: `Run filter set to ${filter}.`,
    runs: {
      ...state.runs,
      ...selection,
      data: state.runs.data?.run.id === selection.selectedId ? state.runs.data : null,
      error: null,
    },
  });
}

async function cycleProjectScope(
  state: TerminalAppState,
  client: Pick<SpecRailTerminalApiClient, "loadSummary" | "loadTrackDetail" | "loadRunDetail">,
): Promise<TerminalAppState> {
  const projects = state.summary?.projects ?? [];
  const projectIds = [null, ...projects.map((project) => project.id)] as Array<string | null>;
  const currentIndex = Math.max(0, projectIds.findIndex((projectId) => projectId === state.selectedProjectId));
  const selectedProjectId = projectIds[(currentIndex + 1) % projectIds.length] ?? null;

  return refreshTerminalState({
    ...state,
    selectedProjectId,
    tracks: createEmptyDetailState<TrackDetailSnapshot>(),
    statusLine: selectedProjectId ? `Filtering tracks to project ${selectedProjectId}...` : "Showing tracks from all projects...",
  }, client);
}

export function renderAppShell(state: TerminalAppState): string {
  const tabs: TerminalScreenId[] = ["home", "tracks", "runs", "settings"];
  const nav = tabs.map((tab) => (tab === state.screen ? `[${tab.toUpperCase()}]` : tab)).join("  ");
  const body = renderScreenBody(state);

  return [
    "SpecRail Terminal",
    `API ${state.apiBaseUrl}`,
    "",
    nav,
    "",
    ...body,
    "",
    `Status: ${state.statusLine}`,
    `Keys: 1 home, 2 tracks, 3 runs, 4 settings, j/k or ↑/↓ select, P project scope, +/- refresh, h/l artifact, [/] revision, u diff, U export diff, M session, N new session, T session status, v propose, m message, f run filter, d event detail, Space tail pause/resume, s start, e resume, c cancel, w cleanup, a approve, x reject, r refresh, q quit | Refresh ${state.refreshIntervalMs}ms`,
    ...renderContextualHelp(state),
    ...renderExecutionActionComposer(state.pendingExecutionAction),
    ...renderProposalActionComposer(state.pendingProposalAction),
    ...renderPlanningMessageComposer(state.pendingPlanningMessageAction ?? null, state.planningMessageTemplates ?? PLANNING_MESSAGE_TEMPLATES),
    ...renderPlanningSessionSelection(state),
    ...renderPlanningSessionCreateComposer(state.pendingPlanningSessionCreate ?? null),
    ...renderWorkspaceCleanupComposer(state.pendingWorkspaceCleanupAction ?? null),
  ].join("\n");
}

function renderContextualHelp(state: TerminalAppState): string[] {
  const lines = [""];

  if (state.pendingWorkspaceCleanupAction) {
    return [
      ...lines,
      "Help: workspace cleanup — Enter requests confirmation/applies when ready, Esc aborts, r refreshes selected run.",
    ];
  }

  if (state.pendingProposalAction) {
    return [
      ...lines,
      "Help: proposal composer — type edits the active field, Tab switches summary/content, g cycles author, Enter submits, Esc aborts.",
    ];
  }

  if (state.pendingPlanningMessageAction) {
    return [
      ...lines,
      "Help: planning message composer — type edits body, Ctrl+N inserts newline, Ctrl+E opens $EDITOR, g cycles author, y cycles kind, h/l cycles related artifact, Enter submits, Esc aborts.",
    ];
  }

  if (state.pendingPlanningSessionSelection) {
    return [
      ...lines,
      "Help: planning-session chooser — j/k or ↑/↓ selects a session, Enter loads messages, Esc aborts.",
    ];
  }

  if (state.pendingPlanningSessionCreate) {
    return [
      ...lines,
      "Help: planning-session create — y cycles status, Enter creates, Esc aborts.",
    ];
  }

  if (state.pendingExecutionAction) {
    const promptHelp = state.pendingExecutionAction.kind === "cancel"
      ? "Enter confirms cancellation, Esc aborts."
      : state.pendingExecutionAction.kind === "start"
        ? "type edits prompt/folder, Tab switches field, Ctrl+F previews folder sessions, Ctrl+R resumes selected session, Ctrl+K forks selected session, Enter starts fresh, Esc aborts."
        : "type edits prompt, p cycles profile, b cycles backend when unlocked, Enter submits, Esc aborts.";
    return [
      ...lines,
      `Help: ${state.pendingExecutionAction.kind} composer — ${promptHelp}`,
    ];
  }

  switch (state.screen) {
    case "tracks":
      return [
        ...lines,
        "Help: tracks — P cycles project scope, h/l switches artifact, [/] cycles revisions, u toggles expanded diff, U exports diff patch, M opens planning-session chooser, N creates session, T cycles selected session status, v proposes, m appends planning message, a/x approves or rejects pending revisions, s starts run composer with folder-session discovery.",
      ];
    case "runs":
      return [
        ...lines,
        "Help: runs — f cycles filters, Space pauses live tail, d toggles event detail, p/n selects event detail, e resumes terminal runs, c cancels active runs, w previews workspace cleanup.",
      ];
    case "settings":
      return [
        ...lines,
        "Help: settings — review API/refresh configuration, use 1/2/3 to jump back to active work, r refreshes data.",
      ];
    case "home":
    default:
      return [
        ...lines,
        "Help: home — use 2 for tracks, 3 for runs, P to narrow project scope, r to refresh the snapshot.",
      ];
  }
}

function renderWorkspaceCleanupComposer(action: PendingWorkspaceCleanupActionState | null): string[] {
  if (!action) {
    return [];
  }

  const plan = action.preview.cleanupPlan;
  const result = action.result?.cleanupResult;
  const expectedConfirmation = action.result?.expectedConfirmation;
  const operationLines = plan.operations.length > 0
    ? plan.operations.map((operation, index) => `  ${index + 1}. ${operation.kind}${operation.path ? ` ${operation.path}` : ""}${operation.branchName ? ` ${operation.branchName}` : ""}`)
    : ["  - none"];
  const refusalLines = plan.refusalReasons.length > 0 ? plan.refusalReasons.map((reason) => `  - ${reason}`) : ["  - none"];

  return [
    "",
    `Workspace cleanup: ${action.runId}`,
    `- eligible: ${plan.eligible ? "yes" : "no"}`,
    `- phase: ${action.phase}${action.submitting ? " (submitting...)" : ""}`,
    "- preview operations:",
    ...operationLines,
    "- preview refusal reasons:",
    ...refusalLines,
    expectedConfirmation ? `- server confirmation: ${expectedConfirmation}` : "- server confirmation: not requested yet",
    result ? `- result: ${result.status} (${result.operations.length} operations, ${result.refusalReasons.length} refusals)` : "- result: none yet",
    action.message ? `- note: ${action.message}` : "- note: Enter requests server confirmation, then Enter again applies with that exact phrase; Esc aborts",
  ];
}

function renderProposalActionComposer(action: PendingProposalActionState | null): string[] {
  if (!action) {
    return [];
  }

  return [
    "",
    `Proposal action: ${action.artifact} revision for track ${action.trackId}`,
    `- author: ${action.createdBy} (press g to cycle)`,
    `- editing: ${action.activeField}`,
    `- summary: ${action.summary || "(optional, Tab to edit)"}`,
    `- content: ${action.content || "(required, Tab to edit)"}`,
    `- submit: Enter${action.submitting ? " (submitting...)" : ""}, abort: Esc, backspace deletes, Tab switches field`,
    action.message ? `- note: ${action.message}` : "- note: lightweight single-buffer authoring for review and approval handoff",
  ];
}

function renderPlanningMessageComposer(action: PendingPlanningMessageActionState | null, templates: readonly PlanningMessageTemplate[] = PLANNING_MESSAGE_TEMPLATES): string[] {
  if (!action) {
    return [];
  }

  const bodyLines = action.body.length > 0
    ? ["- body:", ...action.body.split(/\r?\n/).map((line) => `  ${line || "(blank)"}`)]
    : ["- body: (required, type to edit)"];

  return [
    "",
    `Planning message action: session ${action.planningSessionId} for track ${action.trackId}`,
    `- author: ${action.authorType} (press g to cycle)`,
    `- kind: ${action.kind} (press y to cycle)`,
    `- related artifact: ${action.relatedArtifact} (press h/l to cycle)`,
    `- template: ${templates[action.templateIndex % templates.length]?.name ?? "handoff"} (press Ctrl+T to apply/cycle)`,
    ...bodyLines,
    `- submit: Enter${action.submitting ? " (submitting...)" : ""}, template: Ctrl+T, newline: Ctrl+N, editor: Ctrl+E, abort: Esc, backspace deletes`,
    action.message ? `- note: ${action.message}` : "- note: append a planning handoff note without leaving the terminal",
  ];
}

function renderPlanningSessionSelection(state: TerminalAppState): string[] {
  const action = state.pendingPlanningSessionSelection;
  if (!action) {
    return [];
  }

  const workspace = state.tracks.data?.planningWorkspace;
  const sessions = workspace?.planningSessions ?? [];
  const lines = sessions.length > 0
    ? sessions.map((session, index) => {
      const prefix = index === action.selectedIndex ? "  >" : "   ";
      const current = session.id === workspace?.selectedPlanningSessionId ? " | current" : "";
      return `${prefix} ${index + 1}. ${session.id} | ${session.status} | updated ${session.updatedAt ?? session.createdAt ?? "unknown"}${current}`;
    })
    : ["  - none"];

  return [
    "",
    "Planning session chooser",
    `- track: ${action.trackId}`,
    `- selected: ${sessions[action.selectedIndex]?.id ?? "none"}`,
    ...lines,
    `- note: ${action.message ?? "j/k select, Enter loads messages, Esc aborts"}`,
  ];
}

function renderPlanningSessionCreateComposer(action: PendingPlanningSessionCreateState | null): string[] {
  if (!action) {
    return [];
  }

  return [
    "",
    "Planning session create action",
    `- track: ${action.trackId}`,
    `- status: ${action.status} (press y to cycle)`,
    `- submit: Enter${action.submitting ? " (submitting...)" : ""}, abort: Esc`,
    action.message ? `- note: ${action.message}` : "- note: create a planning session and select it for follow-up messages",
  ];
}

function renderExecutionActionComposer(action: PendingExecutionActionState | null): string[] {
  if (!action) {
    return [];
  }

  const title = action.kind === "start"
    ? `Execution action: start track ${action.trackId ?? "unknown"}`
    : action.kind === "resume"
      ? `Execution action: resume run ${action.runId ?? "unknown"}`
      : action.kind === "fork"
        ? `Execution action: fork run ${action.runId ?? "unknown"}`
      : `Execution action: cancel run ${action.runId ?? "unknown"}`;

  if (action.kind === "cancel") {
    return [
      "",
      title,
      `- backend/profile: ${action.backend} / ${action.profile}`,
      `- confirmation: press Enter to cancel, Esc to abort${action.submitting ? " (submitting...)" : ""}`,
      action.message ? `- note: ${action.message}` : "- note: this is a best-effort local cancellation request",
    ];
  }

  const folderLines = action.kind === "start" ? renderFolderSessionLines(action) : [];

  return [
    "",
    title,
    `- backend: ${action.backend}${action.kind === "resume" || action.kind === "fork" ? " (locked to source run backend)" : " (press b to cycle)"}`,
    `- profile: ${action.profile}`,
    `- editing: ${action.activeField ?? "prompt"}`,
    `- prompt: ${action.prompt || "(required, type to edit)"}`,
    ...(action.kind === "start" ? [`- folder path: ${action.workspacePath || "(optional, Tab to edit; Ctrl+F previews related sessions before starting)"}`] : []),
    `- planning session: ${action.planningSessionId ?? "auto/latest approved"}`,
    ...folderLines,
    `- submit: Enter${action.submitting ? " (submitting...)" : ""}, abort: Esc, backspace deletes${action.kind === "start" ? ", Tab switches prompt/folder" : ""}`,
    action.message ? `- note: ${action.message}` : action.kind === "start" ? "- note: Ctrl+F previews folder sessions; Ctrl+R resumes selected session; Ctrl+K forks selected session; p cycles profile presets" : "- note: printable keys edit prompt, p cycles profile presets",
  ];
}

function renderFolderSessionLines(action: PendingExecutionActionState): string[] {
  const sessions = action.folderSessions;
  if (!sessions) {
    return ["- folder sessions: not loaded"];
  }

  if (sessions.length === 0) {
    return ["- folder sessions: none found; Enter starts fresh"];
  }

  const selectedIndex = clampIndex(action.selectedFolderSessionIndex ?? 0, sessions.length);
  const selected = sessions[selectedIndex];
  const preview = action.folderSessionPreview?.execution.id === selected?.id ? action.folderSessionPreview : null;
  return [
    `- folder sessions (${sessions.length}, selected ${selectedIndex + 1}/${sessions.length}; [/] changes selection):`,
    ...sessions.map((run, index) => `  ${index === selectedIndex ? ">" : " "} ${run.id} | ${run.status} | ${run.backend ?? "backend?"} | ${run.continuityMode ?? "continuity?"} | ${previewText(run.summary?.lastEventSummary ?? "No events yet", 80)}`),
    ...(preview ? [
      `- selected session: ${preview.session?.sessionRef ?? selected?.sessionRef ?? "unknown"}`,
      `- selected workspace: ${preview.execution.workspacePath ?? selected?.workspacePath ?? "unknown"}`,
      `- selected report: ${preview.reportPath ?? "not available"}`,
      `- selected capabilities: resume=${String(preview.capabilities?.supportsResume ?? false)}, providerFork=${String(preview.capabilities?.supportsProviderFork ?? false)}, contextCopyFork=${String(preview.capabilities?.supportsContextCopyFork ?? false)}`,
      `- selected recent events: ${preview.events.map((event) => event.summary).join(" | ") || "none"}`,
    ] : ["- selected session preview: Ctrl+F loads/refreshes preview for the selected folder session"]),
  ];
}

function renderScreenBody(state: TerminalAppState): string[] {
  if (state.loading && !state.summary) {
    return ["Loading terminal snapshot..."];
  }

  if (state.error && !state.summary) {
    return ["Terminal snapshot unavailable.", `- Error: ${state.error}`];
  }

  if (!state.summary) {
    return ["No terminal snapshot available."];
  }

  switch (state.screen) {
    case "tracks":
      return renderTracksScreen(state);
    case "runs":
      return renderRunsScreen(state);
    case "settings":
      return [
        "Settings",
        `- API base URL: ${state.apiBaseUrl}`,
        `- Refresh interval: ${state.refreshIntervalMs}ms`,
        "- Navigation: use j/k or arrow keys to move through track/run selections.",
        "- Press + / - to adjust automatic refresh cadence; set to 0ms to disable automatic refresh.",
        "- Press P to cycle project scope for track listings.",
        "- Tracks view surfaces planning sessions, revision history, and pending approvals.",
        "- Press a/x on the tracks screen to approve or reject the next pending request.",
        "- Press s on tracks to start a run; the start composer can preview folder sessions before starting fresh, resuming, or forking.",
        "- Press e on runs to resume, c on runs to cancel.",
        "- Press f on runs to cycle all/active/terminal filters.",
        "- Press Space on runs to pause or resume the live SSE tail.",
        "- Runs view tails live SSE events with automatic reconnect attempts.",
      ];
    case "home":
    default:
      return [
        "Overview",
        `- Project scope: ${formatProjectScope(state)}`,
        `- Projects loaded: ${state.summary.projects?.length ?? 0}`,
        `- Tracks loaded: ${state.summary.tracks.length}`,
        `- Runs loaded: ${state.summary.runs.length}`,
        `- Last fetch: ${state.summary.fetchedAt}`,
        `- Selected track: ${state.tracks.selectedId ?? "none"}`,
        `- Selected run: ${state.runs.selectedId ?? "none"}`,
        `- Run filter: ${state.runFilter}`,
        `- Run stream: ${state.runEvents.runId ? `${state.runEvents.connection} (${state.runEvents.items.length} events cached)` : "idle"}`,
        `- Pending execution action: ${state.pendingExecutionAction ? `${state.pendingExecutionAction.kind} ${state.pendingExecutionAction.scope}` : "none"}`,
        state.error ? `- Last refresh error: ${state.error}` : "- Last refresh error: none",
      ];
  }
}

function renderTracksScreen(state: TerminalAppState): string[] {
  const selectedTrack = state.summary?.tracks[state.tracks.selectedIndex] ?? null;
  return [
    `Tracks (${state.summary?.tracks.length ?? 0}, project=${formatProjectScope(state)})`,
    ...renderSelectableList(
      state.summary?.tracks.map((track) => `${track.id} | ${track.projectId ?? "project?"} | ${track.status ?? "unknown"} | ${track.priority ?? "medium"} | ${track.title}`) ?? [],
      state.tracks.selectedIndex,
      "No tracks yet.",
    ),
    "",
    "Track detail",
    ...renderTrackDetail(selectedTrack?.id === state.tracks.data?.track.id ? state.tracks.data : null, state.tracks, selectedTrack?.id ?? null, state.showRevisionDiffDetail ?? false),
  ];
}

function formatProjectScope(state: TerminalAppState): string {
  if (!state.selectedProjectId) {
    return "all projects";
  }

  const project = state.summary?.projects?.find((item) => item.id === state.selectedProjectId);
  return project ? `${project.name} (${project.id})` : state.selectedProjectId;
}

function renderRunsScreen(state: TerminalAppState): string[] {
  const filteredRuns = getFilteredRuns(state.summary, state.runFilter);
  const selectedRun = filteredRuns[state.runs.selectedIndex] ?? null;
  const detail = selectedRun?.id === state.runs.data?.run.id ? state.runs.data : null;

  return [
    `Runs (${filteredRuns.length}/${state.summary?.runs.length ?? 0}, filter=${state.runFilter})`,
    ...renderSelectableList(
      filteredRuns.map(
        (run) => `${run.id} | ${run.status} | ${run.trackId} | ${run.backend ?? "default"}${run.planningContextStale ? " | stale" : ""}`,
      ),
      state.runs.selectedIndex,
      "No runs yet.",
    ),
    "",
    "Run detail",
    ...renderRunDetail(detail, state.runs, selectedRun?.id ?? null, state.runEvents, state.showRunEventDetail ?? false, state.runEventDetailIndex ?? null),
  ];
}

function renderSelectableList(items: string[], selectedIndex: number, emptyMessage: string): string[] {
  if (items.length === 0) {
    return [`- ${emptyMessage}`];
  }

  return items.map((item, index) => `${index === selectedIndex ? ">" : " "} ${item}`);
}

function renderTrackDetail(
  detail: TrackDetailSnapshot | null,
  panel: DetailPanelState<TrackDetailSnapshot>,
  selectedId: string | null,
  showRevisionDiffDetail = false,
): string[] {
  if (!selectedId) {
    return ["- No track selected."];
  }

  if (panel.error) {
    return [`- Error: ${panel.error}`];
  }

  if (!detail) {
    return ["- Detail unavailable. Press r to reload the selected track."];
  }

  const workspace = detail.planningWorkspace;
  const selectedArtifact = workspace?.selectedArtifact ?? "plan";
  const selectedRevision = workspace?.revisions[selectedArtifact]?.find((revision) => revision.id === workspace.selectedRevisionId)
    ?? workspace?.revisions[selectedArtifact]?.[0]
    ?? null;
  const pendingRequests = workspace ? getPendingApprovalRequests(workspace) : [];
  const selectedApproval = pendingRequests.find((request) => request.id === workspace?.selectedApprovalRequestId) ?? pendingRequests[0] ?? null;
  const selectedRevisionApproval = workspace && selectedRevision
    ? workspace.approvalRequests[selectedArtifact].find((request) => request.revisionId === selectedRevision.id) ?? null
    : null;
  const selectedRevisionIndex = selectedRevision ? workspace?.revisions[selectedArtifact]?.findIndex((revision) => revision.id === selectedRevision.id) ?? -1 : -1;
  const selectedArtifactRevisionCount = workspace?.revisions[selectedArtifact]?.length ?? 0;
  const selectedPlanningSessionIndex = workspace?.planningSessions.findIndex((session) => session.id === workspace.selectedPlanningSessionId) ?? -1;
  const planningSessionSelection = workspace && workspace.planningSessions.length > 0 && selectedPlanningSessionIndex >= 0
    ? `${workspace.selectedPlanningSessionId} (${selectedPlanningSessionIndex + 1}/${workspace.planningSessions.length})`
    : detail.planningContext?.planningSessionId ?? "none";

  return [
    `- id: ${detail.track.id}`,
    `- title: ${detail.track.title}`,
    `- status: ${detail.track.status ?? "unknown"}`,
    `- priority: ${detail.track.priority ?? "medium"}`,
    `- approvals: spec=${detail.track.specStatus ?? "unknown"}, plan=${detail.track.planStatus ?? "unknown"}`,
    `- updated: ${detail.track.updatedAt ?? "unknown"}`,
    `- planning session: ${planningSessionSelection}`,
    `- planning context updated: ${detail.planningContext?.updatedAt ?? "unknown"}`,
    `- pending planning changes: ${detail.planningContext?.hasPendingChanges ? "yes" : "no"}`,
    `- execution context signal: ${detail.planningContext?.hasPendingChanges ? "new approvals needed before new runs" : "current approved context is runnable"}`,
    `- spec preview: ${previewText(detail.artifacts.spec)}`,
    `- plan preview: ${previewText(detail.artifacts.plan)}`,
    `- tasks preview: ${previewText(detail.artifacts.tasks)}`,
    "- planning sessions:",
    ...renderPlanningSessionLines(workspace),
    `- revision focus (${selectedArtifact}${selectedArtifactRevisionCount > 0 && selectedRevisionIndex >= 0 ? ` ${selectedRevisionIndex + 1}/${selectedArtifactRevisionCount}` : ""}): ${selectedRevision ? `v${selectedRevision.version} by ${selectedRevision.createdBy} at ${selectedRevision.createdAt}${selectedRevision.approvedAt ? ` | approved ${selectedRevision.approvedAt}` : " | pending review"}` : "none"}`,
    `- revision approval: ${selectedRevisionApproval ? `${selectedRevisionApproval.status} via ${selectedRevisionApproval.id}${selectedRevisionApproval.decidedAt ? ` at ${selectedRevisionApproval.decidedAt}` : ""}` : "none"}`,
    `- revision preview: ${selectedRevision ? previewText(selectedRevision.content, 120) : "none"}`,
    ...(selectedRevision ? renderRevisionDiffLines(detail.artifacts[selectedArtifact], selectedRevision.content, showRevisionDiffDetail) : ["- revision diff: none"]),
    `- pending approvals: ${selectedApproval ? `${selectedApproval.artifact} -> ${selectedApproval.revisionId} requested by ${selectedApproval.requestedBy} at ${selectedApproval.createdAt}` : "none"}`,
    `- operator actions: ${selectedApproval ? "press a to approve or x to reject selected pending request" : "no pending approval actions"}`,
    `- planning actions: h/l switches artifact focus, [/] cycles revisions, u toggles expanded diff, U exports diff patch, M opens planning-session chooser, N opens planning-session create composer, T cycles selected session status, v proposes a new revision for ${selectedArtifact}`,
    `- execution actions: press s to start a run for this track${detail.planningContext?.hasPendingChanges ? " (currently blocked until approvals land)" : ""}`,
  ];
}

function renderPlanningSessionLines(workspace?: TrackPlanningWorkspace): string[] {
  if (!workspace || workspace.planningSessions.length === 0) {
    return ["  - none"];
  }

  const visibleLimit = 3;
  const visibleSessions = workspace.planningSessions.slice(0, visibleLimit).map((session) => {
    const prefix = session.id === workspace.selectedPlanningSessionId ? "  >" : "   ";
    const messageCount = workspace.planningMessages.filter((message) => message.planningSessionId === session.id).length;
    return `${prefix} ${session.id} | ${session.status} | messages ${messageCount} | updated ${session.updatedAt ?? session.createdAt ?? "unknown"}`;
  });
  const hiddenCount = workspace.planningSessions.length - visibleSessions.length;
  const overflowLines = hiddenCount > 0 ? [`  ... ${hiddenCount} more sessions, press M to cycle`] : [];

  return visibleSessions.concat(overflowLines, renderPlanningMessageLines(workspace.planningMessages));
}

function renderPlanningMessageLines(messages: PlanningMessage[]): string[] {
  if (messages.length === 0) {
    return ["  - no planning messages yet"];
  }

  return messages.slice(-3).map((message) => `  - ${message.authorType}/${message.kind}${message.relatedArtifact ? `/${message.relatedArtifact}` : ""}: ${previewText(message.body, 90)}`);
}

function getPendingApprovalRequests(workspace: TrackPlanningWorkspace): ApprovalRequestSummary[] {
  return (["spec", "plan", "tasks"] as const)
    .flatMap((artifact) => workspace.approvalRequests[artifact])
    .filter((request) => request.status === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function cycleArtifact(current: ArtifactKind, delta: number): ArtifactKind {
  const artifacts = ["spec", "plan", "tasks"] as const;
  const currentIndex = artifacts.findIndex((artifact) => artifact === current);
  return artifacts[(currentIndex + delta + artifacts.length) % artifacts.length] ?? current;
}

function selectTrackArtifact(state: TerminalAppState, artifact: ArtifactKind): TerminalAppState {
  const workspace = state.tracks.data?.planningWorkspace;
  if (state.screen !== "tracks" || !workspace || !state.tracks.data) {
    return state;
  }

  const selectedRevisionId = workspace.revisions[artifact][0]?.id;
  return {
    ...state,
    statusLine: `Selected ${artifact} revisions.`,
    tracks: {
      ...state.tracks,
      data: {
        ...state.tracks.data,
        planningWorkspace: {
          ...workspace,
          selectedArtifact: artifact,
          selectedRevisionId,
          selectedApprovalRequestId: workspace.approvalRequests[artifact].find((request) => request.status === "pending")?.id,
        },
      },
    },
  };
}

function cycleTrackRevision(state: TerminalAppState, delta: number): TerminalAppState {
  const workspace = state.tracks.data?.planningWorkspace;
  if (state.screen !== "tracks" || !workspace || !state.tracks.data) {
    return state;
  }

  const revisions = workspace.revisions[workspace.selectedArtifact];
  if (revisions.length === 0) {
    return { ...state, statusLine: `No ${workspace.selectedArtifact} revisions available.` };
  }

  const currentIndex = Math.max(0, revisions.findIndex((revision) => revision.id === workspace.selectedRevisionId));
  const nextRevision = revisions[(currentIndex + delta + revisions.length) % revisions.length] ?? revisions[0];
  return {
    ...state,
    statusLine: `Selected ${workspace.selectedArtifact} revision v${nextRevision.version}.`,
    tracks: {
      ...state.tracks,
      data: {
        ...state.tracks.data,
        planningWorkspace: {
          ...workspace,
          selectedRevisionId: nextRevision.id,
          selectedApprovalRequestId: workspace.approvalRequests[workspace.selectedArtifact].find((request) => request.revisionId === nextRevision.id && request.status === "pending")?.id,
        },
      },
    },
  };
}

function renderRunDetail(
  detail: RunDetailSnapshot | null,
  panel: DetailPanelState<RunDetailSnapshot>,
  selectedId: string | null,
  feed: RunEventFeedState,
  showEventDetail: boolean,
  eventDetailIndex: number | null,
): string[] {
  if (!selectedId) {
    return ["- No run selected."];
  }

  if (panel.error) {
    return [`- Error: ${panel.error}`];
  }

  if (!detail) {
    return ["- Detail unavailable. Press r to reload the selected run."];
  }

  const run = detail.run;
  const terminal = isTerminalRunStatus(run.status);
  const lastEvent = feed.runId === run.id ? feed.items.at(-1) ?? null : null;
  const detailEventIndex = showEventDetail && feed.runId === run.id ? resolveRunEventDetailIndex(feed.items, eventDetailIndex) : null;
  const detailEvent = detailEventIndex !== null ? feed.items[detailEventIndex] ?? null : null;
  const recentFailure = feed.runId === run.id ? [...feed.items].reverse().find((event) => isFailureEvent(event)) ?? null : null;

  return [
    `- id: ${run.id}`,
    `- track: ${run.trackId}`,
    `- status: ${run.status}`,
    `- backend/profile: ${run.backend ?? "default"} / ${run.profile ?? "default"}`,
    `- branch: ${run.branchName ?? "unknown"}`,
    `- workspace: ${run.workspacePath ?? "unknown"}`,
    `- session: ${run.sessionRef ?? "none"}`,
    `- continuity: ${run.continuityMode ?? "unknown"}`,
    `- parent run/session: ${run.parentExecutionId ?? "none"} / ${run.parentSessionRef ?? "none"}`,
    `- planning session: ${run.planningSessionId ?? "none"}`,
    `- planning context stale: ${run.planningContextStale ? "yes" : "no"}`,
    `- stale reason: ${run.planningContextStaleReason ?? "none"}`,
    `- planning context updated: ${run.planningContextUpdatedAt ?? "unknown"}`,
    `- started: ${run.startedAt ?? run.createdAt ?? "unknown"}`,
    `- finished: ${run.finishedAt ?? "not finished"}`,
    `- event summary: ${formatEventSummary(run, feed)}`,
    `- last event: ${lastEvent ? formatEventLine(lastEvent) : run.summary?.lastEventSummary ?? "none"}`,
    `- report: ${formatRunReportUrl(run.id)}`,
    `- failure focus: ${recentFailure ? formatFailureFocus(recentFailure) : terminal && run.status === "failed" ? "run failed, inspect recent provider events" : "none"}`,
    `- stream: ${formatStreamStatus(feed, terminal)}`,
    `- operator actions: ${formatRunOperatorActions(run, feed)}`,
    "- recent activity:",
    ...renderRecentRunEvents(feed, run.id),
    ...renderRunEventDetailLines(detailEvent, detailEventIndex, feed.items.length),
   ];
}

function resolveRunEventDetailIndex(events: ExecutionEvent[], requestedIndex: number | null): number | null {
  if (events.length === 0) {
    return null;
  }

  return requestedIndex === null ? events.length - 1 : clampIndex(requestedIndex, events.length);
}

function renderRunEventDetailLines(event: ExecutionEvent | null, eventIndex: number | null, eventCount: number): string[] {
  if (!event || eventIndex === null) {
    return [];
  }

  return [
    `- event detail (${eventIndex + 1}/${eventCount}):`,
    `  - id: ${event.id}`,
    `  - type: ${event.type}${event.subtype ? ` / ${event.subtype}` : ""}`,
    `  - source: ${event.source}`,
    `  - timestamp: ${event.timestamp}`,
    `  - summary: ${previewText(event.summary, 160)}`,
    ...formatEventDetailHighlightLines(event),
    "  - payload:",
    ...formatEventPayloadPreview(event.payload),
  ];
}

function formatEventDetailHighlightLines(event: ExecutionEvent): string[] {
  const highlights = formatEventDetailHighlights(event);
  if (highlights.length === 0) {
    return [];
  }

  return ["  - highlights:", ...highlights.map((highlight) => `    - ${highlight}`)];
}

function formatEventDetailHighlights(event: ExecutionEvent): string[] {
  const stream = readEventStream(event);
  const text = readEventText(event);
  const status = readEventStatus(event);
  const exitCode = readPayloadNumber(event, "exitCode");
  const signal = readPayloadString(event, "signal");

  if (event.type === "tool_call") {
    const toolName = readPayloadString(event, "toolName") ?? "unknown";
    const toolUseId = readPayloadString(event, "toolUseId");
    const toolInput = previewPayloadValue(event.payload?.toolInput, 220);
    return [
      `tool call: ${toolName}${toolUseId ? ` (${toolUseId})` : ""}`,
      toolInput ? `input: ${toolInput}` : null,
    ].filter((line): line is string => Boolean(line));
  }

  if (event.type === "tool_result") {
    const toolUseId = readPayloadString(event, "toolUseId");
    const content = previewPayloadValue(event.payload?.content, 260);
    return [
      `tool result${toolUseId ? ` (${toolUseId})` : ""}`,
      content ? `content: ${content}` : null,
    ].filter((line): line is string => Boolean(line));
  }

  if (event.type === "approval_requested" || event.type === "approval_resolved") {
    const requestId = readPayloadString(event, "requestId");
    const outcome = readPayloadString(event, "outcome");
    const toolName = readPayloadString(event, "toolName");
    return [
      `${event.type === "approval_requested" ? "approval requested" : "approval resolved"}${requestId ? `: ${requestId}` : ""}`,
      toolName ? `tool: ${toolName}` : null,
      outcome ? `outcome: ${outcome}` : null,
    ].filter((line): line is string => Boolean(line));
  }

  return [
    status ? `status: ${status}` : null,
    exitCode !== null ? `exit code: ${exitCode}` : null,
    signal ? `signal: ${signal}` : null,
    stream ? `stream: ${stream}` : null,
    text ? `text: ${previewText(text, 220)}` : null,
  ].filter((line): line is string => Boolean(line));
}

function formatEventPayloadPreview(payload: Record<string, unknown> | undefined): string[] {
  if (!payload || Object.keys(payload).length === 0) {
    return ["    - none"];
  }

  const preview = previewMultilineText(JSON.stringify(payload, null, 2), 900);
  return preview.split("\n").map((line) => `    ${line}`);
}

function nextProfileOption(backend: string, currentProfile: string): string {
  const options = EXECUTION_PROFILE_OPTIONS[backend] ?? ["default"];
  const currentIndex = options.findIndex((option) => option === currentProfile);
  return options[(currentIndex + 1 + options.length) % options.length] ?? currentProfile;
}

function formatRunReportUrl(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/report.md`;
}

function formatRunOperatorActions(run: RunListItem, feed: RunEventFeedState): string {
  const tailAction = feed.paused ? "Space to resume tail" : "Space to pause tail";
  if (run.status === "running" || run.status === "waiting_approval") {
    return `press c to cancel this run, ${tailAction}`;
  }

  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return `press e to resume this run, w to preview workspace cleanup, ${tailAction}`;
  }

  return `${tailAction}, resume/cancel unavailable for the current run state`;
}

function renderRecentRunEvents(feed: RunEventFeedState, runId: string): string[] {
  if (feed.runId !== runId) {
    return ["  - waiting for selected run monitor..."];
  }

  if (feed.items.length === 0) {
    if (feed.lastError) {
      return [`  - stream error: ${feed.lastError}`];
    }

    return ["  - no run events yet"];
  }

  return feed.items.slice(-6).map((event) => `  - ${formatEventLine(event)}`);
}

function formatEventSummary(run: RunListItem, feed: RunEventFeedState): string {
  const eventCount = feed.runId === run.id ? feed.items.length : 0;
  const sourceCount = eventCount > 0 ? eventCount : run.summary?.eventCount ?? 0;
  const lastAt = (feed.runId === run.id ? feed.lastEventAt : null) ?? run.summary?.lastEventAt;
  return `${sourceCount} event${sourceCount === 1 ? "" : "s"}${lastAt ? `, last at ${lastAt}` : ""}`;
}

function formatFailureFocus(event: ExecutionEvent): string {
  const exitCode = typeof event.payload?.exitCode === "number" ? `exit ${event.payload.exitCode}` : null;
  const signal = typeof event.payload?.signal === "string" ? `signal ${event.payload.signal}` : null;
  const extra = [exitCode, signal].filter(Boolean).join(", ");
  return extra ? `${event.summary} (${extra})` : event.summary;
}

function formatStreamStatus(feed: RunEventFeedState, terminal: boolean): string {
  const suffix = feed.lastError ? `, last error: ${feed.lastError}` : "";
  if (feed.paused || feed.connection === "paused") {
    return `paused${suffix}`;
  }

  if (feed.connection === "reconnecting") {
    return `reconnecting (attempt ${feed.reconnectAttempts})${suffix}`;
  }

  if (feed.connection === "closed" && terminal) {
    return `closed after terminal run${suffix}`;
  }

  return `${feed.connection}${feed.reconnectAttempts > 0 ? `, retries ${feed.reconnectAttempts}` : ""}${suffix}`;
}

function formatEventLine(event: ExecutionEvent): string {
  const status = readEventStatus(event);
  const stream = readEventStream(event);
  const text = readEventText(event);
  const details = formatStructuredEventDetails(event);
  const parts = [event.timestamp, event.type];
  if (event.subtype) {
    parts.push(event.subtype);
  }
  if (status) {
    parts.push(`status=${status}`);
  }
  if (stream) {
    parts.push(`stream=${stream}`);
  }
  const hasExtra = Boolean(text || details);
  const summary = previewText(event.summary, hasExtra ? 72 : 120);
  const suffix = [details, text ? previewText(text, 96) : null].filter(Boolean).join("; ");
  return suffix ? `${parts.join(" | ")} | ${summary} — ${suffix}` : `${parts.join(" | ")} | ${summary}`;
}

function formatStructuredEventDetails(event: ExecutionEvent): string | null {
  if (event.type === "tool_call") {
    const toolName = readPayloadString(event, "toolName") ?? "unknown";
    const toolUseId = readPayloadString(event, "toolUseId");
    const toolInput = previewPayloadValue(event.payload?.toolInput, 72);
    return [`tool=${toolName}`, toolUseId ? `id=${toolUseId}` : null, toolInput ? `input=${toolInput}` : null].filter(Boolean).join(", ");
  }

  if (event.type === "tool_result") {
    const toolUseId = readPayloadString(event, "toolUseId");
    const content = previewPayloadValue(event.payload?.content, 96);
    return [toolUseId ? `id=${toolUseId}` : null, content ? `result=${content}` : null].filter(Boolean).join(", ") || null;
  }

  if (event.type === "approval_requested" || event.type === "approval_resolved") {
    const requestId = readPayloadString(event, "requestId");
    const outcome = readPayloadString(event, "outcome");
    const toolName = readPayloadString(event, "toolName");
    return [requestId ? `request=${requestId}` : null, outcome ? `outcome=${outcome}` : null, toolName ? `tool=${toolName}` : null].filter(Boolean).join(", ") || null;
  }

  return null;
}

function readEventStream(event: ExecutionEvent): string | null {
  const stream = event.payload?.stream;
  return stream === "stdout" || stream === "stderr" ? stream : null;
}

function readEventText(event: ExecutionEvent): string | null {
  const text = event.payload?.text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function readPayloadString(event: ExecutionEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPayloadNumber(event: ExecutionEvent, key: string): number | null {
  const value = event.payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function previewPayloadValue(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw && raw.trim().length > 0 ? previewText(raw, maxLength) : null;
}

function readEventStatus(event: ExecutionEvent): string | null {
  const status = event.payload?.status;
  return typeof status === "string" ? status : null;
}

function isFailureEvent(event: ExecutionEvent): boolean {
  return readEventStatus(event) === "failed" || event.type === "approval_requested";
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function previewText(value: string, maxLength = 80): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}

function resolveTerminalEditor(): string {
  return process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi";
}

export async function editTextWithTerminalEditor(initialText: string, editorCommand = resolveTerminalEditor()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "specrail-terminal-message-"));
  const filePath = join(directory, "planning-message.md");

  try {
    await writeFile(filePath, initialText, "utf8");
    const result = spawnSync(editorCommand, [filePath], { shell: true, stdio: "inherit" });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(`Editor exited with status ${result.status ?? "unknown"}.`);
    }

    return await readFile(filePath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function renderRevisionDiffLines(currentContent: string, revisionContent: string, expanded = false): string[] {
  if (currentContent === revisionContent) {
    return ["- revision diff: matches current artifact"];
  }

  const currentLines = currentContent.split(/\r?\n/);
  const revisionLines = revisionContent.split(/\r?\n/);
  const maxLength = Math.max(currentLines.length, revisionLines.length);
  const removed: string[] = [];
  const added: string[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const before = currentLines[index];
    const after = revisionLines[index];
    if (before === after) {
      continue;
    }
    if (before !== undefined) {
      removed.push(before);
    }
    if (after !== undefined) {
      added.push(after);
    }
  }

  const visibleRemoved = expanded ? removed : removed.slice(0, 2);
  const visibleAdded = expanded ? added : added.slice(0, 2);
  const previewLines = visibleRemoved.map((line) => `  - ${expanded ? line || "(blank)" : previewText(line || "(blank)", 72)}`)
    .concat(visibleAdded.map((line) => `  + ${expanded ? line || "(blank)" : previewText(line || "(blank)", 72)}`));
  const hiddenCount = Math.max(0, removed.length + added.length - previewLines.length);

  return [
    `- revision diff${expanded ? " (expanded)" : ""}: +${added.length} -${removed.length} changed lines vs current ${hiddenCount > 0 ? `(${hiddenCount} more hidden, press u to expand)` : expanded ? "(press u to collapse)" : ""}`.trim(),
    ...previewLines,
  ];
}

function sanitizePatchFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function collectChangedLinePairs(currentContent: string, revisionContent: string): Array<{ before?: string; after?: string; lineNumber: number }> {
  const currentLines = currentContent.split(/\r?\n/);
  const revisionLines = revisionContent.split(/\r?\n/);
  const maxLength = Math.max(currentLines.length, revisionLines.length);
  const changes: Array<{ before?: string; after?: string; lineNumber: number }> = [];

  for (let index = 0; index < maxLength; index += 1) {
    const before = currentLines[index];
    const after = revisionLines[index];
    if (before === after) {
      continue;
    }

    changes.push({ before, after, lineNumber: index + 1 });
  }

  return changes;
}

export function renderRevisionDiffPatch(input: {
  trackId: string;
  artifact: ArtifactKind;
  revision: ArtifactRevisionSummary;
  currentContent: string;
}): string {
  const changes = collectChangedLinePairs(input.currentContent, input.revision.content);
  const header = [
    `# SpecRail revision diff`,
    `track: ${input.trackId}`,
    `artifact: ${input.artifact}`,
    `revision: ${input.revision.id}`,
    `version: ${input.revision.version}`,
    `createdBy: ${input.revision.createdBy}`,
    `createdAt: ${input.revision.createdAt}`,
    `approvedAt: ${input.revision.approvedAt ?? "pending"}`,
    "",
    `--- current/${input.artifact}`,
    `+++ revision/${input.artifact}@${input.revision.id}`,
  ];

  const body = changes.length === 0
    ? ["# no changes"]
    : changes.flatMap((change) => [
      `@@ line ${change.lineNumber} @@`,
      ...(change.before !== undefined ? [`-${change.before}`] : []),
      ...(change.after !== undefined ? [`+${change.after}`] : []),
    ]);

  return [...header, ...body, ""].join("\n");
}

export async function exportRevisionDiffPatch(input: {
  trackId: string;
  artifact: ArtifactKind;
  revision: ArtifactRevisionSummary;
  currentContent: string;
  outputDirectory?: string;
  writeManifest?: boolean;
  exportedAt?: string;
}): Promise<string> {
  const outputDirectory = input.outputDirectory ?? process.cwd();
  const version = `v${input.revision.version}`;
  const filename = ["specrail", "revision-diff", input.trackId, input.artifact, version, input.revision.id]
    .map(sanitizePatchFilenamePart)
    .join("-");
  const filePath = join(outputDirectory, `${filename}.patch`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderRevisionDiffPatch(input), "utf8");

  if (input.writeManifest) {
    const manifestPath = join(outputDirectory, "specrail-revision-diff-exports.jsonl");
    await mkdir(dirname(manifestPath), { recursive: true });
    await appendFile(
      manifestPath,
      `${JSON.stringify({
        exportedAt: input.exportedAt ?? new Date().toISOString(),
        filePath,
        trackId: input.trackId,
        artifact: input.artifact,
        revisionId: input.revision.id,
        version: input.revision.version,
      })}\n`,
      "utf8",
    );
  }

  return filePath;
}

export async function loadRevisionDiffExportManifest(outputDirectory = process.cwd()): Promise<RevisionDiffExportManifestEntry[]> {
  const manifestPath = join(outputDirectory, "specrail-revision-diff-exports.jsonl");
  let content: string;

  try {
    content = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RevisionDiffExportManifestEntry);
}

function formatRevisionDiffExportManifest(entries: RevisionDiffExportManifestEntry[]): string {
  if (entries.length === 0) {
    return "No revision diff exports found.\n";
  }

  return `${entries
    .map((entry) => [entry.exportedAt, entry.trackId, entry.artifact, `v${entry.version}`, entry.revisionId, entry.filePath].join("\t"))
    .join("\n")}\n`;
}

function filterRevisionDiffExportManifest(
  entries: readonly RevisionDiffExportManifestEntry[],
  filters: { trackId?: string | null; artifact?: ArtifactKind | null },
): RevisionDiffExportManifestEntry[] {
  return entries
    .filter((entry) => (filters.trackId ? entry.trackId === filters.trackId : true))
    .filter((entry) => (filters.artifact ? entry.artifact === filters.artifact : true));
}

function parseRevisionDiffExportFilters(argv: readonly string[], usage: string): { trackId: string | null; artifact: ArtifactKind | null } {
  const trackFlagIndex = argv.indexOf("--track");
  const trackId = trackFlagIndex >= 0 ? argv[trackFlagIndex + 1]?.trim() : null;
  const artifactFlagIndex = argv.indexOf("--artifact");
  const artifact = artifactFlagIndex >= 0 ? argv[artifactFlagIndex + 1]?.trim().toLowerCase() : null;

  if (trackFlagIndex >= 0 && !trackId) {
    throw new Error(usage);
  }
  if (artifactFlagIndex >= 0 && (!artifact || artifact === "none" || !isPlanningMessageTemplateArtifact(artifact))) {
    throw new Error(usage);
  }

  return { trackId, artifact: artifact ? (artifact as ArtifactKind) : null };
}

function assertKnownTerminalCommandFlags(
  argv: readonly string[],
  allowedFlags: readonly string[],
  valueFlags: readonly string[],
  usage: string,
): void {
  const allowedFlagSet = new Set(allowedFlags);
  const valueFlagSet = new Set(valueFlags);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("-")) {
      continue;
    }
    if (!allowedFlagSet.has(arg)) {
      throw new Error(usage);
    }
    if (valueFlagSet.has(arg)) {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("-")) {
        throw new Error(usage);
      }
      index += 1;
    }
  }
}

function formatPlanningMessageTemplates(templates: readonly PlanningMessageTemplate[]): string {
  return `${templates
    .map((template, index) => [String(index + 1), template.name, template.kind, template.relatedArtifact].join("\t"))
    .join("\n")}\n`;
}

function renderTerminalCommandHelp(): string {
  return [
    "Usage: specrail-terminal [command]",
    "",
    "Commands:",
    "  report <runId> [--output <file>|-o <file>]  Print or write a completed-run Markdown report.",
    "  diff-exports [--json] [--limit <n>] [--track <trackId>] [--artifact <kind>]",
    "                                              List revision diff export manifest entries.",
    "  diff-export <index> [--track <trackId>] [--artifact <kind>] [--output <file>|-o <file>]",
    "                                              Print one listed revision diff export patch.",
    "  message-templates [--json] [--output <file>|-o <file>]",
    "                                              List or export planning-message templates.",
    "  help                                        Show this help output.",
    "",
    "Without a command, the interactive terminal UI starts.",
    "",
  ].join("\n");
}

function previewMultilineText(value: string, maxLength = 900): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 3)}...`;
}

export async function loadTerminalPreferences(path: string | null): Promise<Partial<TerminalPreferenceState>> {
  if (!path) {
    return {};
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalizedProjectId = typeof parsed.selectedProjectId === "string" ? parsed.selectedProjectId.trim() : undefined;
    const selectedProjectId = normalizedProjectId
      ? normalizedProjectId
      : parsed.selectedProjectId === null
        ? null
        : undefined;
    const normalizedRunFilter = typeof parsed.runFilter === "string" ? parsed.runFilter.trim().toLowerCase() : undefined;
    const runFilter = normalizedRunFilter === "active" || normalizedRunFilter === "terminal" || normalizedRunFilter === "all" ? normalizedRunFilter : undefined;
    const liveTailPaused = typeof parsed.liveTailPaused === "boolean" ? parsed.liveTailPaused : undefined;
    const showRunEventDetail = typeof parsed.showRunEventDetail === "boolean" ? parsed.showRunEventDetail : undefined;
    const refreshIntervalMs = typeof parsed.refreshIntervalMs === "number" && Number.isFinite(parsed.refreshIntervalMs) && parsed.refreshIntervalMs >= 0
      ? Math.round(parsed.refreshIntervalMs)
      : undefined;

    return {
      ...(selectedProjectId !== undefined ? { selectedProjectId } : {}),
      ...(runFilter ? { runFilter } : {}),
      ...(liveTailPaused !== undefined ? { liveTailPaused } : {}),
      ...(showRunEventDetail !== undefined ? { showRunEventDetail } : {}),
      ...(refreshIntervalMs !== undefined ? { refreshIntervalMs } : {}),
    };
  } catch {
    return {};
  }
}

export async function saveTerminalPreferences(path: string | null, preferences: TerminalPreferenceState): Promise<void> {
  if (!path) {
    return;
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort local UI preferences must never break operator workflows.
  }
}

async function resolveTerminalClientStartup(config: SpecRailTerminalClientConfig): Promise<{ config: SpecRailTerminalClientConfig; preferences: Partial<TerminalPreferenceState>; planningMessageTemplates: PlanningMessageTemplate[] }> {
  const [preferences, planningMessageTemplates] = await Promise.all([
    loadTerminalPreferences(config.preferencePath),
    loadPlanningMessageTemplates(config.messageTemplatesPath ?? null),
  ]);
  return {
    config: {
      ...config,
      initialProjectId: preferences.selectedProjectId !== undefined ? preferences.selectedProjectId : config.initialProjectId,
      initialRunFilter: preferences.runFilter ?? config.initialRunFilter,
      refreshIntervalMs: preferences.refreshIntervalMs ?? config.refreshIntervalMs,
    },
    preferences,
    planningMessageTemplates,
  };
}

export async function runTerminalApp(
  config: SpecRailTerminalClientConfig = loadTerminalClientConfig(),
  io: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } = { stdout: process.stdout, stdin: process.stdin },
): Promise<void> {
  const startup = await resolveTerminalClientStartup(config);
  const effectiveConfig = startup.config;
  const client = new SpecRailTerminalApiClient(effectiveConfig.apiBaseUrl);
  let state: TerminalAppState = {
    ...createEmptyTerminalState(effectiveConfig),
    runEvents: createEmptyRunEventFeedState(null, startup.preferences.liveTailPaused ?? false),
    showRunEventDetail: startup.preferences.showRunEventDetail ?? false,
    planningMessageTemplates: startup.planningMessageTemplates,
  };
  let disposed = false;
  let monitorSerial = 0;
  let monitorAbort: AbortController | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let preferenceSaveQueue: Promise<void> = Promise.resolve();

  const render = () => {
    io.stdout.write("\u001Bc");
    io.stdout.write(`${renderAppShell(state)}\n`);
  };

  const updateState = (nextState: TerminalAppState) => {
    state = nextState;
    render();
    syncRunMonitor();
  };

  const persistPreferences = (nextState: TerminalAppState) => {
    preferenceSaveQueue = preferenceSaveQueue.then(() => saveTerminalPreferences(effectiveConfig.preferencePath, {
      selectedProjectId: nextState.selectedProjectId ?? null,
      runFilter: nextState.runFilter,
      liveTailPaused: nextState.runEvents.paused,
      showRunEventDetail: nextState.showRunEventDetail ?? false,
      refreshIntervalMs: nextState.refreshIntervalMs,
    }));
    void preferenceSaveQueue;
  };

  const restartRefreshTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    if (state.refreshIntervalMs > 0) {
      refreshTimer = setInterval(() => void refresh(), state.refreshIntervalMs);
    }
  };

  const patchRunFeed = (patch: Partial<RunEventFeedState>) => {
    state = {
      ...state,
      runEvents: {
        ...state.runEvents,
        ...patch,
      },
    };
    render();
  };

  const syncRunMonitor = () => {
    const selectedRunId = state.runs.selectedId;
    const detailRun = state.runs.data?.run;
    const isSelectedDetail = detailRun?.id === selectedRunId ? detailRun : null;

    if (!selectedRunId) {
      if (monitorAbort) {
        monitorAbort.abort();
        monitorAbort = null;
      }
      if (state.runEvents.runId !== null || state.runEvents.connection !== "idle") {
        patchRunFeed(createEmptyRunEventFeedState(null));
      }
      return;
    }

    if (state.runEvents.paused) {
      if (monitorAbort) {
        monitorAbort.abort();
        monitorAbort = null;
      }
      if (state.runEvents.runId !== selectedRunId || state.runEvents.connection !== "paused") {
        patchRunFeed({ runId: selectedRunId, connection: "paused" });
      }
      return;
    }

    if (state.runEvents.runId === selectedRunId && (state.runEvents.connection === "live" || state.runEvents.connection === "connecting" || state.runEvents.connection === "reconnecting")) {
      return;
    }

    if (monitorAbort) {
      monitorAbort.abort();
      monitorAbort = null;
    }

    const controller = new AbortController();
    monitorAbort = controller;
    const serial = ++monitorSerial;
    const seenIds = new Set<string>((state.runEvents.runId === selectedRunId ? state.runEvents.items : []).map((event) => event.id));
    patchRunFeed({ ...createEmptyRunEventFeedState(selectedRunId), ...state.runEvents, runId: selectedRunId, paused: false, connection: "connecting" });

    const runLoop = async () => {
      let attempts = 0;

      while (!disposed && !controller.signal.aborted) {
        try {
          patchRunFeed({ connection: attempts === 0 ? "connecting" : "reconnecting", reconnectAttempts: attempts, lastError: null });

          for await (const event of client.streamRunEvents(selectedRunId, controller.signal)) {
            if (controller.signal.aborted || disposed || serial !== monitorSerial) {
              return;
            }

            if (seenIds.has(event.id)) {
              continue;
            }

            seenIds.add(event.id);
            state = {
              ...state,
              runEvents: appendRunEvents(
                {
                  ...state.runEvents,
                  runId: selectedRunId,
                  connection: "live",
                  reconnectAttempts: attempts,
                  lastError: null,
                },
                [event],
              ),
            };
            render();
          }

          const latestStatus = state.runs.data?.run.id === selectedRunId ? state.runs.data.run.status : isSelectedDetail?.status;
          if (latestStatus && isTerminalRunStatus(latestStatus)) {
            patchRunFeed({ connection: "closed" });
            return;
          }

          attempts += 1;
          patchRunFeed({ connection: "reconnecting", reconnectAttempts: attempts, lastError: "stream ended, retrying" });
          await delay(Math.min(1000 * attempts, 5000), controller.signal);
        } catch (error) {
          if (controller.signal.aborted || disposed || serial !== monitorSerial) {
            return;
          }

          attempts += 1;
          patchRunFeed({
            connection: "reconnecting",
            reconnectAttempts: attempts,
            lastError: error instanceof Error ? error.message : "Run event stream failed",
          });
          await delay(Math.min(1000 * attempts, 5000), controller.signal);
        }
      }
    };

    void runLoop().catch((error) => {
      if (!controller.signal.aborted && !disposed && serial === monitorSerial) {
        patchRunFeed({ connection: "error", lastError: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const refresh = async () => {
    state = { ...state, loading: true, error: null, statusLine: "Refreshing terminal snapshot..." };
    render();

    try {
      const refreshed = state.summary ? await refreshTerminalState(state, client) : await bootstrapTerminalState(effectiveConfig, client);
      updateState({ ...refreshed, planningMessageTemplates: state.planningMessageTemplates });
    } catch (error) {
      updateState({
        ...state,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to refresh terminal snapshot.",
        statusLine: error instanceof Error ? error.message : "Failed to refresh terminal snapshot.",
      });
    }
  };

  const decideSelectedTrackApproval = async (decision: "approve" | "reject") => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: `Switch to the tracks screen to ${decision} pending requests.` });
      return;
    }

    const selectedApproval = resolveSelectedPendingApproval(state);
    if (!selectedApproval) {
      updateState({ ...state, statusLine: `No pending approval request available to ${decision}.` });
      return;
    }

    state = {
      ...state,
      pendingTrackAction: { kind: decision, approvalRequestId: selectedApproval.id },
      statusLine: `${decision === "approve" ? "Approving" : "Rejecting"} ${selectedApproval.id}...`,
    };
    render();

    try {
      await client.decideApprovalRequest(selectedApproval.id, decision);
      updateState(await refreshTerminalState(state, client));
      updateState({
        ...state,
        statusLine: `${decision === "approve" ? "Approved" : "Rejected"} ${selectedApproval.id}.`,
        pendingTrackAction: null,
      });
    } catch (error) {
      updateState({
        ...state,
        pendingTrackAction: null,
        error: error instanceof Error ? error.message : `Failed to ${decision} approval request.`,
        statusLine: error instanceof Error ? error.message : `Failed to ${decision} approval request.`,
      });
    }
  };

  const exportSelectedRevisionDiff = async () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to export a revision diff." });
      return;
    }

    const detail = state.tracks.data;
    const workspace = detail?.planningWorkspace;
    if (!detail || detail.track.id !== state.tracks.selectedId || !workspace) {
      updateState({ ...state, statusLine: "Track planning detail is still loading. Press r and try again." });
      return;
    }

    const artifact = workspace.selectedArtifact;
    const revision = workspace.revisions[artifact].find((candidate) => candidate.id === workspace.selectedRevisionId)
      ?? workspace.revisions[artifact][0]
      ?? null;

    if (!revision) {
      updateState({ ...state, statusLine: `No ${artifact} revision available to export.` });
      return;
    }

    try {
      const filePath = await exportRevisionDiffPatch({
        trackId: detail.track.id,
        artifact,
        revision,
        currentContent: detail.artifacts[artifact],
        outputDirectory: effectiveConfig.diffExportDirectory ?? undefined,
        writeManifest: true,
      });
      updateState({ ...state, statusLine: `Exported ${artifact} revision diff to ${filePath}.` });
    } catch (error) {
      updateState({
        ...state,
        error: error instanceof Error ? error.message : "Failed to export revision diff.",
        statusLine: error instanceof Error ? error.message : "Failed to export revision diff.",
      });
    }
  };

  const beginExecutionAction = (action: PendingExecutionActionState) => {
    updateState({
      ...state,
      pendingExecutionAction: action,
      pendingPlanningMessageAction: null,
      pendingPlanningSessionSelection: null,
      pendingPlanningSessionCreate: null,
      pendingWorkspaceCleanupAction: null,
      statusLine:
        action.kind === "start"
          ? `Composing run start for ${action.trackId}.`
          : action.kind === "resume"
            ? `Composing run resume for ${action.runId}.`
            : `Confirm cancellation for ${action.runId}.`,
    });
  };

  const openStartRunComposer = () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to start a run." });
      return;
    }

    const detail = state.tracks.data;
    if (!detail || detail.track.id !== state.tracks.selectedId) {
      updateState({ ...state, statusLine: "Track detail is still loading. Press r and try again." });
      return;
    }

    beginExecutionAction(createExecutionActionDraft({
      kind: "start",
      scope: "track",
      trackId: detail.track.id,
      planningSessionId: detail.planningContext?.planningSessionId,
      backend: "codex",
      profile: "default",
      prompt: `Implement ${detail.track.title}`,
      workspacePath: resolveTrackDefaultWorkspacePath({ track: detail.track, projects: state.summary?.projects, fallbackPath: process.cwd() }),
      message: detail.planningContext?.hasPendingChanges ? "This track currently has pending planning changes. Start will fail until approvals are resolved." : null,
    }));
  };

  const openResumeRunComposer = () => {
    if (state.screen !== "runs") {
      updateState({ ...state, statusLine: "Switch to the runs screen to resume a run." });
      return;
    }

    const run = state.runs.data?.run;
    if (!run || run.id !== state.runs.selectedId) {
      updateState({ ...state, statusLine: "Run detail is still loading. Press r and try again." });
      return;
    }

    if (!(run.status === "completed" || run.status === "failed" || run.status === "cancelled")) {
      updateState({ ...state, statusLine: `Run ${run.id} is ${run.status}; resume is only available after a terminal state.` });
      return;
    }

    beginExecutionAction(createExecutionActionDraft({
      kind: "resume",
      scope: "run",
      runId: run.id,
      trackId: run.trackId,
      planningSessionId: run.planningSessionId,
      backend: run.backend ?? "codex",
      profile: run.profile ?? "default",
      prompt: `Continue run ${run.id}`,
      message: run.planningContextStale ? `Planning context is stale: ${run.planningContextStaleReason ?? "approved plan changed after launch"}` : null,
    }));
  };

  const openCancelRunComposer = () => {
    if (state.screen !== "runs") {
      updateState({ ...state, statusLine: "Switch to the runs screen to cancel a run." });
      return;
    }

    const run = state.runs.data?.run;
    if (!run || run.id !== state.runs.selectedId) {
      updateState({ ...state, statusLine: "Run detail is still loading. Press r and try again." });
      return;
    }

    if (!(run.status === "running" || run.status === "waiting_approval")) {
      updateState({ ...state, statusLine: `Run ${run.id} is ${run.status}; cancel is only available while it is active.` });
      return;
    }

    beginExecutionAction(createExecutionActionDraft({
      kind: "cancel",
      scope: "run",
      runId: run.id,
      trackId: run.trackId,
      backend: run.backend ?? "codex",
      profile: run.profile ?? "default",
      message: "SpecRail will ask the backend adapter to stop the active session.",
    }));
  };

  const openProposalComposer = () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to propose a revision." });
      return;
    }

    const detail = state.tracks.data;
    const workspace = detail?.planningWorkspace;
    if (!detail || detail.track.id !== state.tracks.selectedId || !workspace) {
      updateState({ ...state, statusLine: "Track detail is still loading. Press r and try again." });
      return;
    }

    const artifact = workspace.selectedArtifact;
    updateState({
      ...state,
      pendingExecutionAction: null,
      pendingProposalAction: {
        trackId: detail.track.id,
        artifact,
        summary: `Update ${artifact} for ${detail.track.title}`,
        content: detail.artifacts[artifact],
        createdBy: "user",
        activeField: "content",
        submitting: false,
        message: null,
      },
      pendingPlanningMessageAction: null,
      pendingPlanningSessionSelection: null,
      pendingPlanningSessionCreate: null,
      statusLine: `Composing ${artifact} revision proposal for ${detail.track.id}.`,
    });
  };

  const openPlanningMessageComposer = () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to append a planning message." });
      return;
    }

    const detail = state.tracks.data;
    const workspace = detail?.planningWorkspace;
    if (!detail || detail.track.id !== state.tracks.selectedId || !workspace) {
      updateState({ ...state, statusLine: "Track detail is still loading. Press r and try again." });
      return;
    }

    const planningSessionId = workspace.selectedPlanningSessionId;
    if (!planningSessionId) {
      updateState({ ...state, statusLine: `Track ${detail.track.id} has no planning session to append to.` });
      return;
    }

    updateState({
      ...state,
      pendingExecutionAction: null,
      pendingProposalAction: null,
      pendingPlanningSessionSelection: null,
      pendingPlanningSessionCreate: null,
      pendingPlanningMessageAction: {
        trackId: detail.track.id,
        planningSessionId,
        authorType: "user",
        kind: "message",
        relatedArtifact: workspace.selectedArtifact ?? "none",
        body: "",
        templateIndex: 0,
        submitting: false,
        message: null,
      },
      pendingWorkspaceCleanupAction: null,
      statusLine: `Composing planning message for ${planningSessionId}.`,
    });
  };

  const updateExecutionComposer = (next: PendingExecutionActionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingExecutionAction: next, statusLine });
  };

  const updateProposalComposer = (next: PendingProposalActionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingProposalAction: next, statusLine });
  };

  const updatePlanningMessageComposer = (next: PendingPlanningMessageActionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingPlanningMessageAction: next, statusLine });
  };

  const updatePlanningSessionSelection = (next: PendingPlanningSessionSelectionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingPlanningSessionSelection: next, statusLine });
  };

  const updateWorkspaceCleanupComposer = (next: PendingWorkspaceCleanupActionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingWorkspaceCleanupAction: next, statusLine });
  };

  const openWorkspaceCleanupPreview = async () => {
    if (state.screen !== "runs") {
      updateState({ ...state, statusLine: "Switch to the runs screen to preview workspace cleanup." });
      return;
    }

    const run = state.runs.data?.run;
    if (!run || run.id !== state.runs.selectedId) {
      updateState({ ...state, statusLine: "Run detail is still loading. Press r and try again." });
      return;
    }

    if (!(run.status === "completed" || run.status === "failed" || run.status === "cancelled")) {
      updateState({ ...state, statusLine: `Run ${run.id} is ${run.status}; cleanup is only available after a terminal state.` });
      return;
    }

    state = {
      ...state,
      pendingExecutionAction: null,
      pendingProposalAction: null,
      pendingPlanningMessageAction: null,
      pendingWorkspaceCleanupAction: null,
      statusLine: `Loading cleanup preview for ${run.id}...`,
    };
    render();

    try {
      const preview = await client.previewWorkspaceCleanup(run.id);
      updateWorkspaceCleanupComposer({
        runId: run.id,
        preview,
        result: null,
        phase: "preview",
        submitting: false,
        message: preview.cleanupPlan.eligible
          ? "Press Enter to request the server confirmation phrase before applying cleanup."
          : "Cleanup is not eligible; apply is disabled.",
      }, preview.cleanupPlan.eligible ? `Cleanup preview ready for ${run.id}.` : `Cleanup preview refused for ${run.id}.`);
    } catch (error) {
      updateState({
        ...state,
        error: error instanceof Error ? error.message : "Failed to preview workspace cleanup.",
        statusLine: error instanceof Error ? error.message : "Failed to preview workspace cleanup.",
      });
    }
  };

  const adjustRefreshInterval = (deltaMs: number) => {
    const nextInterval = clampIndex(state.refreshIntervalMs + deltaMs, MAX_REFRESH_INTERVAL_MS + 1);
    const nextState: TerminalAppState = {
      ...state,
      refreshIntervalMs: nextInterval,
      statusLine: nextInterval > 0 ? `Refresh interval set to ${nextInterval}ms.` : "Automatic refresh disabled; press r to refresh manually.",
    };
    updateState(nextState);
    persistPreferences(nextState);
    restartRefreshTimer();
  };

  const moveRunEventDetailSelection = (delta: number) => {
    if (state.screen !== "runs") {
      updateState({ ...state, statusLine: "Switch to the runs screen to select event detail." });
      return;
    }

    const eventCount = state.runEvents.items.length;
    if (eventCount === 0) {
      updateState({ ...state, statusLine: "No cached run events to inspect yet." });
      return;
    }

    const currentIndex = resolveRunEventDetailIndex(state.runEvents.items, state.runEventDetailIndex ?? null) ?? eventCount - 1;
    const nextIndex = clampIndex(currentIndex + delta, eventCount);
    const event = state.runEvents.items[nextIndex];
    updateState({
      ...state,
      showRunEventDetail: true,
      runEventDetailIndex: nextIndex,
      statusLine: event ? `Selected event detail ${nextIndex + 1}/${eventCount}: ${event.type}.` : `Selected event detail ${nextIndex + 1}/${eventCount}.`,
    });
  };

  const toggleRunTailPause = () => {
    if (state.screen !== "runs") {
      updateState({ ...state, statusLine: "Switch to the runs screen to control the live tail." });
      return;
    }

    if (!state.runs.selectedId) {
      updateState({ ...state, statusLine: "Select a run first to control the live tail." });
      return;
    }

    const nextPaused = !state.runEvents.paused;
    const nextState: TerminalAppState = {
      ...state,
      runEvents: {
        ...state.runEvents,
        runId: state.runs.selectedId,
        paused: nextPaused,
        connection: nextPaused ? "paused" : "idle",
        lastError: nextPaused ? state.runEvents.lastError : null,
      },
      statusLine: nextPaused ? `Paused live tail for ${state.runs.selectedId}.` : `Resumed live tail for ${state.runs.selectedId}.`,
    };
    updateState(nextState);
    persistPreferences(nextState);
  };

  const editExecutionPrompt = (updater: (value: string) => string) => {
    const action = state.pendingExecutionAction;
    if (!action || action.kind === "cancel" || action.submitting) {
      return;
    }

    const activeField = action.activeField ?? "prompt";
    if (activeField === "workspacePath" && action.kind === "start") {
      updateExecutionComposer({ ...action, workspacePath: updater(action.workspacePath ?? ""), folderSessions: undefined, folderSessionPreview: null, message: null });
      return;
    }

    updateExecutionComposer({ ...action, prompt: updater(action.prompt), message: null });
  };

  const cycleExecutionField = () => {
    const action = state.pendingExecutionAction;
    if (!action || action.kind !== "start" || action.submitting) {
      return;
    }

    const activeField = (action.activeField ?? "prompt") === "prompt" ? "workspacePath" : "prompt";
    updateExecutionComposer({ ...action, activeField, message: null }, `Editing execution ${activeField}.`);
  };

  const previewFolderSessions = async () => {
    const action = state.pendingExecutionAction;
    if (!action || action.kind !== "start" || action.submitting) {
      return;
    }

    const workspacePath = action.workspacePath?.trim();
    if (!workspacePath) {
      updateExecutionComposer({ ...action, message: "Folder path is required before previewing folder sessions." }, "Folder path is required before previewing folder sessions.");
      return;
    }

    state = {
      ...state,
      pendingExecutionAction: { ...action, submitting: true, message: `Looking up sessions for ${workspacePath}...` },
      statusLine: `Looking up sessions for ${workspacePath}...`,
    };
    render();

    try {
      const sessions = await client.listRunsByWorkspacePath(workspacePath);
      const selectedIndex = clampIndex(action.selectedFolderSessionIndex ?? 0, sessions.length);
      const selectedRun = sessions[selectedIndex];
      const preview = selectedRun ? await client.loadRunSessionPreview(selectedRun.id, 5) : null;
      updateExecutionComposer({
        ...action,
        submitting: false,
        folderSessions: sessions,
        selectedFolderSessionIndex: selectedIndex,
        folderSessionPreview: preview,
        message: sessions.length > 0 ? "Folder sessions loaded. Ctrl+R resumes selected, Ctrl+K forks selected, Enter starts fresh." : "No folder sessions found. Enter starts fresh.",
      }, sessions.length > 0 ? `Loaded ${sessions.length} folder session(s).` : "No folder sessions found.");
    } catch (error) {
      updateExecutionComposer({
        ...action,
        submitting: false,
        message: error instanceof Error ? error.message : "Failed to preview folder sessions.",
      }, error instanceof Error ? error.message : "Failed to preview folder sessions.");
    }
  };

  const selectFolderSession = async (delta: number) => {
    const action = state.pendingExecutionAction;
    const sessions = action?.folderSessions ?? [];
    if (!action || action.kind !== "start" || action.submitting || sessions.length === 0) {
      return;
    }

    const selectedIndex = clampIndex((action.selectedFolderSessionIndex ?? 0) + delta, sessions.length);
    const selectedRun = sessions[selectedIndex];
    updateExecutionComposer({ ...action, selectedFolderSessionIndex: selectedIndex, folderSessionPreview: null, message: selectedRun ? `Selected folder session ${selectedRun.id}; loading preview...` : null }, selectedRun ? `Selected folder session ${selectedRun.id}.` : state.statusLine);
    if (!selectedRun) {
      return;
    }

    try {
      const preview = await client.loadRunSessionPreview(selectedRun.id, 5);
      const latestAction = state.pendingExecutionAction;
      if (latestAction?.kind === "start") {
        updateExecutionComposer({ ...latestAction, folderSessionPreview: preview, message: `Selected folder session ${selectedRun.id}. Ctrl+R resumes, Ctrl+K forks.` }, `Selected folder session ${selectedRun.id}.`);
      }
    } catch (error) {
      const latestAction = state.pendingExecutionAction;
      if (latestAction?.kind === "start") {
        updateExecutionComposer({ ...latestAction, message: error instanceof Error ? error.message : "Failed to load session preview." }, error instanceof Error ? error.message : "Failed to load session preview.");
      }
    }
  };

  const continueSelectedFolderSession = (kind: "resume" | "fork") => {
    const action = state.pendingExecutionAction;
    const sessions = action?.folderSessions ?? [];
    const selectedRun = sessions[clampIndex(action?.selectedFolderSessionIndex ?? 0, sessions.length)];
    if (!action || action.kind !== "start" || !selectedRun) {
      updateExecutionComposer(action ? { ...action, message: "Preview and select a folder session first." } : null, "Preview and select a folder session first.");
      return;
    }

    beginExecutionAction(createExecutionActionDraft({
      kind,
      scope: "run",
      runId: selectedRun.id,
      trackId: selectedRun.trackId,
      planningSessionId: action.planningSessionId,
      backend: selectedRun.backend ?? action.backend,
      profile: selectedRun.profile ?? action.profile,
      prompt: action.prompt,
      message: kind === "resume" ? `Resuming folder session ${selectedRun.id}.` : `Forking folder session ${selectedRun.id}.`,
    }));
  };

  const editExecutionProfile = (updater: (value: string) => string) => {
    const action = state.pendingExecutionAction;
    if (!action || action.kind === "cancel" || action.submitting) {
      return;
    }

    updateExecutionComposer({ ...action, profile: updater(action.profile), message: null });
  };

  const cycleExecutionBackend = () => {
    const action = state.pendingExecutionAction;
    if (!action || action.kind !== "start" || action.submitting) {
      return;
    }

    const currentIndex = EXECUTION_BACKEND_OPTIONS.findIndex((backend) => backend === action.backend);
    const nextBackend = EXECUTION_BACKEND_OPTIONS[(currentIndex + 1 + EXECUTION_BACKEND_OPTIONS.length) % EXECUTION_BACKEND_OPTIONS.length] ?? action.backend;
    updateExecutionComposer({ ...action, backend: nextBackend, message: `Backend switched to ${nextBackend}.` }, `Backend switched to ${nextBackend}.`);
  };

  const editProposalField = (updater: (value: string) => string) => {
    const action = state.pendingProposalAction;
    if (!action || action.submitting) {
      return;
    }

    const field = action.activeField;
    updateProposalComposer({ ...action, [field]: updater(action[field]), message: null } as PendingProposalActionState);
  };

  const cycleProposalField = () => {
    const action = state.pendingProposalAction;
    if (!action || action.submitting) {
      return;
    }

    const activeField = action.activeField === "summary" ? "content" : "summary";
    updateProposalComposer({ ...action, activeField, message: null }, `Editing proposal ${activeField}.`);
  };

  const cycleProposalAuthor = () => {
    const action = state.pendingProposalAction;
    if (!action || action.submitting) {
      return;
    }

    const authors = ["user", "agent", "system"] as const;
    const currentIndex = authors.findIndex((author) => author === action.createdBy);
    const createdBy = authors[(currentIndex + 1 + authors.length) % authors.length] ?? action.createdBy;
    updateProposalComposer({ ...action, createdBy, message: `Proposal author set to ${createdBy}.` }, `Proposal author set to ${createdBy}.`);
  };

  const openPlanningSessionSelection = () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to select planning sessions." });
      return;
    }

    const detail = state.tracks.data;
    const workspace = detail?.planningWorkspace;
    if (!detail || detail.track.id !== state.tracks.selectedId || !workspace) {
      updateState({ ...state, statusLine: "Track detail is still loading. Press r and try again." });
      return;
    }

    if (workspace.planningSessions.length === 0) {
      updateState({ ...state, statusLine: `Track ${detail.track.id} has no planning sessions.` });
      return;
    }

    const currentIndex = Math.max(0, workspace.planningSessions.findIndex((session) => session.id === workspace.selectedPlanningSessionId));
    updateState({
      ...state,
      pendingExecutionAction: null,
      pendingProposalAction: null,
      pendingPlanningMessageAction: null,
      pendingPlanningSessionCreate: null,
      pendingPlanningSessionSelection: {
        trackId: detail.track.id,
        selectedIndex: currentIndex,
        submitting: false,
        message: null,
      },
      pendingWorkspaceCleanupAction: null,
      statusLine: `Selecting planning session for ${detail.track.id}.`,
    });
  };

  const movePlanningSessionSelection = (delta: number) => {
    const action = state.pendingPlanningSessionSelection;
    const sessions = state.tracks.data?.planningWorkspace?.planningSessions ?? [];
    if (!action || action.submitting || sessions.length === 0) {
      return;
    }

    const selectedIndex = (action.selectedIndex + delta + sessions.length) % sessions.length;
    updatePlanningSessionSelection({ ...action, selectedIndex, message: null }, `Planning session ${sessions[selectedIndex]?.id ?? "unknown"} highlighted.`);
  };

  const submitPlanningSessionSelection = async () => {
    const action = state.pendingPlanningSessionSelection;
    const detail = state.tracks.data;
    const workspace = detail?.planningWorkspace;
    if (!action || action.submitting || !detail || !workspace) {
      return;
    }

    const nextSession = workspace.planningSessions[action.selectedIndex];
    if (!nextSession) {
      updatePlanningSessionSelection({ ...action, message: "Select a planning session first." }, "Select a planning session first.");
      return;
    }

    state = {
      ...state,
      pendingPlanningSessionSelection: { ...action, submitting: true, message: `Loading ${nextSession.id}...` },
      statusLine: `Loading planning messages for ${nextSession.id}...`,
    };
    render();

    try {
      const planningMessages = await client.loadPlanningMessages(nextSession.id);
      updateState({
        ...state,
        pendingPlanningSessionSelection: null,
        tracks: {
          ...state.tracks,
          data: {
            ...detail,
            planningWorkspace: {
              ...workspace,
              selectedPlanningSessionId: nextSession.id,
              planningMessages,
            },
          },
        },
        statusLine: `Selected planning session ${nextSession.id}.`,
      });
    } catch (error) {
      updateState({
        ...state,
        error: error instanceof Error ? error.message : "Failed to load planning messages.",
        statusLine: error instanceof Error ? error.message : "Failed to load planning messages.",
        pendingPlanningSessionSelection: { ...action, submitting: false, message: "Failed to load planning messages." },
      });
    }
  };

  const cycleSelectedPlanningSessionStatus = async () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to update a planning session." });
      return;
    }

    const detail = state.tracks.data;
    const workspace = detail?.planningWorkspace;
    if (!detail || detail.track.id !== state.tracks.selectedId || !workspace) {
      updateState({ ...state, statusLine: "Track planning detail is still loading. Press r and try again." });
      return;
    }

    const currentSession = workspace.planningSessions.find((session) => session.id === workspace.selectedPlanningSessionId) ?? workspace.planningSessions[0] ?? null;
    if (!currentSession) {
      updateState({ ...state, statusLine: `Track ${detail.track.id} has no planning session to update.` });
      return;
    }

    const nextStatus = nextPlanningSessionStatus(currentSession.status as PlanningSessionStatus);
    updateState({ ...state, statusLine: `Updating planning session ${currentSession.id} to ${nextStatus}...` });

    try {
      const planningSession = await client.updatePlanningSession(currentSession.id, nextStatus);
      const refreshedDetail = await client.loadTrackDetail(detail.track.id);
      const workspace = refreshedDetail.planningWorkspace;
      const planningMessages = await client.loadPlanningMessages(planningSession.id);
      updateState({
        ...state,
        tracks: {
          ...state.tracks,
          data: workspace
            ? {
              ...refreshedDetail,
              planningWorkspace: {
                ...workspace,
                selectedPlanningSessionId: planningSession.id,
                planningMessages,
              },
            }
            : refreshedDetail,
        },
        statusLine: `Updated planning session ${planningSession.id} to ${planningSession.status}.`,
      });
    } catch (error) {
      updateState({
        ...state,
        error: error instanceof Error ? error.message : "Failed to update planning session.",
        statusLine: error instanceof Error ? error.message : "Failed to update planning session.",
      });
    }
  };

  const openPlanningSessionCreateComposer = () => {
    if (state.screen !== "tracks") {
      updateState({ ...state, statusLine: "Switch to the tracks screen to create a planning session." });
      return;
    }

    const detail = state.tracks.data;
    if (!detail || detail.track.id !== state.tracks.selectedId) {
      updateState({ ...state, statusLine: "Track detail is still loading. Press r and try again." });
      return;
    }

    updateState({
      ...state,
      pendingExecutionAction: null,
      pendingProposalAction: null,
      pendingPlanningMessageAction: null,
      pendingPlanningSessionSelection: null,
      pendingPlanningSessionCreate: {
        trackId: detail.track.id,
        status: "active",
        submitting: false,
        message: null,
      },
      pendingWorkspaceCleanupAction: null,
      statusLine: `Composing planning session creation for ${detail.track.id}.`,
    });
  };

  const cyclePlanningSessionCreateStatus = () => {
    const action = state.pendingPlanningSessionCreate;
    if (!action || action.submitting) {
      return;
    }

    const status = nextPlanningSessionStatus(action.status);
    updateState({
      ...state,
      pendingPlanningSessionCreate: { ...action, status, message: `Planning session status set to ${status}.` },
      statusLine: `Planning session status set to ${status}.`,
    });
  };

  const submitPlanningSessionCreate = async () => {
    const action = state.pendingPlanningSessionCreate;
    if (!action || action.submitting) {
      return;
    }

    state = {
      ...state,
      pendingPlanningSessionCreate: { ...action, submitting: true, message: null },
      statusLine: `Creating ${action.status} planning session for ${action.trackId}...`,
    };
    render();

    try {
      const planningSession = await client.createPlanningSession(action.trackId, action.status);
      const refreshedDetail = await client.loadTrackDetail(action.trackId);
      const workspace = refreshedDetail.planningWorkspace;
      if (!workspace) {
        throw new Error("Track planning workspace was unavailable after session creation.");
      }
      const planningMessages = await client.loadPlanningMessages(planningSession.id);
      updateState({
        ...state,
        pendingPlanningSessionCreate: null,
        tracks: {
          ...state.tracks,
          data: {
            ...refreshedDetail,
            planningWorkspace: {
              ...workspace,
              selectedPlanningSessionId: planningSession.id,
              planningMessages,
            },
          },
        },
        statusLine: `Created ${planningSession.status} planning session ${planningSession.id}.`,
      });
    } catch (error) {
      updateState({
        ...state,
        pendingPlanningSessionCreate: { ...action, submitting: false, message: error instanceof Error ? error.message : "Failed to create planning session." },
        error: error instanceof Error ? error.message : "Failed to create planning session.",
        statusLine: error instanceof Error ? error.message : "Failed to create planning session.",
      });
    }
  };

  const submitProposalAction = async () => {
    const action = state.pendingProposalAction;
    if (!action || action.submitting) {
      return;
    }

    if (action.content.trim().length === 0) {
      updateProposalComposer({ ...action, message: "Proposal content is required." }, "Proposal content is required.");
      return;
    }

    state = {
      ...state,
      pendingProposalAction: { ...action, submitting: true, message: null },
      statusLine: `Creating ${action.artifact} revision proposal...`,
    };
    render();

    try {
      const result = await client.proposeArtifactRevision({
        trackId: action.trackId,
        artifact: action.artifact,
        content: action.content,
        summary: action.summary.trim() || undefined,
        createdBy: action.createdBy,
      });

      const refreshed = await refreshTerminalState({ ...state, pendingProposalAction: null }, client);
      const nextWorkspace = refreshed.tracks.data?.planningWorkspace;
      updateState({
        ...refreshed,
        tracks: refreshed.tracks.data && nextWorkspace ? {
          ...refreshed.tracks,
          data: {
            ...refreshed.tracks.data,
            planningWorkspace: {
              ...nextWorkspace,
              selectedArtifact: action.artifact,
              selectedRevisionId: result.revision.id,
              selectedApprovalRequestId: result.approvalRequest.id,
            },
          },
        } : refreshed.tracks,
        statusLine: `Proposed ${action.artifact} revision v${result.revision.version}. Approval request ${result.approvalRequest.id} is pending.`,
      });
    } catch (error) {
      updateState({
        ...state,
        pendingProposalAction: {
          ...action,
          submitting: false,
          message: error instanceof Error ? error.message : "Failed to propose revision.",
        },
        error: error instanceof Error ? error.message : "Failed to propose revision.",
        statusLine: error instanceof Error ? error.message : "Failed to propose revision.",
      });
    }
  };

  const editPlanningMessageBody = (updater: (value: string) => string) => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    updatePlanningMessageComposer({ ...action, body: updater(action.body), message: null });
  };

  const editPlanningMessageBodyWithEditor = async () => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    const setRawMode = typeof io.stdin.setRawMode === "function" ? io.stdin.setRawMode.bind(io.stdin) : null;
    updatePlanningMessageComposer({ ...action, message: `Opening ${resolveTerminalEditor()}...` }, "Opening editor for planning message body...");

    try {
      setRawMode?.(false);
      const body = await editTextWithTerminalEditor(action.body);
      updatePlanningMessageComposer({ ...action, body, message: "Planning message body updated from editor." }, "Planning message body updated from editor.");
    } catch (error) {
      updatePlanningMessageComposer({ ...action, message: error instanceof Error ? error.message : "Editor failed." }, error instanceof Error ? error.message : "Editor failed.");
    } finally {
      setRawMode?.(true);
    }
  };

  const applyPlanningMessageTemplate = () => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    const templates = state.planningMessageTemplates?.length ? state.planningMessageTemplates : [...PLANNING_MESSAGE_TEMPLATES];
    const template = templates[action.templateIndex % templates.length] ?? templates[0];
    const body = action.body.trim().length > 0 ? `${action.body}\n\n${template.body}` : template.body;
    const templateIndex = (action.templateIndex + 1) % templates.length;
    updatePlanningMessageComposer(
      {
        ...action,
        kind: template.kind,
        relatedArtifact: template.relatedArtifact,
        body,
        templateIndex,
        message: `Applied ${template.name} template.`,
      },
      `Applied ${template.name} planning-message template.`,
    );
  };

  const cyclePlanningMessageAuthor = () => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    const authors = ["user", "agent", "system"] as const;
    const currentIndex = authors.findIndex((author) => author === action.authorType);
    const authorType = authors[(currentIndex + 1 + authors.length) % authors.length] ?? action.authorType;
    updatePlanningMessageComposer({ ...action, authorType, message: `Planning message author set to ${authorType}.` }, `Planning message author set to ${authorType}.`);
  };

  const cyclePlanningMessageKind = () => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    const kinds = ["message", "question", "decision", "note"] as const;
    const currentIndex = kinds.findIndex((kind) => kind === action.kind);
    const kind = kinds[(currentIndex + 1 + kinds.length) % kinds.length] ?? action.kind;
    updatePlanningMessageComposer({ ...action, kind, message: `Planning message kind set to ${kind}.` }, `Planning message kind set to ${kind}.`);
  };

  const cyclePlanningMessageArtifact = (delta: number) => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    const artifacts = ["none", "spec", "plan", "tasks"] as const;
    const currentIndex = artifacts.findIndex((artifact) => artifact === action.relatedArtifact);
    const relatedArtifact = artifacts[(currentIndex + delta + artifacts.length) % artifacts.length] ?? action.relatedArtifact;
    updatePlanningMessageComposer({ ...action, relatedArtifact, message: `Related artifact set to ${relatedArtifact}.` }, `Related artifact set to ${relatedArtifact}.`);
  };

  const submitPlanningMessageAction = async () => {
    const action = state.pendingPlanningMessageAction;
    if (!action || action.submitting) {
      return;
    }

    const body = action.body.trim();
    if (body.length === 0) {
      updatePlanningMessageComposer({ ...action, message: "Planning message body is required." }, "Planning message body is required.");
      return;
    }

    state = {
      ...state,
      pendingPlanningMessageAction: { ...action, submitting: true, message: null },
      statusLine: `Appending planning message to ${action.planningSessionId}...`,
    };
    render();

    try {
      const message = await client.appendPlanningMessage({
        planningSessionId: action.planningSessionId,
        authorType: action.authorType,
        kind: action.kind,
        body,
        relatedArtifact: action.relatedArtifact === "none" ? undefined : action.relatedArtifact,
      });
      const refreshed = await refreshTerminalState({ ...state, pendingPlanningMessageAction: null }, client);
      updateState({
        ...refreshed,
        statusLine: `Appended planning message ${message.id} to ${action.planningSessionId}.`,
      });
    } catch (error) {
      updateState({
        ...state,
        pendingPlanningMessageAction: {
          ...action,
          submitting: false,
          message: error instanceof Error ? error.message : "Failed to append planning message.",
        },
        error: error instanceof Error ? error.message : "Failed to append planning message.",
        statusLine: error instanceof Error ? error.message : "Failed to append planning message.",
      });
    }
  };

  const submitWorkspaceCleanupAction = async () => {
    const action = state.pendingWorkspaceCleanupAction;
    if (!action || action.submitting) {
      return;
    }

    if (!action.preview.cleanupPlan.eligible) {
      updateWorkspaceCleanupComposer({ ...action, message: "Cleanup preview is not eligible; apply is disabled." }, "Cleanup preview is not eligible.");
      return;
    }

    const confirmation = action.result?.expectedConfirmation ?? "";
    state = {
      ...state,
      pendingWorkspaceCleanupAction: { ...action, submitting: true, phase: confirmation ? "applying" : "preview", message: null },
      statusLine: confirmation ? `Applying workspace cleanup for ${action.runId}...` : `Requesting cleanup confirmation for ${action.runId}...`,
    };
    render();

    try {
      const result = await client.applyWorkspaceCleanup(action.runId, confirmation);
      const nextPhase = confirmation && result.cleanupResult.applied ? "done" : "confirmation_ready";
      const nextCleanupAction: PendingWorkspaceCleanupActionState = {
        ...action,
        result,
        phase: nextPhase,
        submitting: false,
        message: confirmation
          ? `Cleanup ${result.cleanupResult.status}; ${result.cleanupResult.operations.length} operation(s) returned.`
          : "Server confirmation phrase received. Press Enter again to apply cleanup with that exact phrase.",
      };

      if (!confirmation) {
        updateWorkspaceCleanupComposer(nextCleanupAction, `Workspace cleanup confirmation ready for ${action.runId}.`);
        return;
      }

      try {
        const [runDetail, events] = await Promise.all([
          client.loadRunDetail(action.runId),
          client.loadRunEvents(action.runId),
        ]);
        updateState(syncRunEventSelection({
          ...state,
          pendingWorkspaceCleanupAction: nextCleanupAction,
          runs: {
            ...state.runs,
            data: runDetail,
            error: null,
          },
          runEvents: appendRunEvents(createEmptyRunEventFeedState(action.runId, state.runEvents.paused), events),
          statusLine: `Workspace cleanup ${result.cleanupResult.status} for ${action.runId}; detail and events refreshed.`,
        }));
      } catch (refreshError) {
        updateState({
          ...state,
          pendingWorkspaceCleanupAction: {
            ...nextCleanupAction,
            message: `${nextCleanupAction.message} Follow-up refresh failed: ${refreshError instanceof Error ? refreshError.message : "unknown error"}`,
          },
          error: refreshError instanceof Error ? refreshError.message : "Failed to refresh cleanup state.",
          statusLine: `Workspace cleanup ${result.cleanupResult.status} for ${action.runId}; follow-up refresh failed.`,
        });
      }
    } catch (error) {
      updateState({
        ...state,
        pendingWorkspaceCleanupAction: {
          ...action,
          submitting: false,
          message: error instanceof Error ? error.message : "Failed to apply workspace cleanup.",
        },
        error: error instanceof Error ? error.message : "Failed to apply workspace cleanup.",
        statusLine: error instanceof Error ? error.message : "Failed to apply workspace cleanup.",
      });
    }
  };

  const submitExecutionAction = async () => {
    const action = state.pendingExecutionAction;
    if (!action || action.submitting) {
      return;
    }

    if ((action.kind === "start" || action.kind === "resume" || action.kind === "fork") && action.prompt.trim().length === 0) {
      updateExecutionComposer({ ...action, message: "Prompt is required." }, "Prompt is required.");
      return;
    }

    state = {
      ...state,
      pendingExecutionAction: { ...action, submitting: true, message: null },
      statusLine: `${action.kind === "cancel" ? "Cancelling" : action.kind === "resume" ? "Resuming" : action.kind === "fork" ? "Forking" : "Starting"} execution...`,
    };
    render();

    try {
      let runDetail: RunDetailSnapshot;
      if (action.kind === "start") {
        runDetail = await client.startRun({
          trackId: action.trackId ?? "",
          prompt: action.prompt.trim(),
          backend: action.backend,
          profile: action.profile.trim() || undefined,
          planningSessionId: action.planningSessionId,
        });
      } else if (action.kind === "resume") {
        runDetail = await client.resumeRun({
          runId: action.runId ?? "",
          prompt: action.prompt.trim(),
          backend: action.backend,
          profile: action.profile.trim() || undefined,
        });
      } else if (action.kind === "fork") {
        runDetail = await client.forkRun({
          runId: action.runId ?? "",
          prompt: action.prompt.trim(),
          backend: action.backend,
          profile: action.profile.trim() || undefined,
        });
      } else {
        runDetail = await client.cancelRun(action.runId ?? "");
      }

      const refreshed = await refreshTerminalState({ ...state, pendingExecutionAction: null }, client);
      const runId = runDetail.run.id;
      const selectedIndex = Math.max(0, refreshed.summary?.runs.findIndex((run) => run.id === runId) ?? 0);
      updateState(syncRunEventSelection({
        ...refreshed,
        screen: "runs",
        runs: {
          ...refreshed.runs,
          selectedId: runId,
          selectedIndex,
          data: runDetail,
          error: null,
        },
        statusLine:
          action.kind === "start"
            ? `Started run ${runId} with ${runDetail.run.backend ?? action.backend}/${runDetail.run.profile ?? action.profile}.`
            : action.kind === "resume"
              ? `Resumed run ${runId} with ${runDetail.run.backend ?? action.backend}/${runDetail.run.profile ?? action.profile}.`
              : action.kind === "fork"
                ? `Forked run ${action.runId} as ${runId} with ${runDetail.run.backend ?? action.backend}/${runDetail.run.profile ?? action.profile}.`
              : `Cancelled run ${runId}.`,
      }));
    } catch (error) {
      updateState({
        ...state,
        pendingExecutionAction: {
          ...action,
          submitting: false,
          message: error instanceof Error ? error.message : `Failed to ${action.kind} execution.`,
        },
        error: error instanceof Error ? error.message : `Failed to ${action.kind} execution.`,
        statusLine: error instanceof Error ? error.message : `Failed to ${action.kind} execution.`,
      });
    }
  };

  await refresh();

  if (!io.stdin.isTTY) {
    return;
  }

  emitKeypressEvents(io.stdin);
  io.stdin.setRawMode(true);
  io.stdin.resume();

  restartRefreshTimer();

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      disposed = true;
      if (monitorAbort) {
        monitorAbort.abort();
      }
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }

      io.stdin.off("keypress", onKeypress);
      io.stdin.setRawMode(false);
      io.stdin.pause();
      resolve();
    };

    const onKeypress = (input: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        return;
      }

      if (state.pendingExecutionAction) {
        if (key.name === "escape") {
          updateState({ ...state, pendingExecutionAction: null, statusLine: "Execution action cancelled." });
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void submitExecutionAction();
          return;
        }

        if (state.pendingExecutionAction.kind !== "cancel") {
          if (state.pendingExecutionAction.kind === "start" && key.ctrl && key.name === "f") {
            void previewFolderSessions();
            return;
          }

          if (state.pendingExecutionAction.kind === "start" && key.ctrl && key.name === "r") {
            continueSelectedFolderSession("resume");
            return;
          }

          if (state.pendingExecutionAction.kind === "start" && key.ctrl && key.name === "k") {
            continueSelectedFolderSession("fork");
            return;
          }

          if (state.pendingExecutionAction.kind === "start" && key.name === "tab") {
            cycleExecutionField();
            return;
          }

          if (state.pendingExecutionAction.kind === "start" && input === "[") {
            void selectFolderSession(-1);
            return;
          }

          if (state.pendingExecutionAction.kind === "start" && input === "]") {
            void selectFolderSession(1);
            return;
          }

          if (key.name === "backspace") {
            editExecutionPrompt((value) => value.slice(0, -1));
            return;
          }

          if (key.name === "b") {
            cycleExecutionBackend();
            return;
          }

          if (key.name === "p") {
            editExecutionProfile((value) => nextProfileOption(state.pendingExecutionAction?.backend ?? "codex", value || "default"));
            return;
          }

          if (input.length === 1 && !key.ctrl) {
            editExecutionPrompt((value) => `${value}${input}`);
            return;
          }
        }
      }

      if (state.pendingProposalAction) {
        if (key.name === "escape") {
          updateState({ ...state, pendingProposalAction: null, statusLine: "Proposal action cancelled." });
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void submitProposalAction();
          return;
        }

        if (key.name === "backspace") {
          editProposalField((value) => value.slice(0, -1));
          return;
        }

        if (key.name === "tab") {
          cycleProposalField();
          return;
        }

        if (key.name === "g") {
          cycleProposalAuthor();
          return;
        }

        if (input.length === 1 && !key.ctrl) {
          editProposalField((value) => `${value}${input}`);
          return;
        }
      }

      if (state.pendingPlanningMessageAction) {
        if (key.name === "escape") {
          updateState({ ...state, pendingPlanningMessageAction: null, statusLine: "Planning message action cancelled." });
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void submitPlanningMessageAction();
          return;
        }

        if (key.name === "backspace") {
          editPlanningMessageBody((value) => value.slice(0, -1));
          return;
        }

        if (key.ctrl && key.name === "n") {
          editPlanningMessageBody((value) => `${value}\n`);
          return;
        }

        if (key.ctrl && key.name === "e") {
          void editPlanningMessageBodyWithEditor();
          return;
        }

        if (key.ctrl && key.name === "t") {
          applyPlanningMessageTemplate();
          return;
        }

        if (key.name === "g") {
          cyclePlanningMessageAuthor();
          return;
        }

        if (key.name === "y") {
          cyclePlanningMessageKind();
          return;
        }

        if (key.name === "h") {
          cyclePlanningMessageArtifact(-1);
          return;
        }

        if (key.name === "l") {
          cyclePlanningMessageArtifact(1);
          return;
        }

        if (input.length === 1 && !key.ctrl) {
          editPlanningMessageBody((value) => `${value}${input}`);
          return;
        }
      }

      if (state.pendingPlanningSessionSelection) {
        if (key.name === "escape") {
          updateState({ ...state, pendingPlanningSessionSelection: null, statusLine: "Planning session selection cancelled." });
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void submitPlanningSessionSelection();
          return;
        }

        if (key.name === "j" || key.name === "down") {
          movePlanningSessionSelection(1);
          return;
        }

        if (key.name === "k" || key.name === "up") {
          movePlanningSessionSelection(-1);
          return;
        }
      }

      if (state.pendingPlanningSessionCreate) {
        if (key.name === "escape") {
          updateState({ ...state, pendingPlanningSessionCreate: null, statusLine: "Planning session creation cancelled." });
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void submitPlanningSessionCreate();
          return;
        }

        if (key.name === "y") {
          cyclePlanningSessionCreateStatus();
          return;
        }
      }

      if (state.pendingWorkspaceCleanupAction) {
        if (key.name === "escape") {
          updateState({ ...state, pendingWorkspaceCleanupAction: null, statusLine: "Workspace cleanup action cancelled." });
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          void submitWorkspaceCleanupAction();
          return;
        }
      }

      if (key.name === "q") {
        cleanup();
        return;
      }

      if (key.name === "r") {
        void refresh();
        return;
      }

      if (key.name === "s") {
        openStartRunComposer();
        return;
      }

      if (key.name === "v") {
        openProposalComposer();
        return;
      }

      if (input === "M") {
        openPlanningSessionSelection();
        return;
      }

      if (input === "N") {
        openPlanningSessionCreateComposer();
        return;
      }

      if (input === "T") {
        void cycleSelectedPlanningSessionStatus();
        return;
      }

      if (key.name === "m") {
        openPlanningMessageComposer();
        return;
      }

      if (key.name === "e") {
        openResumeRunComposer();
        return;
      }

      if (key.name === "c") {
        openCancelRunComposer();
        return;
      }

      if (key.name === "w") {
        void openWorkspaceCleanupPreview();
        return;
      }

      if (key.name === "space") {
        toggleRunTailPause();
        return;
      }

      if (key.name === "d") {
        const nextState = {
          ...state,
          showRunEventDetail: !(state.showRunEventDetail ?? false),
          runEventDetailIndex: null,
          statusLine: state.showRunEventDetail ? "Run event detail hidden." : "Run event detail shown for the latest cached event.",
        };
        updateState(nextState);
        persistPreferences(nextState);
        return;
      }

      if (key.name === "p") {
        moveRunEventDetailSelection(-1);
        return;
      }

      if (key.name === "n") {
        moveRunEventDetailSelection(1);
        return;
      }

      if (input === "+" || input === "=") {
        adjustRefreshInterval(REFRESH_INTERVAL_STEP_MS);
        return;
      }

      if (input === "-") {
        adjustRefreshInterval(-REFRESH_INTERVAL_STEP_MS);
        return;
      }

      if (key.name === "f") {
        const nextState = setRunFilter(state, cycleRunFilterMode(state.runFilter));
        updateState(nextState);
        persistPreferences(nextState);
        return;
      }

      if (input === "P") {
        void cycleProjectScope(state, client)
          .then((nextState) => {
            updateState(nextState);
            persistPreferences(nextState);
          })
          .catch((error) => updateState({
            ...state,
            error: error instanceof Error ? error.message : "Failed to cycle project scope.",
            statusLine: error instanceof Error ? error.message : "Failed to cycle project scope.",
          }));
        return;
      }

      if (key.name === "a") {
        void decideSelectedTrackApproval("approve");
        return;
      }

      if (key.name === "x") {
        void decideSelectedTrackApproval("reject");
        return;
      }

      if (key.name === "j" || key.name === "down") {
        updateState(selectNextItem(state));
        return;
      }

      if (key.name === "h") {
        updateState(selectTrackArtifact(state, cycleArtifact(state.tracks.data?.planningWorkspace?.selectedArtifact ?? "spec", -1)));
        return;
      }

      if (key.name === "l") {
        updateState(selectTrackArtifact(state, cycleArtifact(state.tracks.data?.planningWorkspace?.selectedArtifact ?? "spec", 1)));
        return;
      }

      if (key.name === "u") {
        const showRevisionDiffDetail = !(state.showRevisionDiffDetail ?? false);
        updateState({
          ...state,
          showRevisionDiffDetail,
          statusLine: showRevisionDiffDetail ? "Expanded revision diff shown." : "Compact revision diff shown.",
        });
        return;
      }

      if (input === "U") {
        void exportSelectedRevisionDiff();
        return;
      }

      if (input === "[") {
        updateState(cycleTrackRevision(state, -1));
        return;
      }

      if (input === "]") {
        updateState(cycleTrackRevision(state, 1));
        return;
      }

      if (key.name === "k" || key.name === "up") {
        updateState(selectPreviousItem(state));
        return;
      }

      if (key.name === "1" || key.name === "2" || key.name === "3" || key.name === "4") {
        updateState({
          ...state,
          screen: ({ "1": "home", "2": "tracks", "3": "runs", "4": "settings" } as const)[key.name],
          statusLine: `Switched to ${({ "1": "home", "2": "tracks", "3": "runs", "4": "settings" } as const)[key.name]} screen.`,
        });
      }
    };

    io.stdin.on("keypress", onKeypress);
  });
}

async function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  }).catch((error) => {
    if (!signal.aborted) {
      throw error;
    }
  });
}

export interface TerminalCommandOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  stdout?: { write(chunk: string): unknown };
}

export async function runTerminalCommand(options: TerminalCommandOptions = {}): Promise<boolean> {
  const argv = options.argv ?? process.argv.slice(2);
  const [command, runId, ...args] = argv;

  if (command === "help" || command === "--help" || command === "-h") {
    (options.stdout ?? process.stdout).write(renderTerminalCommandHelp());
    return true;
  }

  if (command === "diff-exports") {
    const usage = "Usage: specrail-terminal diff-exports [--json] [--limit <positive-number>] [--track <trackId>] [--artifact <spec|plan|tasks>]";
    assertKnownTerminalCommandFlags(argv.slice(1), ["--json", "--limit", "--track", "--artifact"], ["--limit", "--track", "--artifact"], usage);
    const limitFlagIndex = argv.indexOf("--limit");
    const limitValue = limitFlagIndex >= 0 ? argv[limitFlagIndex + 1]?.trim() : null;
    const parsedLimit = limitValue ? parsePositiveCliInteger(limitValue) : null;
    const filters = parseRevisionDiffExportFilters(argv, usage);

    if (limitFlagIndex >= 0 && (!limitValue || parsedLimit === null)) {
      throw new Error(usage);
    }

    const limit = parsedLimit;

    const config = loadTerminalClientConfig(options.env ?? process.env);
    const entries = filterRevisionDiffExportManifest(
      [...(await loadRevisionDiffExportManifest(config.diffExportDirectory ?? process.cwd()))].reverse(),
      filters,
    ).slice(0, limit ?? undefined);
    const output = argv.includes("--json")
      ? `${JSON.stringify(entries, null, 2)}\n`
      : formatRevisionDiffExportManifest(entries);
    (options.stdout ?? process.stdout).write(output);
    return true;
  }

  if (command === "diff-export") {
    const usage = "Usage: specrail-terminal diff-export <positive-index> [--track <trackId>] [--artifact <spec|plan|tasks>] [--output <file>|-o <file>]";
    assertKnownTerminalCommandFlags(argv.slice(2), ["--track", "--artifact", "--output", "-o"], ["--track", "--artifact", "--output", "-o"], usage);
    const indexValue = runId?.trim();
    const parsedIndex = indexValue ? parsePositiveCliInteger(indexValue) : null;
    const filters = parseRevisionDiffExportFilters(argv, usage);
    const outputFlagIndex = argv.findIndex((arg) => arg === "--output" || arg === "-o");
    const outputPath = outputFlagIndex >= 0 ? argv[outputFlagIndex + 1]?.trim() : null;

    if (!indexValue || parsedIndex === null) {
      throw new Error(usage);
    }
    if (outputFlagIndex >= 0 && !outputPath) {
      throw new Error(usage);
    }

    const config = loadTerminalClientConfig(options.env ?? process.env);
    const entries = filterRevisionDiffExportManifest(
      [...(await loadRevisionDiffExportManifest(config.diffExportDirectory ?? process.cwd()))].reverse(),
      filters,
    );
    const entry = entries[parsedIndex - 1];

    if (!entry) {
      throw new Error(`No revision diff export found at index ${parsedIndex}.`);
    }

    const patch = await readFile(entry.filePath, "utf8");
    const output = patch.endsWith("\n") ? patch : `${patch}\n`;

    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, output, "utf8");
      return true;
    }

    (options.stdout ?? process.stdout).write(output);
    return true;
  }

  if (command === "message-templates") {
    const usage = "Usage: specrail-terminal message-templates [--json] [--output <file>|-o <file>]";
    assertKnownTerminalCommandFlags(argv.slice(1), ["--json", "--output", "-o"], ["--output", "-o"], usage);
    const config = loadTerminalClientConfig(options.env ?? process.env);
    const templates = await loadPlanningMessageTemplates(config.messageTemplatesPath ?? null);
    const outputFlagIndex = argv.findIndex((arg) => arg === "--output" || arg === "-o");
    const outputPath = outputFlagIndex >= 0 ? argv[outputFlagIndex + 1]?.trim() : null;

    if (outputFlagIndex >= 0 && !outputPath) {
      throw new Error(usage);
    }

    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
      return true;
    }

    const output = argv.includes("--json")
      ? `${JSON.stringify(templates, null, 2)}\n`
      : formatPlanningMessageTemplates(templates);
    (options.stdout ?? process.stdout).write(output);
    return true;
  }

  if (command !== "report") {
    return false;
  }

  const reportRunId = runId?.trim();
  const reportUsage = "Usage: specrail-terminal report <runId> [--output <file>|-o <file>]";
  if (!reportRunId) {
    throw new Error(reportUsage);
  }
  assertKnownTerminalCommandFlags(args, ["--output", "-o"], ["--output", "-o"], reportUsage);

  const outputFlagIndex = args.findIndex((arg) => arg === "--output" || arg === "-o");
  const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1]?.trim() : null;

  if (outputFlagIndex >= 0 && !outputPath) {
    throw new Error(reportUsage);
  }

  const config = loadTerminalClientConfig(options.env ?? process.env);
  const client = new SpecRailTerminalApiClient(config.apiBaseUrl, options.fetchImpl ?? fetch);
  const report = await client.loadRunReportMarkdown(reportRunId);
  const output = report.endsWith("\n") ? report : `${report}\n`;

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, "utf8");
    return true;
  }

  (options.stdout ?? process.stdout).write(output);
  return true;
}

function parsePositiveCliInteger(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isTerminalEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  return argvPath ? moduleUrl === pathToFileURL(argvPath).href : false;
}

const isEntrypoint = isTerminalEntrypoint(import.meta.url, process.argv[1]);

if (isEntrypoint) {
  void runTerminalCommand()
    .then(async (handled) => {
      if (!handled) {
        await runTerminalApp();
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
