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
    messageTemplatesPath: null,
    diffExportDirectory: null,
  });
});

test("loadTerminalClientConfig reads terminal-specific environment values", () => {
  assert.deepEqual(
    loadTerminalClientConfig({
      SPECRAIL_API_BASE_URL: "  http://localhost:9999  ",
      SPECRAIL_TERMINAL_REFRESH_MS: "15000",
      SPECRAIL_TERMINAL_INITIAL_SCREEN: "  Runs  ",
      SPECRAIL_TERMINAL_INITIAL_PROJECT_ID: " project/1 ",
      SPECRAIL_TERMINAL_INITIAL_RUN_FILTER: "  Active  ",
      SPECRAIL_TERMINAL_PREFERENCES_PATH: ".specrail-terminal/preferences.json",
      SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH: ".specrail-terminal/message-templates.json",
      SPECRAIL_TERMINAL_DIFF_EXPORT_DIR: ".specrail-terminal/diffs",
    }),
    {
      apiBaseUrl: "http://localhost:9999",
      refreshIntervalMs: 15000,
      initialScreen: "runs",
      initialProjectId: "project/1",
      initialRunFilter: "active",
      preferencePath: ".specrail-terminal/preferences.json",
      messageTemplatesPath: ".specrail-terminal/message-templates.json",
      diffExportDirectory: ".specrail-terminal/diffs",
    },
  );
});

test("loadTerminalClientConfig falls back for blank API base URL values", () => {
  assert.equal(loadTerminalClientConfig({ SPECRAIL_API_BASE_URL: "" }).apiBaseUrl, "http://127.0.0.1:4000");
  assert.equal(loadTerminalClientConfig({ SPECRAIL_API_BASE_URL: "   " }).apiBaseUrl, "http://127.0.0.1:4000");
});

test("loadTerminalClientConfig validates refresh interval environment values", () => {
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_REFRESH_MS: "0" }).refreshIntervalMs, 0);
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_REFRESH_MS: " 15000 " }).refreshIntervalMs, 15000);
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_REFRESH_MS: " " }).refreshIntervalMs, 5000);

  assert.throws(
    () => loadTerminalClientConfig({ SPECRAIL_TERMINAL_REFRESH_MS: "abc" }),
    /invalid SPECRAIL_TERMINAL_REFRESH_MS: abc/u,
  );
  assert.throws(
    () => loadTerminalClientConfig({ SPECRAIL_TERMINAL_REFRESH_MS: "5000.5" }),
    /invalid SPECRAIL_TERMINAL_REFRESH_MS: 5000.5/u,
  );
});

test("loadTerminalClientConfig falls back for unsupported initial run filters", () => {
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_RUN_FILTER: " Terminal " }).initialRunFilter, "terminal");
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_RUN_FILTER: "recent" }).initialRunFilter, "all");
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_RUN_FILTER: " " }).initialRunFilter, "all");
});

test("loadTerminalClientConfig falls back for unsupported initial screens", () => {
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_SCREEN: " Tracks " }).initialScreen, "tracks");
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_SCREEN: "dashboard" }).initialScreen, "home");
  assert.equal(loadTerminalClientConfig({ SPECRAIL_TERMINAL_INITIAL_SCREEN: " " }).initialScreen, "home");
});
