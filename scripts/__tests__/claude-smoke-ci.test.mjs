import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = fileURLToPath(new URL("../run-claude-smoke-ci.sh", import.meta.url));

function runSmokeCi(env = {}) {
  return spawnSync("/bin/bash", [scriptPath], {
    encoding: "utf8",
    env: {
      PATH: "",
      ...env,
    },
  });
}

test("Claude smoke CI trims requested smoke flag before deciding to run", () => {
  const result = runSmokeCi({ SPECRAIL_RUN_CLAUDE_SMOKE: " true " });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /- requested: `1`/u);
  assert.match(result.stdout, /claude` CLI is not installed/u);
});

test("Claude smoke CI trims strict mode before failing skipped runs", () => {
  const result = runSmokeCi({
    SPECRAIL_CLAUDE_SMOKE_STRICT: " yes ",
    SPECRAIL_RUN_CLAUDE_SMOKE: " off ",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /- strict mode: `1`/u);
  assert.match(result.stdout, /SPECRAIL_RUN_CLAUDE_SMOKE=1/u);
});
