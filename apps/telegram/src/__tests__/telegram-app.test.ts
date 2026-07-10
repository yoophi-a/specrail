import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  buildRunReportUrl,
  createTelegramWebhookServer,
  handleTelegramUpdate,
  loadTelegramAppConfig,
  parseAttachmentReferences,
  SpecRailApiClient,
  TelegramBotClient,
  type TelegramFrontendDeps,
} from "../index.js";

function createUnusedTelegramDeps(): TelegramFrontendDeps {
  return {
    specRail: {
      async findChannelBinding() {
        throw new Error("health check should not query SpecRail");
      },
      async createTrack() {
        throw new Error("health check should not create tracks");
      },
      async bindChannel() {
        throw new Error("health check should not bind channels");
      },
      async registerAttachment() {
        throw new Error("health check should not register attachments");
      },
      async startRun() {
        throw new Error("health check should not start runs");
      },
      async *streamRunEvents() {
        throw new Error("health check should not stream run events");
      },
    },
    telegram: {
      async sendMessage() {
        throw new Error("health check should not send Telegram messages");
      },
    },
  };
}

test("loadTelegramAppConfig validates port environment values", () => {
  assert.deepEqual(loadTelegramAppConfig({}), {
    apiBaseUrl: "http://127.0.0.1:4000",
    telegramBotToken: "",
    port: 4300,
    webhookPath: "/telegram/webhook",
    projectId: undefined,
  });

  assert.equal(loadTelegramAppConfig({ TELEGRAM_APP_PORT: " 4300 " }).port, 4300);
  assert.equal(loadTelegramAppConfig({ TELEGRAM_APP_PORT: "0" }).port, 0);
  assert.equal(loadTelegramAppConfig({ TELEGRAM_APP_PORT: " " }).port, 4300);
  assert.equal(loadTelegramAppConfig({ TELEGRAM_WEBHOOK_PATH: "telegram/custom" }).webhookPath, "/telegram/custom");
  assert.equal(loadTelegramAppConfig({ TELEGRAM_WEBHOOK_PATH: "  /telegram/custom  " }).webhookPath, "/telegram/custom");
  assert.throws(() => loadTelegramAppConfig({ TELEGRAM_APP_PORT: "abc" }), /invalid TELEGRAM_APP_PORT: abc/u);
  assert.throws(() => loadTelegramAppConfig({ TELEGRAM_APP_PORT: "4100.5" }), /invalid TELEGRAM_APP_PORT: 4100.5/u);
  assert.throws(() => loadTelegramAppConfig({ TELEGRAM_APP_PORT: "70000" }), /invalid TELEGRAM_APP_PORT: 70000/u);
});

test("loadTelegramAppConfig normalizes API base URL environment values", () => {
  assert.equal(loadTelegramAppConfig({ SPECRAIL_API_BASE_URL: " https://specrail.example.test " }).apiBaseUrl, "https://specrail.example.test");
  assert.equal(loadTelegramAppConfig({ SPECRAIL_API_BASE_URL: "" }).apiBaseUrl, "http://127.0.0.1:4000");
  assert.equal(loadTelegramAppConfig({ SPECRAIL_API_BASE_URL: "   " }).apiBaseUrl, "http://127.0.0.1:4000");
});

test("loadTelegramAppConfig normalizes bot token environment values", () => {
  assert.equal(loadTelegramAppConfig({ TELEGRAM_BOT_TOKEN: " token-value " }).telegramBotToken, "token-value");
  assert.equal(loadTelegramAppConfig({ TELEGRAM_BOT_TOKEN: "" }).telegramBotToken, "");
  assert.equal(loadTelegramAppConfig({ TELEGRAM_BOT_TOKEN: "   " }).telegramBotToken, "");
});

test("loadTelegramAppConfig normalizes project id environment values", () => {
  assert.equal(loadTelegramAppConfig({ SPECRAIL_PROJECT_ID: " shared-project " }).projectId, "shared-project");
  assert.equal(
    loadTelegramAppConfig({ SPECRAIL_TELEGRAM_PROJECT_ID: " telegram-project ", SPECRAIL_PROJECT_ID: "shared-project" }).projectId,
    "telegram-project",
  );
  assert.equal(
    loadTelegramAppConfig({ SPECRAIL_TELEGRAM_PROJECT_ID: " ", SPECRAIL_PROJECT_ID: " shared-project " }).projectId,
    "shared-project",
  );
  assert.equal(loadTelegramAppConfig({ SPECRAIL_TELEGRAM_PROJECT_ID: "", SPECRAIL_PROJECT_ID: "" }).projectId, undefined);
});

