import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { loadTerminalClientConfig, type SpecRailTerminalClientConfig } from "@specrail/config";

export type TerminalScreenId = "home" | "tracks" | "runs" | "settings";
export type RunEventConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "closed" | "error";
export type ArtifactKind = "spec" | "plan" | "tasks";

export interface TrackListItem {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  specStatus?: string;
  planStatus?: string;
  updatedAt?: string;
  createdAt?: string;
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
  reconnectAttempts: number;
  lastError: string | null;
  lastEventAt: string | null;
}

export interface PendingTrackActionState {
  kind: "approve" | "reject";
  approvalRequestId: string;
}

export interface TerminalAppState {
  screen: TerminalScreenId;
  statusLine: string;
  summary: TerminalSummarySnapshot | null;
  apiBaseUrl: string;
  refreshIntervalMs: number;
  loading: boolean;
  error: string | null;
  tracks: DetailPanelState<TrackDetailSnapshot>;
  runs: DetailPanelState<RunDetailSnapshot>;
  runEvents: RunEventFeedState;
  pendingTrackAction: PendingTrackActionState | null;
}

interface TracksResponse {
  tracks: TrackListItem[];
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

interface RunDetailResponse {
  run: RunListItem;
}

export class SpecRailTerminalApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(pathname: string): Promise<T> {
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl));
    if (!response.ok) {
      throw new Error(`SpecRail API request failed (${response.status}) for ${pathname}`);
    }

    return (await response.json()) as T;
  }

  async loadSummary(): Promise<TerminalSummarySnapshot> {
    const [tracksPayload, runsPayload] = await Promise.all([
      this.request<TracksResponse>("/tracks?page=1&pageSize=20"),
      this.request<RunsResponse>("/runs?page=1&pageSize=20"),
    ]);

    return {
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
        selectedArtifact: pendingApproval?.artifact ?? (payload.planningContext?.planRevisionId ? "plan" : "spec"),
        selectedApprovalRequestId: pendingApproval?.id,
      },
    };
  }

  async decideApprovalRequest(approvalRequestId: string, decision: "approve" | "reject"): Promise<void> {
    const response = await this.fetchImpl(new URL(`/approval-requests/${approvalRequestId}/${decision}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "terminal" }),
    });

    if (!response.ok) {
      throw new Error(`SpecRail API request failed (${response.status}) for /approval-requests/${approvalRequestId}/${decision}`);
    }
  }

  async loadRunDetail(runId: string): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${runId}`);
    return { run: payload.run };
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

export function createEmptyRunEventFeedState(runId: string | null = null): RunEventFeedState {
  return {
    runId,
    items: [],
    connection: "idle",
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
    apiBaseUrl: config.apiBaseUrl,
    refreshIntervalMs: config.refreshIntervalMs,
    loading: true,
    error: null,
    tracks: createEmptyDetailState<TrackDetailSnapshot>(),
    runs: createEmptyDetailState<RunDetailSnapshot>(),
    runEvents: createEmptyRunEventFeedState(),
    pendingTrackAction: null,
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
  const summary = await client.loadSummary();
  const tracks = await populateTrackPanel(createEmptyDetailState<TrackDetailSnapshot>(), summary, client);
  const runs = await populateRunPanel(createEmptyDetailState<RunDetailSnapshot>(), summary, client);

  return syncRunEventSelection({
    screen: config.initialScreen,
    statusLine: `Loaded ${summary.tracks.length} tracks and ${summary.runs.length} runs.`,
    summary,
    apiBaseUrl: config.apiBaseUrl,
    refreshIntervalMs: config.refreshIntervalMs,
    loading: false,
    error: null,
    tracks,
    runs,
    runEvents: createEmptyRunEventFeedState(runs.selectedId),
    pendingTrackAction: null,
  });
}

export async function refreshTerminalState(
  state: TerminalAppState,
  client: Pick<SpecRailTerminalApiClient, "loadSummary" | "loadTrackDetail" | "loadRunDetail">,
): Promise<TerminalAppState> {
  const summary = await client.loadSummary();
  const tracks = await populateTrackPanel(state.tracks, summary, client);
  const runs = await populateRunPanel(state.runs, summary, client);

  return syncRunEventSelection({
    ...state,
    summary,
    loading: false,
    error: null,
    statusLine: `Refreshed ${summary.tracks.length} tracks and ${summary.runs.length} runs at ${summary.fetchedAt}.`,
    tracks,
    runs,
    pendingTrackAction: null,
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
): Promise<DetailPanelState<RunDetailSnapshot>> {
  const selection = resolveSelection(summary.runs, previous.selectedId, previous.selectedIndex);
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
    const nextIndex = clampIndex(state.runs.selectedIndex + delta, state.summary.runs.length);
    const selectedId = state.summary.runs[nextIndex]?.id ?? null;
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
    runEvents: createEmptyRunEventFeedState(selectedId),
  };
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
    `Keys: 1 home, 2 tracks, 3 runs, 4 settings, j/k or ↑/↓ select, a approve, x reject, r refresh, q quit | Refresh ${state.refreshIntervalMs}ms`,
  ].join("\n");
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
        "- Tracks view surfaces planning sessions, revision history, and pending approvals.",
        "- Press a/x on the tracks screen to approve or reject the next pending request.",
        "- Runs view tails live SSE events with automatic reconnect attempts.",
      ];
    case "home":
    default:
      return [
        "Overview",
        `- Tracks loaded: ${state.summary.tracks.length}`,
        `- Runs loaded: ${state.summary.runs.length}`,
        `- Last fetch: ${state.summary.fetchedAt}`,
        `- Selected track: ${state.tracks.selectedId ?? "none"}`,
        `- Selected run: ${state.runs.selectedId ?? "none"}`,
        `- Run stream: ${state.runEvents.runId ? `${state.runEvents.connection} (${state.runEvents.items.length} events cached)` : "idle"}`,
        state.error ? `- Last refresh error: ${state.error}` : "- Last refresh error: none",
      ];
  }
}

function renderTracksScreen(state: TerminalAppState): string[] {
  const selectedTrack = state.summary?.tracks[state.tracks.selectedIndex] ?? null;
  return [
    `Tracks (${state.summary?.tracks.length ?? 0})`,
    ...renderSelectableList(
      state.summary?.tracks.map((track) => `${track.id} | ${track.status ?? "unknown"} | ${track.priority ?? "medium"} | ${track.title}`) ?? [],
      state.tracks.selectedIndex,
      "No tracks yet.",
    ),
    "",
    "Track detail",
    ...renderTrackDetail(selectedTrack?.id === state.tracks.data?.track.id ? state.tracks.data : null, state.tracks, selectedTrack?.id ?? null),
  ];
}

function renderRunsScreen(state: TerminalAppState): string[] {
  const selectedRun = state.summary?.runs[state.runs.selectedIndex] ?? null;
  const detail = selectedRun?.id === state.runs.data?.run.id ? state.runs.data : null;

  return [
    `Runs (${state.summary?.runs.length ?? 0})`,
    ...renderSelectableList(
      state.summary?.runs.map(
        (run) => `${run.id} | ${run.status} | ${run.trackId} | ${run.backend ?? "default"}${run.planningContextStale ? " | stale" : ""}`,
      ) ?? [],
      state.runs.selectedIndex,
      "No runs yet.",
    ),
    "",
    "Run detail",
    ...renderRunDetail(detail, state.runs, selectedRun?.id ?? null, state.runEvents),
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
  const selectedRevision = workspace?.revisions[selectedArtifact]?.[0] ?? null;
  const pendingRequests = workspace ? getPendingApprovalRequests(workspace) : [];
  const selectedApproval = pendingRequests.find((request) => request.id === workspace?.selectedApprovalRequestId) ?? pendingRequests[0] ?? null;

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
    `- revision focus (${selectedArtifact}): ${selectedRevision ? `v${selectedRevision.version} by ${selectedRevision.createdBy} at ${selectedRevision.createdAt}${selectedRevision.approvedAt ? ` | approved ${selectedRevision.approvedAt}` : " | pending review"}` : "none"}`,
    `- revision preview: ${selectedRevision ? previewText(selectedRevision.content, 120) : "none"}`,
    `- pending approvals: ${selectedApproval ? `${selectedApproval.artifact} -> ${selectedApproval.revisionId} requested by ${selectedApproval.requestedBy} at ${selectedApproval.createdAt}` : "none"}`,
    `- operator actions: ${selectedApproval ? "press a to approve or x to reject selected pending request" : "no pending approval actions"}`,
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

function renderRunDetail(
  detail: RunDetailSnapshot | null,
  panel: DetailPanelState<RunDetailSnapshot>,
  selectedId: string | null,
  feed: RunEventFeedState,
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
    `- failure focus: ${recentFailure ? formatFailureFocus(recentFailure) : terminal && run.status === "failed" ? "run failed, inspect recent provider events" : "none"}`,
    `- stream: ${formatStreamStatus(feed, terminal)}`,
    "- recent activity:",
    ...renderRecentRunEvents(feed, run.id),
  ];
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
  const parts = [event.timestamp, event.type];
  if (event.subtype) {
    parts.push(event.subtype);
  }
  if (status) {
    parts.push(`status=${status}`);
  }
  return `${parts.join(" | ")} | ${previewText(event.summary, 120)}`;
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

export async function runTerminalApp(
  config: SpecRailTerminalClientConfig = loadTerminalClientConfig(),
  io: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } = { stdout: process.stdout, stdin: process.stdin },
): Promise<void> {
  const client = new SpecRailTerminalApiClient(config.apiBaseUrl);
  let state = createEmptyTerminalState(config);
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
    const seenIds = new Set<string>();
    patchRunFeed({ ...createEmptyRunEventFeedState(selectedRunId), connection: "connecting" });

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
      updateState(state.summary ? await refreshTerminalState(state, client) : await bootstrapTerminalState(config, client));
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

    const onKeypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        return;
      }

      if (key.name === "q") {
        cleanup();
        return;
      }

      if (key.name === "r") {
        void refresh();
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
