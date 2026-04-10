import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapTerminalState, renderAppShell, SpecRailTerminalApiClient } from "../index.js";

test("SpecRailTerminalApiClient loads a summary snapshot", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input) => {
    const url = String(input);

    if (url.includes("/tracks")) {
      return new Response(JSON.stringify({ tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }] }), { status: 200 });
    }

    return new Response(JSON.stringify({ runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }] }), {
      status: 200,
    });
  });

  const summary = await client.loadSummary();
  assert.equal(summary.tracks[0]?.id, "track-1");
  assert.equal(summary.runs[0]?.id, "run-1");
});

test("bootstrapTerminalState initializes the home screen", async () => {
  const state = await bootstrapTerminalState(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      initialScreen: "home",
    },
    {
      async loadSummary() {
        return {
          tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:00:00.000Z",
        };
      },
    },
  );

  assert.equal(state.screen, "home");
  assert.match(state.statusLine, /Loaded 1 tracks and 1 runs/);
});

test("renderAppShell renders the tracks screen with navigation and shortcuts", () => {
  const rendered = renderAppShell({
    screen: "tracks",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }],
      runs: [],
    },
  });

  assert.match(rendered, /SpecRail Terminal/);
  assert.match(rendered, /\[TRACKS\]/);
  assert.match(rendered, /track-1 \| ready \| Terminal shell/);
  assert.match(rendered, /Keys: 1 home, 2 tracks, 3 runs, 4 settings, r refresh, q quit/);
});
