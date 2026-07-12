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

function readOptionalSmokeEnvValue(value: string | undefined, defaultValue: string): string {
  const normalized = value?.trim();
  return normalized || defaultValue;
}

function readOptionalSmokeBooleanEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const enabled = readOptionalSmokeBooleanEnvValue(process.env.SPECRAIL_RUN_CLAUDE_SMOKE);
const smokePrompt = readOptionalSmokeEnvValue(process.env.CLAUDE_SMOKE_PROMPT, "Reply with exactly the single word ok.");
const smokeProfile = readOptionalSmokeEnvValue(process.env.CLAUDE_SMOKE_MODEL, "default");

type ClaudeSmokeMetadata = Awaited<ReturnType<typeof readClaudeCodeSessionMetadata>>;
type ClaudeSmokeEvents = Awaited<ReturnType<typeof readClaudeCodeSessionEvents>>;

interface WaitForTerminalStatusOptions {
  readMetadata?: typeof readClaudeCodeSessionMetadata;
  sleep?: (durationMs: number) => Promise<void>;
  now?: () => number;
}

function formatClaudeSmokeStatus(metadata: ClaudeSmokeMetadata | undefined): string {
  if (!metadata) {
    return "no metadata observed";
  }

  return [
    `last status ${metadata.status}`,
    metadata.pid === undefined ? undefined : `pid ${metadata.pid}`,
    metadata.providerSessionId ? `provider session ${metadata.providerSessionId}` : undefined,
    metadata.exitCode === undefined ? undefined : `exit code ${metadata.exitCode}`,
    metadata.signal ? `signal ${metadata.signal}` : undefined,
    metadata.failureMessage ? `failure ${metadata.failureMessage}` : undefined,
    `updated at ${metadata.updatedAt}`,
  ].filter(Boolean).join("; ");
}

function formatClaudeSmokeEvents(events: ClaudeSmokeEvents): string {
  const subtypes = events.map((event) => event.subtype ?? event.type).slice(-10).join(" | ");
  return subtypes || "no events observed";
}

function formatRawOutputSnippet(rawOutput: string | null | undefined): string {
  return JSON.stringify((rawOutput ?? "").slice(-500));
}

async function waitForTerminalStatus(
  sessionsDir: string,
  sessionRef: string,
  timeoutMs = 60_000,
  options: WaitForTerminalStatusOptions = {},
): Promise<ClaudeSmokeMetadata> {
  const readMetadata = options.readMetadata ?? readClaudeCodeSessionMetadata;
  const sleep = options.sleep ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let lastMetadata: ClaudeSmokeMetadata | undefined;

  while (now() - startedAt < timeoutMs) {
    const metadata = await readMetadata(sessionsDir, sessionRef);
    lastMetadata = metadata;
    if (["completed", "failed", "cancelled"].includes(metadata.status)) {
      return metadata;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Claude smoke run ${sessionRef} to finish; ${formatClaudeSmokeStatus(lastMetadata)}.`);
}

test("Claude smoke wait timeout includes last observed metadata", async () => {
  let currentTime = 0;
  const metadata: ClaudeSmokeMetadata = {
    executionId: "execution-1",
    sessionRef: "session-1",
    backend: "claude_code",
    profile: "default",
    workspacePath: "/workspace",
    command: { command: "claude", args: [], cwd: "/workspace" },
    pid: 123,
    providerSessionId: "provider-1",
    status: "running",
    prompt: "Say ok",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
  };

  await assert.rejects(
    () => waitForTerminalStatus("sessions", "session-1", 500, {
      now: () => currentTime,
      sleep: async (durationMs) => {
        currentTime += durationMs;
      },
      readMetadata: async () => metadata,
    }),
    /last status running; pid 123; provider session provider-1; updated at 2026-07-12T00:00:01\.000Z/,
  );
});

test("Claude smoke diagnostics summarize assertion context", () => {
  const metadata: ClaudeSmokeMetadata = {
    executionId: "execution-1",
    sessionRef: "session-1",
    backend: "claude_code",
    profile: "default",
    workspacePath: "/workspace",
    command: { command: "claude", args: [], cwd: "/workspace" },
    providerSessionId: "provider-1",
    resumeSessionRef: "provider-1",
    status: "completed",
    prompt: "Say ok",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
  };
  const events = [
    { id: "event-1", executionId: "execution-1", type: "lifecycle", subtype: "claude_init", summary: "Started", timestamp: "2026-07-12T00:00:00.000Z", source: "claude_code" },
    { id: "event-2", executionId: "execution-1", type: "lifecycle", subtype: "claude_completed", summary: "Completed", timestamp: "2026-07-12T00:00:01.000Z", source: "claude_code" },
  ] as unknown as ClaudeSmokeEvents;

  assert.match(formatClaudeSmokeStatus(metadata), /last status completed; provider session provider-1; updated at 2026-07-12T00:00:01\.000Z/);
  assert.equal(formatClaudeSmokeEvents(events), "claude_init | claude_completed");
  assert.equal(formatRawOutputSnippet("assistant result"), "\"assistant result\"");
});

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
  assert.equal(metadata.status, "completed", metadata.failureMessage ?? `Claude smoke run did not complete successfully; ${formatClaudeSmokeStatus(metadata)}.`);
  assert.ok(metadata.providerSessionId, `Expected Claude smoke provider session id; ${formatClaudeSmokeStatus(metadata)}.`);
  assert.equal(
    metadata.resumeSessionRef,
    metadata.providerSessionId,
    `Expected resume session ref to match provider session id; ${formatClaudeSmokeStatus(metadata)}.`,
  );

  const events = await readClaudeCodeSessionEvents(sessionsDir, spawnResult.sessionRef);
  assert.ok(events.some((event) => event.subtype === "claude_init"), `Expected a Claude init event; observed ${formatClaudeSmokeEvents(events)}.`);
  assert.ok(
    events.some((event) => event.subtype === "claude_completed"),
    `Expected a Claude completed lifecycle event; observed ${formatClaudeSmokeEvents(events)}.`,
  );

  const rawOutput = await readClaudeCodeRawOutput(sessionsDir, spawnResult.sessionRef);
  assert.match(rawOutput ?? "", /session_id|result|assistant/u, `Expected Claude raw output to include a session/result marker; raw output tail ${formatRawOutputSnippet(rawOutput)}.`);
});
