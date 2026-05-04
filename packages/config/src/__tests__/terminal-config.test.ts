import assert from "node:assert/strict";
import test from "node:test";

import { loadTerminalClientConfig } from "../index.js";

test("loadTerminalClientConfig returns defaults", () => {
  assert.deepEqual(loadTerminalClientConfig({}), {
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    initialScreen: "home",
    initialProjectId: null,
    initialRunFilter: "all",
    preferencePath: null,
  });
});

test("loadTerminalClientConfig reads terminal-specific environment values", () => {
  assert.deepEqual(
    loadTerminalClientConfig({
      SPECRAIL_API_BASE_URL: "http://localhost:9999",
      SPECRAIL_TERMINAL_REFRESH_MS: "15000",
      SPECRAIL_TERMINAL_INITIAL_SCREEN: "runs",
      SPECRAIL_TERMINAL_INITIAL_PROJECT_ID: "project-1",
      SPECRAIL_TERMINAL_INITIAL_RUN_FILTER: "active",
      SPECRAIL_TERMINAL_PREFERENCES_PATH: ".specrail-terminal/preferences.json",
    }),
    {
      apiBaseUrl: "http://localhost:9999",
      refreshIntervalMs: 15000,
      initialScreen: "runs",
      initialProjectId: "project-1",
      initialRunFilter: "active",
      preferencePath: ".specrail-terminal/preferences.json",
    },
  );
});

test("loadTerminalClientConfig falls back for unsupported initial run filters", () => {
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_RUN_FILTER: "recent" }).initialRunFilter, "all");
});
