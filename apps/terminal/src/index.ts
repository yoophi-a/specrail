import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { loadTerminalClientConfig, type SpecRailTerminalClientConfig } from "@specrail/config";

export type TerminalScreenId = "home" | "tracks" | "runs" | "settings";

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
  planningContextStaleReason?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
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
    return {
      track: payload.track,
      artifacts: payload.artifacts,
      planningContext: payload.planningContext,
    };
  }

  async loadRunDetail(runId: string): Promise<RunDetailSnapshot> {
    const payload = await this.request<RunDetailResponse>(`/runs/${runId}`);
    return { run: payload.run };
  }
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

  return {
    screen: config.initialScreen,
    statusLine: `Loaded ${summary.tracks.length} tracks and ${summary.runs.length} runs.`,
    summary,
    apiBaseUrl: config.apiBaseUrl,
    refreshIntervalMs: config.refreshIntervalMs,
    loading: false,
    error: null,
    tracks,
    runs,
  };
}

export async function refreshTerminalState(
  state: TerminalAppState,
  client: Pick<SpecRailTerminalApiClient, "loadSummary" | "loadTrackDetail" | "loadRunDetail">,
): Promise<TerminalAppState> {
  const summary = await client.loadSummary();
  const tracks = await populateTrackPanel(state.tracks, summary, client);
  const runs = await populateRunPanel(state.runs, summary, client);

  return {
    ...state,
    summary,
    loading: false,
    error: null,
    statusLine: `Refreshed ${summary.tracks.length} tracks and ${summary.runs.length} runs at ${summary.fetchedAt}.`,
    tracks,
    runs,
  };
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
    return {
      ...state,
      statusLine: selectedId ? `Selected run ${selectedId}. Press r to refresh details.` : state.statusLine,
      runs: {
        ...state.runs,
        selectedIndex: nextIndex,
        selectedId,
        data: state.runs.data?.run.id === selectedId ? state.runs.data : null,
        error: null,
      },
    };
  }

  return state;
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
    `Keys: 1 home, 2 tracks, 3 runs, 4 settings, j/k or ↑/↓ select, r refresh, q quit | Refresh ${state.refreshIntervalMs}ms`,
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
        "- Next step: add persisted operator preferences and view-specific filters.",
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
    ...renderRunDetail(selectedRun?.id === state.runs.data?.run.id ? state.runs.data : null, state.runs, selectedRun?.id ?? null),
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

  return [
    `- id: ${detail.track.id}`,
    `- title: ${detail.track.title}`,
    `- status: ${detail.track.status ?? "unknown"}`,
    `- priority: ${detail.track.priority ?? "medium"}`,
    `- approvals: spec=${detail.track.specStatus ?? "unknown"}, plan=${detail.track.planStatus ?? "unknown"}`,
    `- updated: ${detail.track.updatedAt ?? "unknown"}`,
    `- planning session: ${detail.planningContext?.planningSessionId ?? "none"}`,
    `- pending planning changes: ${detail.planningContext?.hasPendingChanges ? "yes" : "no"}`,
    `- spec preview: ${previewText(detail.artifacts.spec)}`,
    `- plan preview: ${previewText(detail.artifacts.plan)}`,
    `- tasks preview: ${previewText(detail.artifacts.tasks)}`,
  ];
}

function renderRunDetail(
  detail: RunDetailSnapshot | null,
  panel: DetailPanelState<RunDetailSnapshot>,
  selectedId: string | null,
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

  return [
    `- id: ${detail.run.id}`,
    `- track: ${detail.run.trackId}`,
    `- status: ${detail.run.status}`,
    `- backend/profile: ${detail.run.backend ?? "default"} / ${detail.run.profile ?? "default"}`,
    `- branch: ${detail.run.branchName ?? "unknown"}`,
    `- workspace: ${detail.run.workspacePath ?? "unknown"}`,
    `- session: ${detail.run.sessionRef ?? "none"}`,
    `- planning session: ${detail.run.planningSessionId ?? "none"}`,
    `- planning context stale: ${detail.run.planningContextStale ? "yes" : "no"}`,
    `- stale reason: ${detail.run.planningContextStaleReason ?? "none"}`,
    `- started: ${detail.run.startedAt ?? detail.run.createdAt ?? "unknown"}`,
    `- finished: ${detail.run.finishedAt ?? "not finished"}`,
  ];
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

  const render = () => {
    io.stdout.write("\u001Bc");
    io.stdout.write(`${renderAppShell(state)}\n`);
  };

  const refresh = async () => {
    state = { ...state, loading: true, error: null, statusLine: "Refreshing terminal snapshot..." };
    render();

    try {
      state = state.summary ? await refreshTerminalState(state, client) : await bootstrapTerminalState(config, client);
    } catch (error) {
      state = {
        ...state,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to refresh terminal snapshot.",
        statusLine: error instanceof Error ? error.message : "Failed to refresh terminal snapshot.",
      };
    }

    render();
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

      if (key.name === "j" || key.name === "down") {
        state = selectNextItem(state);
        render();
        return;
      }

      if (key.name === "k" || key.name === "up") {
        state = selectPreviousItem(state);
        render();
        return;
      }

      if (key.name === "1" || key.name === "2" || key.name === "3" || key.name === "4") {
        state = {
          ...state,
          screen: ({ "1": "home", "2": "tracks", "3": "runs", "4": "settings" } as const)[key.name],
          statusLine: `Switched to ${({ "1": "home", "2": "tracks", "3": "runs", "4": "settings" } as const)[key.name]} screen.`,
        };
        render();
      }
    };

    io.stdin.on("keypress", onKeypress);
  });
}

const isEntrypoint = process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false;

if (isEntrypoint) {
  void runTerminalApp().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