test("TelegramBotClient validates sendMessage numeric identifiers", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = new TelegramBotClient("token", async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    return new Response("{}", { status: 200 });
  });

  await client.sendMessage({ chatId: " -100123 ", messageThreadId: " 42 ", text: "hello" });
  await client.sendMessage({ chatId: "123", messageThreadId: " ", text: "no thread" });
  assert.deepEqual(requests, [
    {
      url: "https://api.telegram.org/bottoken/sendMessage",
      body: { chat_id: -100123, message_thread_id: 42, text: "hello" },
    },
    {
      url: "https://api.telegram.org/bottoken/sendMessage",
      body: { chat_id: 123, text: "no thread" },
    },
  ]);

  await assert.rejects(() => client.sendMessage({ chatId: "chat", text: "bad" }), /invalid Telegram chatId: chat/u);
  await assert.rejects(
    () => client.sendMessage({ chatId: "123", messageThreadId: "1e1", text: "bad" }),
    /invalid Telegram messageThreadId: 1e1/u,
  );
  assert.equal(requests.length, 2);
});

test("Telegram webhook server serves a health check", async () => {
  const server = createTelegramWebhookServer(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      telegramBotToken: "test-token",
      port: 0,
      webhookPath: "/telegram/webhook",
    },
    createUnusedTelegramDeps(),
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "specrail-telegram" });
  } finally {
    const closePromise = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closePromise;
  }
});

test("Telegram webhook server records update outcome metrics", async () => {
  const outcomes: string[] = [];
  const server = createTelegramWebhookServer(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      telegramBotToken: "test-token",
      port: 0,
      webhookPath: "/telegram/webhook",
    },
    {
      ...createUnusedTelegramDeps(),
      metrics: {
        increment(input) {
          outcomes.push(input.outcome);
        },
      },
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const ignoredResponse = await fetch(`http://127.0.0.1:${address.port}/telegram/webhook`, {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(ignoredResponse.status, 200);

    const failedResponse = await fetch(`http://127.0.0.1:${address.port}/telegram/webhook`, {
      method: "POST",
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 20,
          text: "will fail because test deps reject SpecRail calls",
          chat: { id: 123, type: "private" },
        },
      }),
    });
    assert.equal(failedResponse.status, 500);

    assert.deepEqual(outcomes, ["ignored", "failed"]);
  } finally {
    const closePromise = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closePromise;
  }
});

