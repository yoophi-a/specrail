import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpecRailService } from "@specrail/core";

import { createDependencies } from "../runtime.js";

const execFileAsync = promisify(execFile);

async function createService(rootDir: string): Promise<SpecRailService> {
  const dependencies = createDependencies(path.join(rootDir, "data"), path.join(rootDir, "repo-visible"));
  return new SpecRailService(dependencies.serviceDependencies);
}

test("CLI previews and applies guided OpenSpec imports", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-openspec-"));
  const sourceService = await createService(path.join(rootDir, "source"));
  const targetService = await createService(path.join(rootDir, "target"));

  const track = await sourceService.createTrack({
    title: "CLI import source",
    description: "Source track for CLI import",
  });

  const bundleDir = path.join(rootDir, "bundle");
  await sourceService.exportTrackToOpenSpec({
    trackId: track.id,
    target: { kind: "file", path: bundleDir },
  });

  const preview = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "import", "--path", bundleDir, "--preset", "policyDefaults", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "target", "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "target", "repo-visible"),
    },
  });
  const previewPayload = JSON.parse(preview.stdout) as {
    result: { applied: boolean; conflictPolicy: string; operatorGuide: { selectedPreset: { name: string } | null } };
  };
  assert.equal(previewPayload.result.applied, false);
  assert.equal(previewPayload.result.conflictPolicy, "reject");
  assert.equal(previewPayload.result.operatorGuide.selectedPreset?.name, "policyDefaults");

  const apply = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "import", "--path", bundleDir, "--apply", "--preset", "policyDefaults", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "target", "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "target", "repo-visible"),
    },
  });
  const applyPayload = JSON.parse(apply.stdout) as {
    result: { applied: boolean; conflictPolicy: string; track: { id: string; openSpecImport?: { resolutionPreset?: string } } };
  };
  assert.equal(applyPayload.result.applied, true);
  assert.equal(applyPayload.result.conflictPolicy, "resolve");
  assert.equal(applyPayload.result.track.openSpecImport?.resolutionPreset, "policyDefaults");

  const importedTrack = await targetService.getTrack(track.id);
  assert.equal(importedTrack?.title, "CLI import source");

  const spec = await readFile(path.join(rootDir, "target", "data", "artifacts", "tracks", track.id, "spec.md"), "utf8");
  assert.ok(spec.includes("CLI import source"));
});

test("CLI exposes import help in JSON mode", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "specrail-cli-openspec-help-"));

  const result = await execFileAsync("pnpm", ["exec", "tsx", "--tsconfig", "../../tsconfig.base.json", "src/cli.ts", "openspec", "import", "help", "--preset", "policyDefaults", "--json"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SPECRAIL_DATA_DIR: path.join(rootDir, "data"),
      SPECRAIL_REPO_ARTIFACT_DIR: path.join(rootDir, "repo-visible"),
    },
  });

  const payload = JSON.parse(result.stdout) as {
    operatorGuide: { selectedPreset: { name: string } | null; examples: Array<{ id: string }> };
  };
  assert.equal(payload.operatorGuide.selectedPreset?.name, "policyDefaults");
  assert.ok(payload.operatorGuide.examples.some((example) => example.id === "preset-with-override"));
});
