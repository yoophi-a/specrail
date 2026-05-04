import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { loadTerminalClientConfig, type SpecRailTerminalClientConfig } from "@specrail/config";

export type TerminalScreenId = "home" | "tracks" | "runs" | "settings";
export type RunEventConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "paused" | "closed" | "error";
export type RunFilterMode = "all" | "active" | "terminal";
export type ArtifactKind = "spec" | "plan" | "tasks";
export type ExecutionActionKind = "start" | "resume" | "cancel";

const EXECUTION_BACKEND_OPTIONS = ["codex", "claude_code"] as const;
const EXECUTION_PROFILE_OPTIONS: Record<string, string[]> = {
  codex: ["default", "gpt-5.4", "gpt-5.4-mini"],
  claude_code: ["default", "sonnet", "opus"],
};

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
  showRunEventDetail?: boolean;
  pendingTrackAction: PendingTrackActionState | null;
  pendingExecutionAction: PendingExecutionActionState | null;
  pendingProposalAction: PendingProposalActionState | null;
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
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl), init);
    if (!response.ok) {
      throw new Error(await this.buildRequestError(response, pathname));
    }

    return (await response.json()) as T;
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
    const payload = await this.request<TrackDetailResponse>(`/tracks/${trackId}`);
    const planningSessionsPayload = await this.request<PlanningSessionsResponse>(`/tracks/${trackId}/planning-sessions`);
    const planningSessions = planningSessionsPayload.planningSessions;
    const selectedPlanningSessionId = payload.planningContext?.planningSessionId ?? planningSessions[0]?.id;
    const planningMessages = selectedPlanningSessionId
      ? (await this.request<PlanningMessagesResponse>(`/planning-sessions/${selectedPlanningSessionId}/messages`)).messages
      : [];

    const artifacts = ["spec", "plan", "tasks"] as const;
    const workflowPayloads = await Promise.all(
      artifacts.map(async (artifact) => [artifact, await this.request<ArtifactWorkflowResponse>(`/tracks/${trackId}/artifacts/${artifact}`)] as const),
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

  async proposeArtifactRevision(input: {
    trackId: string;
    artifact: ArtifactKind;
    content: string;
    summary?: string;
    createdBy: "user" | "agent" | "system";
  }): Promise<ArtifactProposalResponse> {
    return this.request<ArtifactProposalResponse>(`/tracks/${input.trackId}/artifacts/${input.artifact}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: input.content,
        summary: input.summary,
        createdBy: input.createdBy,
      }),
    });
  }

  async decideApprovalRequest(approvalRequestId: string, decision: "approve" | "reject"): Promise<void> {
    await this.request(`/approval-requests/${approvalRequestId}/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "terminal" }),
    });
  }

  async loadRunDetail(runId: string): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${runId}`);
    return { run: payload.run };
  }

  async loadRunEvents(runId: string): Promise<ExecutionEvent[]> {
    const payload = await this.request<RunEventsResponse>(`/runs/${runId}/events`);
    return payload.events;
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
    const payload = await this.request<RunDetailResponse>(`/runs/${input.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, backend: input.backend, profile: input.profile }),
    });

    return { run: payload.run };
  }

  async cancelRun(runId: string): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${runId}/cancel`, {
      method: "POST",
    });

    return { run: payload.run };
  }

  async previewWorkspaceCleanup(runId: string): Promise<WorkspaceCleanupPreviewResponse> {
    return this.request<WorkspaceCleanupPreviewResponse>(`/runs/${runId}/workspace-cleanup/preview`);
  }

  async applyWorkspaceCleanup(runId: string, confirmation: string): Promise<WorkspaceCleanupApplyResponse> {
    return this.request<WorkspaceCleanupApplyResponse>(`/runs/${runId}/workspace-cleanup/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: confirmation }),
    });
  }

  async *streamRunEvents(runId: string, signal?: AbortSignal): AsyncGenerator<ExecutionEvent> {
    const response = await this.fetchImpl(new URL(`/runs/${runId}/events/stream`, this.baseUrl), {
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
    showRunEventDetail: false,
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
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

export function createExecutionActionDraft(input: {
  kind: ExecutionActionKind;
  scope: "track" | "run";
  trackId?: string;
  runId?: string;
  planningSessionId?: string;
  backend?: string;
  profile?: string;
  prompt?: string;
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
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
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
    `Keys: 1 home, 2 tracks, 3 runs, 4 settings, j/k or ↑/↓ select, P project scope, h/l artifact, [/] revision, v propose, f run filter, d event detail, Space tail pause/resume, s start, e resume, c cancel, w cleanup, a approve, x reject, r refresh, q quit | Refresh ${state.refreshIntervalMs}ms`,
    ...renderContextualHelp(state),
    ...renderExecutionActionComposer(state.pendingExecutionAction),
    ...renderProposalActionComposer(state.pendingProposalAction),
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

  if (state.pendingExecutionAction) {
    const promptHelp = state.pendingExecutionAction.kind === "cancel"
      ? "Enter confirms cancellation, Esc aborts."
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
        "Help: tracks — P cycles project scope, h/l switches artifact, [/] cycles revisions, v proposes, a/x approves or rejects pending revisions, s starts a run.",
      ];
    case "runs":
      return [
        ...lines,
        "Help: runs — f cycles filters, Space pauses live tail, d toggles event detail, e resumes terminal runs, c cancels active runs, w previews workspace cleanup.",
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

function renderExecutionActionComposer(action: PendingExecutionActionState | null): string[] {
  if (!action) {
    return [];
  }

  const title = action.kind === "start"
    ? `Execution action: start track ${action.trackId ?? "unknown"}`
    : action.kind === "resume"
      ? `Execution action: resume run ${action.runId ?? "unknown"}`
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

  return [
    "",
    title,
    `- backend: ${action.backend}${action.kind === "resume" ? " (locked to run backend)" : " (press b to cycle)"}`,
    `- profile: ${action.profile}`,
    `- prompt: ${action.prompt || "(required, type to edit)"}`,
    `- planning session: ${action.planningSessionId ?? "auto/latest approved"}`,
    `- submit: Enter${action.submitting ? " (submitting...)" : ""}, abort: Esc, backspace deletes`,
    action.message ? `- note: ${action.message}` : "- note: printable keys edit prompt, p cycles profile presets",
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
        "- Press P to cycle project scope for track listings.",
        "- Tracks view surfaces planning sessions, revision history, and pending approvals.",
        "- Press a/x on the tracks screen to approve or reject the next pending request.",
        "- Press s on tracks to start a run, e on runs to resume, c on runs to cancel.",
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
    ...renderTrackDetail(selectedTrack?.id === state.tracks.data?.track.id ? state.tracks.data : null, state.tracks, selectedTrack?.id ?? null),
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
    ...renderRunDetail(detail, state.runs, selectedRun?.id ?? null, state.runEvents, state.showRunEventDetail ?? false),
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
  const selectedRevisionIndex = selectedRevision ? workspace?.revisions[selectedArtifact]?.findIndex((revision) => revision.id === selectedRevision.id) ?? -1 : -1;
  const selectedArtifactRevisionCount = workspace?.revisions[selectedArtifact]?.length ?? 0;

  return [
    `- id: ${detail.track.id}`,
    `- title: ${detail.track.title}`,
    `- status: ${detail.track.status ?? "unknown"}`,
    `- priority: ${detail.track.priority ?? "medium"}`,
    `- approvals: spec=${detail.track.specStatus ?? "unknown"}, plan=${detail.track.planStatus ?? "unknown"}`,
    `- updated: ${detail.track.updatedAt ?? "unknown"}`,
    `- planning session: ${detail.planningContext?.planningSessionId ?? "none"}`,
    `- planning context updated: ${detail.planningContext?.updatedAt ?? "unknown"}`,
    `- pending planning changes: ${detail.planningContext?.hasPendingChanges ? "yes" : "no"}`,
    `- execution context signal: ${detail.planningContext?.hasPendingChanges ? "new approvals needed before new runs" : "current approved context is runnable"}`,
    `- spec preview: ${previewText(detail.artifacts.spec)}`,
    `- plan preview: ${previewText(detail.artifacts.plan)}`,
    `- tasks preview: ${previewText(detail.artifacts.tasks)}`,
    "- planning sessions:",
    ...renderPlanningSessionLines(workspace),
    `- revision focus (${selectedArtifact}${selectedArtifactRevisionCount > 0 && selectedRevisionIndex >= 0 ? ` ${selectedRevisionIndex + 1}/${selectedArtifactRevisionCount}` : ""}): ${selectedRevision ? `v${selectedRevision.version} by ${selectedRevision.createdBy} at ${selectedRevision.createdAt}${selectedRevision.approvedAt ? ` | approved ${selectedRevision.approvedAt}` : " | pending review"}` : "none"}`,
    `- revision preview: ${selectedRevision ? previewText(selectedRevision.content, 120) : "none"}`,
    `- pending approvals: ${selectedApproval ? `${selectedApproval.artifact} -> ${selectedApproval.revisionId} requested by ${selectedApproval.requestedBy} at ${selectedApproval.createdAt}` : "none"}`,
    `- operator actions: ${selectedApproval ? "press a to approve or x to reject selected pending request" : "no pending approval actions"}`,
    `- planning actions: h/l switches artifact focus, [/] cycles revisions, v proposes a new revision for ${selectedArtifact}`,
    `- execution actions: press s to start a run for this track${detail.planningContext?.hasPendingChanges ? " (currently blocked until approvals land)" : ""}`,
  ];
}

function renderPlanningSessionLines(workspace?: TrackPlanningWorkspace): string[] {
  if (!workspace || workspace.planningSessions.length === 0) {
    return ["  - none"];
  }

  return workspace.planningSessions.slice(0, 3).map((session) => {
    const prefix = session.id === workspace.selectedPlanningSessionId ? "  >" : "   ";
    const messageCount = workspace.planningMessages.filter((message) => message.planningSessionId === session.id).length;
    return `${prefix} ${session.id} | ${session.status} | messages ${messageCount} | updated ${session.updatedAt ?? session.createdAt ?? "unknown"}`;
  }).concat(renderPlanningMessageLines(workspace.planningMessages));
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
  const recentFailure = feed.runId === run.id ? [...feed.items].reverse().find((event) => isFailureEvent(event)) ?? null : null;

  return [
    `- id: ${run.id}`,
    `- track: ${run.trackId}`,
    `- status: ${run.status}`,
    `- backend/profile: ${run.backend ?? "default"} / ${run.profile ?? "default"}`,
    `- branch: ${run.branchName ?? "unknown"}`,
    `- workspace: ${run.workspacePath ?? "unknown"}`,
    `- session: ${run.sessionRef ?? "none"}`,
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
    ...renderRunEventDetailLines(showEventDetail ? lastEvent : null),
  ];
}

function renderRunEventDetailLines(event: ExecutionEvent | null): string[] {
  if (!event) {
    return [];
  }

  return [
    "- event detail:",
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
    const selectedProjectId = typeof parsed.selectedProjectId === "string" && parsed.selectedProjectId.trim().length > 0
      ? parsed.selectedProjectId
      : parsed.selectedProjectId === null
        ? null
        : undefined;
    const runFilter = parsed.runFilter === "active" || parsed.runFilter === "terminal" || parsed.runFilter === "all" ? parsed.runFilter : undefined;
    const liveTailPaused = typeof parsed.liveTailPaused === "boolean" ? parsed.liveTailPaused : undefined;
    const showRunEventDetail = typeof parsed.showRunEventDetail === "boolean" ? parsed.showRunEventDetail : undefined;

    return {
      ...(selectedProjectId !== undefined ? { selectedProjectId } : {}),
      ...(runFilter ? { runFilter } : {}),
      ...(liveTailPaused !== undefined ? { liveTailPaused } : {}),
      ...(showRunEventDetail !== undefined ? { showRunEventDetail } : {}),
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

async function resolveTerminalClientStartup(config: SpecRailTerminalClientConfig): Promise<{ config: SpecRailTerminalClientConfig; preferences: Partial<TerminalPreferenceState> }> {
  const preferences = await loadTerminalPreferences(config.preferencePath);
  return {
    config: {
      ...config,
      initialProjectId: preferences.selectedProjectId !== undefined ? preferences.selectedProjectId : config.initialProjectId,
      initialRunFilter: preferences.runFilter ?? config.initialRunFilter,
    },
    preferences,
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
  };
  let disposed = false;
  let monitorSerial = 0;
  let monitorAbort: AbortController | null = null;

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
    void saveTerminalPreferences(effectiveConfig.preferencePath, {
      selectedProjectId: nextState.selectedProjectId ?? null,
      runFilter: nextState.runFilter,
      liveTailPaused: nextState.runEvents.paused,
      showRunEventDetail: nextState.showRunEventDetail ?? false,
    });
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
      updateState(state.summary ? await refreshTerminalState(state, client) : await bootstrapTerminalState(effectiveConfig, client));
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

  const beginExecutionAction = (action: PendingExecutionActionState) => {
    updateState({
      ...state,
      pendingExecutionAction: action,
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
      statusLine: `Composing ${artifact} revision proposal for ${detail.track.id}.`,
    });
  };

  const updateExecutionComposer = (next: PendingExecutionActionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingExecutionAction: next, statusLine });
  };

  const updateProposalComposer = (next: PendingProposalActionState | null, statusLine = state.statusLine) => {
    updateState({ ...state, pendingProposalAction: next, statusLine });
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

    updateExecutionComposer({ ...action, prompt: updater(action.prompt), message: null });
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

    if ((action.kind === "start" || action.kind === "resume") && action.prompt.trim().length === 0) {
      updateExecutionComposer({ ...action, message: "Prompt is required." }, "Prompt is required.");
      return;
    }

    state = {
      ...state,
      pendingExecutionAction: { ...action, submitting: true, message: null },
      statusLine: `${action.kind === "cancel" ? "Cancelling" : action.kind === "resume" ? "Resuming" : "Starting"} execution...`,
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

  const interval = config.refreshIntervalMs > 0 ? setInterval(() => void refresh(), config.refreshIntervalMs) : null;

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      disposed = true;
      if (monitorAbort) {
        monitorAbort.abort();
      }
      if (interval) {
        clearInterval(interval);
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
          statusLine: state.showRunEventDetail ? "Run event detail hidden." : "Run event detail shown for the latest cached event.",
        };
        updateState(nextState);
        persistPreferences(nextState);
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

const isEntrypoint = process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false;

if (isEntrypoint) {
  void runTerminalApp().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
