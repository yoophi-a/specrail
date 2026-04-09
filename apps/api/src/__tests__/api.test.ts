import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultServer } from "../index.js";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "specrail-api-"));
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDataDir = process.env.SPECRAIL_DATA_DIR;
  const previousPort = process.env.SPECRAIL_PORT;

  process.env.NODE_ENV = "test";
  process.env.SPECRAIL_DATA_DIR = dataDir;
  process.env.SPECRAIL_PORT = "0";

  const server = createDefaultServer();

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.env.NODE_ENV = previousNodeEnv;
    process.env.SPECRAIL_DATA_DIR = previousDataDir;
    process.env.SPECRAIL_PORT = previousPort;
  }
}

test("API supports creating tracks, starting runs, and listing run events", async () => {
  await withServer(async (baseUrl) => {
    const trackResponse = await fetch(`${baseUrl}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Executor MVP",
        description: "Persist command metadata and launch runs.",
        priority: "high",
      }),
    });

    assert.equal(trackResponse.status, 201);
    const trackPayload = (await trackResponse.json()) as { track: { id: string; title: string } };
    assert.equal(trackPayload.track.title, "Executor MVP");

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId: trackPayload.track.id,
        prompt: "Implement the issue",
        profile: "default",
      }),
    });

    assert.equal(runResponse.status, 201);
    const runPayload = (await runResponse.json()) as { run: { id: string; sessionRef?: string } };
    assert.ok(runPayload.run.sessionRef);

    const getRunResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}`);
    assert.equal(getRunResponse.status, 200);

    const eventsResponse = await fetch(`${baseUrl}/runs/${runPayload.run.id}/events`);
    assert.equal(eventsResponse.status, 200);
    const eventsPayload = (await eventsResponse.json()) as { events: Array<{ type: string }> };
    assert.equal(eventsPayload.events.length, 2);
    assert.deepEqual(
      eventsPayload.events.map((event) => event.type),
      ["task_status_changed", "shell_command"],
    );
  });
});

test("API returns 404s for unknown tracks and runs", async () => {
  await withServer(async (baseUrl) => {
    const missingTrack = await fetch(`${baseUrl}/tracks/missing`);
    assert.equal(missingTrack.status, 404);

    const missingRun = await fetch(`${baseUrl}/runs/missing/events`);
    assert.equal(missingRun.status, 404);
  });
});
