import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRunEvents,
  bootstrapTerminalState,
  createEmptyRunEventFeedState,
  renderAppShell,
  refreshTerminalState,
  selectNextItem,
  SpecRailTerminalApiClient,
  syncRunEventSelection,
  type TerminalAppState,
} from "../index.js";

test("SpecRailTerminalApiClient loads a summary snapshot", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input) => {
    const url = String(input);

    if (url.includes("/tracks?page=")) {
      return new Response(JSON.stringify({ tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }] }), { status: 200 });
    }

    if (url.includes("/runs?page=")) {
      return new Response(JSON.stringify({ runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }] }), {
        status: 200,
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const summary = await client.loadSummary();
  assert.equal(summary.tracks[0]?.id, "track-1");
  assert.equal(summary.runs[0]?.id, "run-1");
});

test("SpecRailTerminalApiClient parses SSE frames from run event streams", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"id":"evt-1","executionId":"run-1","type":"task_status_changed","timestamp":"2026-04-10T12:00:00.000Z","source":"codex","summary":"Run started","payload":{"status":"running"}}\n\n'),
    encoder.encode('data: {"id":"evt-2","executionId":"run-1","type":"task_status_changed","subtype":"codex_completed","timestamp":"2026-04-10T12:02:00.000Z","source":"codex","summary":"Run completed","payload":{"status":"completed"}}\n\n'),
  ];

  const client = new SpecRailTerminalApiClient("http://example.test", async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );

  const events = [] as Array<{ id: string; type: string; summary: string; subtype?: string }>;
  for await (const event of client.streamRunEvents("run-1")) {
    events.push({ id: event.id, type: event.type, summary: event.summary, subtype: event.subtype });
  }

  assert.deepEqual(events, [
    { id: "evt-1", type: "task_status_changed", summary: "Run started", subtype: undefined },
    { id: "evt-2", type: "task_status_changed", summary: "Run completed", subtype: "codex_completed" },
  ]);
});

test("bootstrapTerminalState initializes detail selections for tracks and runs", async () => {
  const state = await bootstrapTerminalState(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      initialScreen: "home",
    },
    {
      async loadSummary() {
        return {
          tracks: [{ id: "track-1", title: "Terminal shell", status: "ready", priority: "high" }],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:00:00.000Z",
        };
      },
      async loadTrackDetail() {
        return {
          track: { id: "track-1", title: "Terminal shell", status: "ready", priority: "high" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { hasPendingChanges: false },
        };
      },
      async loadRunDetail() {
        return {
          run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        };
      },
    },
  );

  assert.equal(state.screen, "home");
  assert.match(state.statusLine, /Loaded 1 tracks and 1 runs/);
  assert.equal(state.tracks.selectedId, "track-1");
  assert.equal(state.runs.selectedId, "run-1");
  assert.equal(state.runEvents.runId, "run-1");
});

test("renderAppShell renders track list and selected detail preview", () => {
  const rendered = renderAppShell({
    screen: "tracks",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        track: {
          id: "track-1",
          title: "Terminal shell",
          status: "ready",
          priority: "high",
          specStatus: "approved",
          planStatus: "pending",
        },
        artifacts: {
          spec: "# Spec\nTerminal shell",
          plan: "# Plan\nAdd navigation",
          tasks: "# Tasks\n- Build it",
        },
        planningContext: { planningSessionId: "plan-1", hasPendingChanges: true },
      },
    },
    runs: {
      selectedId: null,
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runEvents: createEmptyRunEventFeedState(),
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready", priority: "high" }],
      runs: [],
    },
  });

  assert.match(rendered, /SpecRail Terminal/);
  assert.match(rendered, /\[TRACKS\]/);
  assert.match(rendered, /> track-1 \| ready \| high \| Terminal shell/);
  assert.match(rendered, /planning session: plan-1/);
  assert.match(rendered, /pending planning changes: yes/);
  assert.match(rendered, /spec preview: # Spec Terminal shell/);
  assert.match(rendered, /Keys: 1 home, 2 tracks, 3 runs, 4 settings, j\/k or ↑\/↓ select, r refresh, q quit/);
});