test("Telegram webhook server accepts normalized configured webhook paths", async () => {
  const server = createTelegramWebhookServer(loadTelegramAppConfig({ TELEGRAM_WEBHOOK_PATH: "telegram/custom" }), createUnusedTelegramDeps());

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/telegram/custom`, {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    const closePromise = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closePromise;
  }
});

test("parseAttachmentReferences extracts document and photo references", () => {
  assert.deepEqual(
    parseAttachmentReferences({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: "private" },
        document: { file_id: "doc-1", file_name: "brief.txt", mime_type: "text/plain" },
        photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }],
      },
    }.message!),
    [
      { sourceType: "telegram", externalFileId: "doc-1", fileName: "brief.txt", mimeType: "text/plain" },
      { sourceType: "telegram", externalFileId: "photo-large", mimeType: "image/jpeg" },
    ],
  );
});

test("handleTelegramUpdate creates a track, binds the chat, registers attachments, and relays run events", async () => {
  const calls: string[] = [];
  const telegramMessages: string[] = [];

  await handleTelegramUpdate(
    {
      update_id: 1,
      message: {
        message_id: 100,
        message_thread_id: 7,
        text: "Build Telegram frontend\nNeed thin adapter app",
        chat: { id: 55, type: "supergroup" },
        from: { id: 99, username: "lead" },
        document: { file_id: "file-1", file_name: "brief.md", mime_type: "text/markdown" },
      },
    },
    {
      specRail: {
        async findChannelBinding(input) {
          calls.push("findChannelBinding");
          assert.deepEqual(input, {
            channelType: "telegram",
            externalChatId: "55",
            externalThreadId: "7",
          });
          return null;
        },
        async createTrack(input) {
          calls.push(`createTrack:${input.title}:${input.projectId}`);
          assert.equal(input.description, "Build Telegram frontend\nNeed thin adapter app");
          return { track: { id: "track-1", projectId: "project-non-default", title: input.title } };
        },
        async bindChannel(input) {
          calls.push(`bindChannel:${input.trackId}:${input.projectId}`);
          assert.deepEqual(input, {
            projectId: "project-non-default",
            channelType: "telegram",
            externalChatId: "55",
            externalThreadId: "7",
            externalUserId: "99",
            trackId: "track-1",
            planningSessionId: undefined,
          });
          return { binding: { id: "binding-1", trackId: "track-1" } };
        },
        async registerAttachment(input) {
          calls.push(`registerAttachment:${input.externalFileId}:${input.trackId}`);
          assert.deepEqual(input, {
            sourceType: "telegram",
            externalFileId: "file-1",
            fileName: "brief.md",
            mimeType: "text/markdown",
            trackId: "track-1",
            planningSessionId: undefined,
          });
          return { attachment: { id: "attachment-1" } };
        },
        async startRun(input) {
          calls.push(`startRun:${input.trackId}`);
          assert.deepEqual(input, {
            trackId: "track-1",
            prompt: "Build Telegram frontend\nNeed thin adapter app",
            planningSessionId: undefined,
          });
          return { run: { id: "run/created", status: "running" } };
        },
        async *streamRunEvents() {
          yield { type: "task_status_changed", summary: "Run started" };
          yield { type: "task_status_changed", summary: "Run completed" };
        },
      },
      telegram: {
        async sendMessage(input) {
          telegramMessages.push(`${input.messageThreadId}:${input.text}`);
        },
      },
      projectId: "project-non-default",
      runReportBaseUrl: "http://127.0.0.1:4000/specrail",
    },
  );

  assert.deepEqual(calls, [
    "findChannelBinding",
    "createTrack:Build Telegram frontend:project-non-default",
    "bindChannel:track-1:project-non-default",
    "registerAttachment:file-1:track-1",
    "startRun:track-1",
  ]);
  assert.deepEqual(telegramMessages, [
    "7:Created SpecRail track track-1 and starting a run.",
    "7:Run run/created is running.",
    "7:[run/created] Run started",
    "7:[run/created] Run completed\nReport: http://127.0.0.1:4000/specrail/runs/run%2Fcreated/report.md",
  ]);
});

test("Telegram webhook server records accepted update metrics", async () => {
  const outcomes: string[] = [];
  const server = createTelegramWebhookServer(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      telegramBotToken: "test-token",
      port: 0,
      webhookPath: "/telegram/webhook",
    },
    {
      specRail: {
        async findChannelBinding() {
          return { id: "binding-1", trackId: "track-1" };
        },
        async createTrack() {
          throw new Error("should not create a new track");
        },
        async bindChannel() {
          throw new Error("should not bind a new channel");
        },
        async registerAttachment() {
          return { attachment: { id: "attachment-1" } };
        },
        async startRun() {
          return { run: { id: "run-1", status: "running" } };
        },
        async *streamRunEvents() {
          yield { type: "task_status_changed", summary: "Run completed" };
        },
      },
      telegram: {
        async sendMessage() {},
      },
      metrics: {
        increment(input) {
          outcomes.push(input.outcome);
        },
      },
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/telegram/webhook`, {
      method: "POST",
      body: JSON.stringify({
        update_id: 3,
        message: {
          message_id: 30,
          text: "accepted update",
          chat: { id: 123, type: "private" },
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(outcomes, ["accepted"]);
  } finally {
    const closePromise = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closePromise;
  }
});

test("buildRunReportUrl encodes run ids against the configured API base", () => {
  assert.equal(buildRunReportUrl("http://127.0.0.1:4000", "run/1"), "http://127.0.0.1:4000/runs/run%2F1/report.md");
  assert.equal(buildRunReportUrl("https://example.test/specrail", "run/1"), "https://example.test/specrail/runs/run%2F1/report.md");
});

test("handleTelegramUpdate adds report links only to terminal run notifications", async () => {
  const telegramMessages: string[] = [];

  await handleTelegramUpdate(
    {
      update_id: 2,
      message: {
        message_id: 200,
        text: "Run with report link",
        chat: { id: 88, type: "private" },
      },
    },
    {
      specRail: {
        async findChannelBinding() {
          return { id: "binding-1", trackId: "track-9" };
        },
        async createTrack() {
          throw new Error("should not create a new track");
        },
        async bindChannel() {
          throw new Error("should not rebind");
        },
        async registerAttachment() {
          return { attachment: { id: "attachment-1" } };
        },
        async startRun() {
          return { run: { id: "run/2", status: "running" } };
        },
        async *streamRunEvents() {
          yield { type: "task_status_changed", summary: "Run started" };
          yield { type: "task_status_changed", summary: "Run failed" };
        },
      },
      telegram: {
        async sendMessage(input) {
          telegramMessages.push(input.text);
        },
      },
      runReportBaseUrl: "http://127.0.0.1:4000/specrail",
    },
  );

  assert.deepEqual(telegramMessages, [
    "Using existing SpecRail track track-9. Starting a new run.",
    "Run run/2 is running.",
    "[run/2] Run started",
    "[run/2] Run failed\nReport: http://127.0.0.1:4000/specrail/runs/run%2F2/report.md",
  ]);
});

test("handleTelegramUpdate reuses an existing bound track", async () => {
  const calls: string[] = [];

  await handleTelegramUpdate(
    {
      update_id: 2,
      message: {
        message_id: 200,
        text: "Follow-up change",
        chat: { id: 88, type: "private" },
        document: { file_id: "follow-up-file", file_name: "follow-up.md", mime_type: "text/markdown" },
      },
    },
    {
      specRail: {
        async findChannelBinding(input) {
          assert.deepEqual(input, {
            channelType: "telegram",
            externalChatId: "88",
            externalThreadId: undefined,
          });
          return { id: "binding-1", trackId: "track-9", planningSessionId: "plan-2" };
        },
        async createTrack() {
          throw new Error("should not create a new track");
        },
        async bindChannel() {
          throw new Error("should not rebind");
        },
        async registerAttachment(input) {
          calls.push(`registerAttachment:${input.externalFileId}:${input.trackId}:${input.planningSessionId}`);
          assert.deepEqual(input, {
            sourceType: "telegram",
            externalFileId: "follow-up-file",
            fileName: "follow-up.md",
            mimeType: "text/markdown",
            trackId: "track-9",
            planningSessionId: "plan-2",
          });
          return { attachment: { id: "attachment-1" } };
        },
        async startRun(input) {
          calls.push(`startRun:${input.trackId}:${input.planningSessionId}`);
          assert.deepEqual(input, {
            trackId: "track-9",
            prompt: "Follow-up change",
            planningSessionId: "plan-2",
          });
          return { run: { id: "run-2", status: "running" } };
        },
        async *streamRunEvents() {
          yield { type: "task_status_changed", summary: "Run completed" };
        },
      },
      telegram: {
        async sendMessage(input) {
          calls.push(`sendMessage:${input.text}`);
        },
      },
    },
  );

  assert.deepEqual(calls, [
    "sendMessage:Using existing SpecRail track track-9. Starting a new run.",
    "registerAttachment:follow-up-file:track-9:plan-2",
    "startRun:track-9:plan-2",
    "sendMessage:Run run-2 is running.",
    "sendMessage:[run-2] Run completed",
  ]);
});

test("SpecRailApiClient parses SSE frames from run event streams", async () => {
  const encoder = new TextEncoder();
  const requests: string[] = [];
  const chunks = [
    encoder.encode('data: {"type":"task_status_changed","summary":"Run started"}\n\n'),
    encoder.encode('data: {"type":"task_status_changed","summary":"Run completed"}\n\n'),
  ];

  const client = new SpecRailApiClient("http://example.test/specrail", async (input) => {
    requests.push(String(input));
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });

  const events: Array<{ type: string; summary?: string }> = [];
  for await (const event of client.streamRunEvents("run/1")) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "task_status_changed", summary: "Run started" },
    { type: "task_status_changed", summary: "Run completed" },
  ]);
  assert.deepEqual(requests, ["http://example.test/specrail/runs/run%2F1/events/stream"]);
});
