import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkBuildOutputTestExcludes,
  requiredBuildConfigs,
  requiredTestExclude,
} from "../check-build-output-test-excludes.mjs";

async function writeBuildConfigs(rootDir, overrides = {}) {
  for (const configPath of requiredBuildConfigs) {
    const fullPath = path.join(rootDir, configPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    const config = overrides[configPath] ?? {
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist" },
      include: ["src/**/*.ts"],
      exclude: [requiredTestExclude],
    };
    await writeFile(fullPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
}

test("checkBuildOutputTestExcludes accepts build configs that exclude test sources", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "specrail-build-excludes-ok-"));
  await writeBuildConfigs(rootDir);

  assert.deepEqual(await checkBuildOutputTestExcludes(rootDir), []);
});

test("checkBuildOutputTestExcludes reports configs that would emit test sources", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "specrail-build-excludes-fail-"));
  await writeBuildConfigs(rootDir, {
    "apps/api/tsconfig.json": {
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist" },
      include: ["src/**/*.ts"],
    },
  });

  assert.deepEqual(await checkBuildOutputTestExcludes(rootDir), [
    `apps/api/tsconfig.json: expected exclude to include ${JSON.stringify(requiredTestExclude)}`,
  ]);
});
