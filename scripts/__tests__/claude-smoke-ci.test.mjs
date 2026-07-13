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

function formatStdoutSnapshot(stdout) {
  const compact = stdout.replace(/\s+/gu, " ").trim();
  return compact.length > 2_000 ? `${compact.slice(0, 2_000)}...<truncated>` : compact;
}

function assertStdoutMatchesAll(stdout, patterns, label) {
  const missingPatterns = patterns.filter((pattern) => !pattern.test(stdout));
  assert.deepEqual(
    missingPatterns,
    [],
    `${label} missing expected stdout pattern(s): ${missingPatterns.map(String).join(", ")}\nStdout snapshot:\n${formatStdoutSnapshot(stdout)}`,
  );
}

test("Claude smoke CI trims requested smoke flag before deciding to run", () => {
  const result = runSmokeCi({ SPECRAIL_RUN_CLAUDE_SMOKE: " true " });

  assert.equal(result.status, 0);
  assertStdoutMatchesAll(
    result.stdout,
    [
      /- requested: `1`/u,
      /claude` CLI is not installed/u,
    ],
    "requested Claude smoke skip output",
  );
});

test("Claude smoke CI trims strict mode before failing skipped runs", () => {
  const result = runSmokeCi({
    SPECRAIL_CLAUDE_SMOKE_STRICT: " yes ",
    SPECRAIL_RUN_CLAUDE_SMOKE: " off ",
  });

  assert.equal(result.status, 1);
  assertStdoutMatchesAll(
    result.stdout,
    [
      /- strict mode: `1`/u,
      /SPECRAIL_RUN_CLAUDE_SMOKE=1/u,
    ],
    "strict Claude smoke skip output",
  );
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
    assertStdoutMatchesAll(
      result.stdout,
      [
        /simulated smoke failure/u,
        /Claude smoke failed\. Inspect the test output above/u,
      ],
      "failed Claude smoke output",
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
