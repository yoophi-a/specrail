import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { loadTerminalClientConfig, type SpecRailTerminalClientConfig } from "@specrail/config";

export type TerminalScreenId = "home" | "tracks" | "runs" | "settings";

export interface TrackListItem {
  id: string;
  title: string;
  status?: string;
  priority?: string;
}

export interface RunListItem {
  id: string;
  trackId: string;
  status: string;
  backend?: string;
}

export interface TerminalSummarySnapshot {
  tracks: TrackListItem[];
  runs: RunListItem[];
  fetchedAt: string;
}

export interface TerminalAppState {
  screen: TerminalScreenId;
  statusLine: string;
  summary: TerminalSummarySnapshot | null;
  apiBaseUrl: string;
  refreshIntervalMs: number;
}

interface TracksResponse {
  tracks: TrackListItem[];
}

interface RunsResponse {
  runs: RunListItem[];
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
      this.request<TracksResponse>("/tracks?page=1&pageSize=5"),
      this.request<RunsResponse>("/runs?page=1&pageSize=5"),
    ]);

    return {
      tracks: tracksPayload.tracks,
      runs: runsPayload.runs,
      fetchedAt: new Date().toISOString(),
    };
  }
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
    `Keys: 1 home, 2 tracks, 3 runs, 4 settings, r refresh, q quit | Refresh ${state.refreshIntervalMs}ms`,
  ].join("\n");
}

function renderScreenBody(state: TerminalAppState): string[] {
  if (!state.summary) {
    return ["Loading terminal snapshot..."];
  }

  switch (state.screen) {
    case "tracks":
      return [
        "Recent tracks",
        ...renderList(state.summary.tracks.map((track) => `${track.id} | ${track.status ?? "unknown"} | ${track.title}`), "No tracks yet."),
      ];
    case "runs":
      return [
        "Recent runs",
        ...renderList(
          state.summary.runs.map((run) => `${run.id} | ${run.status} | ${run.trackId} | ${run.backend ?? "default"}`),
          "No runs yet.",
        ),
      ];
    case "settings":
      return [
        "Settings",
        `- API base URL: ${state.apiBaseUrl}`,
        `- Refresh interval: ${state.refreshIntervalMs}ms`,
        "- Next step: add persisted operator preferences and view-specific filters.",
      ];
    case "home":
    default:
      return [
        "Overview",
        `- Tracks loaded: ${state.summary.tracks.length}`,
        `- Runs loaded: ${state.summary.runs.length}`,
        `- Last fetch: ${state.summary.fetchedAt}`,
        "- Shell ready for dedicated track/run inspection views.",
      ];
  }
}

function renderList(items: string[], emptyMessage: string): string[] {
  if (items.length === 0) {
    return [`- ${emptyMessage}`];
  }

  return items.map((item) => `- ${item}`);
}

export async function bootstrapTerminalState(
  config: SpecRailTerminalClientConfig,
  client: Pick<SpecRailTerminalApiClient, "loadSummary">,
): Promise<TerminalAppState> {
  const summary = await client.loadSummary();

  return {
    screen: config.initialScreen,
    statusLine: `Loaded ${summary.tracks.length} tracks and ${summary.runs.length} runs.`,
    summary,
    apiBaseUrl: config.apiBaseUrl,
    refreshIntervalMs: config.refreshIntervalMs,
  };
}

export async function runTerminalApp(
  config: SpecRailTerminalClientConfig = loadTerminalClientConfig(),
  io: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } = { stdout: process.stdout, stdin: process.stdin },
): Promise<void> {
  const client = new SpecRailTerminalApiClient(config.apiBaseUrl);
  let state = await bootstrapTerminalState(config, client);

  const render = () => {
    io.stdout.write("\u001Bc");
    io.stdout.write(`${renderAppShell(state)}\n`);
  };

  const refresh = async () => {
    try {
      state = await bootstrapTerminalState(config, client);
    } catch (error) {
      state = {
        ...state,
        statusLine: error instanceof Error ? error.message : "Failed to refresh terminal snapshot.",
      };
    }

    render();
  };

  render();

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
