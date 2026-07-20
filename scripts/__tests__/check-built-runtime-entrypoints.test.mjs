import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkBuiltRuntimeEntrypoints } from "../check-built-runtime-entrypoints.mjs";

test("checkBuiltRuntimeEntrypoints imports built entrypoints with the built condition", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "specrail-built-entrypoints-ok-"));
  const entrypointPath = "apps/api/dist/index.js";
  await mkdir(path.dirname(path.join(rootDir, entrypointPath)), { recursive: true });
  await writeFile(path.join(rootDir, entrypointPath), "globalThis.__specrailSmoke = 'ok';\n", "utf8");

  assert.deepEqual(
    checkBuiltRuntimeEntrypoints(rootDir, [{ service: "api", path: entrypointPath }]),
    [],
  );
});

test("checkBuiltRuntimeEntrypoints reports missing built entrypoints", () => {
  const rootDir = path.join(tmpdir(), "specrail-built-entrypoints-missing");

  assert.deepEqual(
    checkBuiltRuntimeEntrypoints(rootDir, [{ service: "api", path: "apps/api/dist/index.js" }]),
    ["api: missing built entrypoint apps/api/dist/index.js; run pnpm build first"],
  );
});

test("checkBuiltRuntimeEntrypoints reports failed built entrypoint imports", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "specrail-built-entrypoints-fail-"));
  const entrypointPath = "apps/api/dist/index.js";
  await mkdir(path.dirname(path.join(rootDir, entrypointPath)), { recursive: true });
  await writeFile(path.join(rootDir, entrypointPath), "throw new Error('simulated built import failure');\n", "utf8");

  const failures = checkBuiltRuntimeEntrypoints(rootDir, [{ service: "api", path: entrypointPath }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /api: built entrypoint import failed/u);
  assert.match(failures[0] ?? "", /simulated built import failure/u);
});
