import assert from "node:assert/strict";
import test from "node:test";

import { loadTerminalClientConfig } from "../index.js";

test("loadTerminalClientConfig returns defaults", () => {
  assert.deepEqual(loadTerminalClientConfig({}), {
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    initialScreen: "home",
  });
});

test("loadTerminalClientConfig reads terminal-specific environment values", () => {
  assert.deepEqual(
    loadTerminalClientConfig({
      SPECRAIL_API_BASE_URL: "http://localhost:9999",
      SPECRAIL_TERMINAL_REFRESH_MS: "15000",
      SPECRAIL_TERMINAL_INITIAL_SCREEN: "runs",
    }),
    {
      apiBaseUrl: "http://localhost:9999",
      refreshIntervalMs: 15000,
      initialScreen: "runs",
    },
  );
});
