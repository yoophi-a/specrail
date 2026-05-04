import assert from "node:assert/strict";
import test from "node:test";

import { buildRunReportUrl, handleTelegramUpdate, parseAttachmentReferences, SpecRailApiClient } from "../index.js";

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
        async findChannelBinding() {
          calls.push("findChannelBinding");
          return null;
        },
        async createTrack(input) {
          calls.push(`createTrack:${input.title}:${input.projectId}`);
          assert.equal(input.description, "Build Telegram frontend\nNeed thin adapter app");
          return { track: { id: "track-1", projectId: "project-non-default", title: input.title } };
        },
        async bindChannel(input) {
          calls.push(`bindChannel:${input.trackId}:${input.projectId}`);
          assert.equal(input.externalThreadId, "7");
          return { binding: { id: "binding-1", trackId: "track-1" } };
        },
        async registerAttachment(input) {
          calls.push(`registerAttachment:${input.externalFileId}:${input.trackId}`);
          return { attachment: { id: "attachment-1" } };
        },
        async startRun(input) {
          calls.push(`startRun:${input.trackId}`);
          assert.equal(input.prompt, "Build Telegram frontend\nNeed thin adapter app");
          return { run: { id: "run-1", status: "running" } };
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
    "7:Run run-1 is running.",
    "7:[run-1] Run started",
    "7:[run-1] Run completed",
  ]);
});

test("buildRunReportUrl encodes run ids against the configured API base", () => {
  assert.equal(buildRunReportUrl("http://127.0.0.1:4000", "run/1"), "http://127.0.0.1:4000/runs/run%2F1/report.md");
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
          return { run: { id: "run-2", status: "running" } };
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
      runReportBaseUrl: "http://127.0.0.1:4000",
    },
  );

  assert.deepEqual(telegramMessages, [
    "Using existing SpecRail track track-9. Starting a new run.",
    "Run run-2 is running.",
    "[run-2] Run started",
    "[run-2] Run failed\nReport: http://127.0.0.1:4000/runs/run-2/report.md",
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
      },
    },
    {
      specRail: {
        async findChannelBinding() {
          return { id: "binding-1", trackId: "track-9", planningSessionId: "plan-2" };
        },
        async createTrack() {
          throw new Error("should not create a new track");
        },
        async bindChannel() {
          throw new Error("should not rebind");
        },
        async registerAttachment() {
          calls.push("registerAttachment");
          return { attachment: { id: "attachment-1" } };
        },
        async startRun(input) {
          calls.push(`startRun:${input.trackId}:${input.planningSessionId}`);
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
    "startRun:track-9:plan-2",
    "sendMessage:Run run-2 is running.",
    "sendMessage:[run-2] Run completed",
  ]);
});

test("SpecRailApiClient parses SSE frames from run event streams", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"type":"task_status_changed","summary":"Run started"}\n\n'),
    encoder.encode('data: {"type":"task_status_changed","summary":"Run completed"}\n\n'),
  ];

  const client = new SpecRailApiClient("http://example.test", async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );

  const events: Array<{ type: string; summary?: string }> = [];
  for await (const event of client.streamRunEvents("run-1")) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "task_status_changed", summary: "Run started" },
    { type: "task_status_changed", summary: "Run completed" },
  ]);
});