test("renderAppShell renders run event monitor details", () => {
  const rendered = renderAppShell({
    screen: "runs",
    statusLine: "Streaming run events.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: {
          id: "run-1",
          trackId: "track-1",
          status: "failed",
          backend: "claude_code",
          profile: "sonnet",
          planningSessionId: "plan-1",
          planningContextStale: true,
          planningContextStaleReason: "plan changed after launch",
          summary: { eventCount: 9, lastEventSummary: "Failed Claude Code session run-1-claude" },
          startedAt: "2026-04-10T12:00:00.000Z",
          finishedAt: "2026-04-10T12:05:00.000Z",
        },
      },
    },
    runEvents: appendRunEvents(
      {
        ...createEmptyRunEventFeedState("run-1"),
        connection: "reconnecting",
        reconnectAttempts: 2,
      },
      [
        {
          id: "evt-1",
          executionId: "run-1",
          type: "task_status_changed",
          timestamp: "2026-04-10T12:04:00.000Z",
          source: "claude_code",
          summary: "Failed Claude Code session run-1-claude",
          payload: { status: "failed", exitCode: 1 },
        },
      ],
    ),
    summary: {
      fetchedAt: "2026-04-10T12:06:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "failed" }],
      runs: [{ id: "run-1", trackId: "track-1", status: "failed", backend: "claude_code" }],
    },
  });

  assert.match(rendered, /event summary: 1 event, last at 2026-04-10T12:04:00.000Z/);
  assert.match(rendered, /failure focus: Failed Claude Code session run-1-claude \(exit 1\)/);
  assert.match(rendered, /stream: reconnecting \(attempt 2\)/);
  assert.match(rendered, /recent activity:/);
  assert.match(rendered, /task_status_changed \| status=failed \| Failed Claude Code session run-1-claude/);
});

test("selectNextItem advances run selection on runs screen", () => {
  const state = selectNextItem({
    screen: "runs",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
      },
    },
    runEvents: appendRunEvents(createEmptyRunEventFeedState("run-1"), [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
    ]),
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }],
      runs: [
        { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        { id: "run-2", trackId: "track-1", status: "completed", backend: "claude_code" },
      ],
    },
  } satisfies TerminalAppState);

  assert.equal(state.runs.selectedId, "run-2");
  assert.equal(state.runs.selectedIndex, 1);
  assert.equal(state.runs.data, null);
  assert.equal(state.runEvents.runId, "run-2");
  assert.deepEqual(state.runEvents.items, []);
});

test("refreshTerminalState preserves selection and surfaces detail load errors", async () => {
  const nextState = await refreshTerminalState(
    {
      screen: "tracks",
      statusLine: "Loaded terminal snapshot.",
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      loading: false,
      error: null,
      tracks: {
        selectedId: "track-2",
        selectedIndex: 1,
        loading: false,
        error: null,
        data: null,
      },
      runs: {
        selectedId: "run-1",
        selectedIndex: 0,
        loading: false,
        error: null,
        data: null,
      },
      runEvents: createEmptyRunEventFeedState("run-1"),
      summary: {
        fetchedAt: "2026-04-10T12:00:00.000Z",
        tracks: [
          { id: "track-1", title: "A", status: "ready" },
          { id: "track-2", title: "B", status: "blocked" },
        ],
        runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
      },
    },
    {
      async loadSummary() {
        return {
          tracks: [
            { id: "track-1", title: "A", status: "ready" },
            { id: "track-2", title: "B", status: "blocked" },
          ],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:05:00.000Z",
        };
      },
      async loadTrackDetail(trackId: string) {
        if (trackId === "track-2") {
          throw new Error("boom");
        }

        return {
          track: { id: trackId, title: "A", status: "ready" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { hasPendingChanges: false },
        };
      },
      async loadRunDetail() {
        return {
          run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        };
      },
    },
  );

  assert.equal(nextState.tracks.selectedId, "track-2");
  assert.equal(nextState.tracks.selectedIndex, 1);
  assert.equal(nextState.tracks.error, "boom");
  assert.match(nextState.statusLine, /Refreshed 2 tracks and 1 runs/);
});

test("appendRunEvents deduplicates by event id and syncRunEventSelection resets mismatched feeds", () => {
  const feed = appendRunEvents(
    appendRunEvents(createEmptyRunEventFeedState("run-1"), [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
    ]),
    [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
      {
        id: "evt-2",
        executionId: "run-1",
        type: "summary",
        timestamp: "2026-04-10T12:01:00.000Z",
        source: "codex",
        summary: "Planning context updated",
      },
    ],
  );

  assert.equal(feed.items.length, 2);
  assert.equal(feed.lastEventAt, "2026-04-10T12:01:00.000Z");

  const reset = syncRunEventSelection({
    screen: "runs",
    statusLine: "ok",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: { selectedId: null, selectedIndex: 0, loading: false, error: null, data: null },
    runs: { selectedId: "run-2", selectedIndex: 1, loading: false, error: null, data: null },
    runEvents: { ...feed, runId: "run-1", connection: "live" },
    summary: {
      fetchedAt: "2026-04-10T12:02:00.000Z",
      tracks: [],
      runs: [{ id: "run-2", trackId: "track-1", status: "running" }],
    },
  });

  assert.equal(reset.runEvents.runId, "run-2");
  assert.deepEqual(reset.runEvents.items, []);
  assert.equal(reset.runEvents.connection, "idle");
});
