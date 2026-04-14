import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkClaudeCodeReadiness,
  ClaudeCodeAdapter,
  readClaudeCodeRawOutput,
  readClaudeCodeSessionEvents,
  readClaudeCodeSessionMetadata,
} from "../index.js";

const enabled = process.env.SPECRAIL_RUN_CLAUDE_SMOKE === "1";
const smokePrompt =
  process.env.CLAUDE_SMOKE_PROMPT ?? "Reply with exactly the single word ok.";
const smokeProfile = process.env.CLAUDE_SMOKE_MODEL ?? "default";

async function waitForTerminalStatus(
  sessionsDir: string,
  sessionRef: string,
  timeoutMs = 60_000,
): Promise<Awaited<ReturnType<typeof readClaudeCodeSessionMetadata>>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const metadata = await readClaudeCodeSessionMetadata(sessionsDir, sessionRef);
    if (["completed", "failed", "cancelled"].includes(metadata.status)) {
      return metadata;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for Claude smoke run ${sessionRef} to finish.`);
}

const smokeTest = enabled ? test : test.skip;

smokeTest("ClaudeCodeAdapter smoke run completes with real Claude CLI output", async () => {
  const readiness = await checkClaudeCodeReadiness();
  assert.equal(
    readiness.ready,
    true,
    readiness.failureReason ?? readiness.suggestedAction ?? "Claude CLI readiness check failed.",
  );

  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), "specrail-claude-smoke-sessions-"));
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "specrail-claude-smoke-workspace-"));
  await mkdir(path.join(workspacePath, ".specrail-smoke"), { recursive: true });

  const adapter = new ClaudeCodeAdapter({ sessionsDir });
  const spawnResult = await adapter.spawn({
    executionId: `claude-smoke-${Date.now()}`,
    prompt: smokePrompt,
    workspacePath,
    profile: smokeProfile,
  });

  const metadata = await waitForTerminalStatus(sessionsDir, spawnResult.sessionRef);
  assert.equal(metadata.status, "completed", metadata.failureMessage ?? "Claude smoke run did not complete successfully.");
  assert.ok(metadata.providerSessionId);
  assert.equal(metadata.resumeSessionRef, metadata.providerSessionId);

  const events = await readClaudeCodeSessionEvents(sessionsDir, spawnResult.sessionRef);
  assert.ok(events.some((event) => event.subtype === "claude_init"), "Expected a Claude init event.");
  assert.ok(
    events.some((event) => event.subtype === "claude_completed"),
    "Expected a Claude completed lifecycle event.",
  );

  const rawOutput = await readClaudeCodeRawOutput(sessionsDir, spawnResult.sessionRef);
  assert.match(rawOutput ?? "", /session_id|result|assistant/u);
});
