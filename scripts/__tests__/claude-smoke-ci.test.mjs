import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Claude smoke CI writes a summary hint when the smoke test fails", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "specrail-claude-smoke-ci-"));
  try {
    const fakeClaudePath = join(fakeBin, "claude");
    const fakePnpmPath = join(fakeBin, "pnpm");
    writeFileSync(fakeClaudePath, "#!/usr/bin/env bash\necho 'claude 1.0.0'\n", "utf8");
    writeFileSync(
      fakePnpmPath,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "10.0.0"
  exit 0
fi
echo "simulated smoke failure"
exit 42
`,
      "utf8",
    );
    chmodSync(fakeClaudePath, 0o755);
    chmodSync(fakePnpmPath, 0o755);

    const result = runSmokeCi({
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SPECRAIL_RUN_CLAUDE_SMOKE: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /simulated smoke failure/u);
    assert.match(result.stdout, /Claude smoke failed\. Inspect the test output above/u);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
