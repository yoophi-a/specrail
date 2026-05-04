import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL, URL } from "node:url";

export interface TelegramAppConfig {
  apiBaseUrl: string;
  telegramBotToken: string;
  port: number;
  webhookPath: string;
  projectId?: string;
}

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  chat: TelegramChat;
  from?: TelegramUser;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TrackResponse {
  track: { id: string; title: string; projectId?: string };
}

interface RunResponse {
  run: { id: string; status: string };
}

interface ChannelBindingResponse {
  binding?: { id: string; trackId?: string; planningSessionId?: string };
}

interface AttachmentListResponse {
  attachments: Array<{ externalFileId: string }>;
}

export function loadTelegramAppConfig(env: NodeJS.ProcessEnv = process.env): TelegramAppConfig {
  return {
    apiBaseUrl: env.SPECRAIL_API_BASE_URL ?? "http://127.0.0.1:4000",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    port: Number(env.TELEGRAM_APP_PORT ?? 4100),
    webhookPath: env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook",
    projectId: env.SPECRAIL_TELEGRAM_PROJECT_ID ?? env.SPECRAIL_PROJECT_ID,
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    throw new Error("request body is empty");
  }

  return JSON.parse(raw) as T;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function sanitizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function deriveTrackTitle(text: string): string {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0)?.trim() ?? "Telegram request";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function getExternalRefs(message: TelegramMessage): { chatId: string; threadId?: string; userId?: string } {
  return {
    chatId: String(message.chat.id),
    threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
    userId: message.from ? String(message.from.id) : undefined,
  };
}

function getPromptFromMessage(message: TelegramMessage): string {
  const text = sanitizeText(message.text ?? message.caption);
  return text || "Please inspect the linked Telegram attachments and continue the existing SpecRail context.";
}

export function buildRunReportUrl(apiBaseUrl: string, runId: string): string {
  return new URL(`/runs/${encodeURIComponent(runId)}/report.md`, apiBaseUrl).toString();
}

function isTerminalRunSummary(summary: string): boolean {
  return ["completed", "failed", "cancelled"].includes(summary.toLowerCase().replace(/^run /u, ""));
}

function formatRunEventTelegramMessage(runId: string, summary: string, reportBaseUrl?: string): string {
  const baseMessage = `[${runId}] ${summary}`;
  if (!reportBaseUrl || !isTerminalRunSummary(summary)) {
    return baseMessage;
  }

  return `${baseMessage}\nReport: ${buildRunReportUrl(reportBaseUrl, runId)}`;
}

export function parseAttachmentReferences(message: TelegramMessage): Array<{
  sourceType: "telegram";
  externalFileId: string;
  fileName?: string;
  mimeType?: string;
}> {
  const attachments: Array<{
    sourceType: "telegram";
    externalFileId: string;
    fileName?: string;
    mimeType?: string;
  }> = [];

  if (message.document) {
    attachments.push({
      sourceType: "telegram",
      externalFileId: message.document.file_id,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
    });
  }

  const largestPhoto = message.photo?.at(-1);
  if (largestPhoto) {
    attachments.push({
      sourceType: "telegram",
      externalFileId: largestPhoto.file_id,
      mimeType: "image/jpeg",
    });
  }

  return attachments;
}

export class SpecRailApiClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`SpecRail API request failed (${response.status}) for ${pathname}`);
    }

    return (await response.json()) as T;
  }

  findChannelBinding(input: { channelType: "telegram"; externalChatId: string; externalThreadId?: string }) {
    const url = new URL("/channel-bindings", this.baseUrl);
    url.searchParams.set("channelType", input.channelType);
    url.searchParams.set("externalChatId", input.externalChatId);
    if (input.externalThreadId) {
      url.searchParams.set("externalThreadId", input.externalThreadId);
    }

    return this.fetchImpl(url)
      .then(async (response) => {
        if (response.status === 404) {
          return null;
        }
        if (!response.ok) {
          throw new Error(`SpecRail API request failed (${response.status}) for /channel-bindings`);
        }
        return (await response.json()) as ChannelBindingResponse;
      })
      .then((payload) => payload?.binding ?? null);
  }

  createTrack(input: { title: string; description: string; priority?: "low" | "medium" | "high"; projectId?: string }) {
    return this.request<TrackResponse>("/tracks", { method: "POST", body: JSON.stringify(input) });
  }

  bindChannel(input: {
    projectId: string;
    channelType: "telegram";
    externalChatId: string;
    externalThreadId?: string;
    externalUserId?: string;
    trackId?: string;
    planningSessionId?: string;
  }) {
    return this.request<{ binding: NonNullable<ChannelBindingResponse["binding"]> }>("/channel-bindings", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  registerAttachment(input: {
    sourceType: "telegram";
    externalFileId: string;
    fileName?: string;
    mimeType?: string;
    trackId?: string;
    planningSessionId?: string;
  }) {
    return this.request<{ attachment: { id: string } }>("/attachments", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listAttachments(input: { planningSessionId?: string; trackId?: string }) {
    const url = new URL("/attachments", this.baseUrl);
    if (input.planningSessionId) {
      url.searchParams.set("planningSessionId", input.planningSessionId);
    }
    if (input.trackId) {
      url.searchParams.set("trackId", input.trackId);
    }

    return this.fetchImpl(url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`SpecRail API request failed (${response.status}) for /attachments`);
      }
      return (await response.json()) as AttachmentListResponse;
    });
  }

  startRun(input: { trackId: string; prompt: string; planningSessionId?: string }) {
    return this.request<RunResponse>("/runs", { method: "POST", body: JSON.stringify(input) });
  }

  async *streamRunEvents(runId: string): AsyncGenerator<{ type: string; summary?: string }> {
    const response = await this.fetchImpl(new URL(`/runs/${runId}/events/stream`, this.baseUrl));
    if (!response.ok || !response.body) {
      throw new Error(`SpecRail API request failed (${response.status}) for /runs/${runId}/events/stream`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      while (true) {
        const separatorIndex = buffer.indexOf("\n\n");
        if (separatorIndex === -1) {
          break;
        }

        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim();

        if (!dataLine) {
          continue;
        }

        yield JSON.parse(dataLine) as { type: string; summary?: string };
      }
    }
  }
}

export class TelegramBotClient {
  private readonly baseUrl: string;

  constructor(token: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async sendMessage(input: { chatId: string; text: string; messageThreadId?: string }): Promise<void> {
    await this.call("/sendMessage", {
      chat_id: Number(input.chatId),
      text: input.text,
      ...(input.messageThreadId ? { message_thread_id: Number(input.messageThreadId) } : {}),
    });
  }

  private async call(pathname: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram API request failed (${response.status}) for ${pathname}`);
    }
  }
}

export interface TelegramFrontendDeps {
  specRail: Pick<
    SpecRailApiClient,
    "findChannelBinding" | "createTrack" | "bindChannel" | "registerAttachment" | "startRun" | "streamRunEvents"
  >;
  telegram: Pick<TelegramBotClient, "sendMessage">;
  projectId?: string;
  runReportBaseUrl?: string;
}

export async function handleTelegramUpdate(update: TelegramUpdate, deps: TelegramFrontendDeps): Promise<void> {
  const message = update.message;
  if (!message) {
    return;
  }

  const prompt = getPromptFromMessage(message);
  const refs = getExternalRefs(message);
  let binding = await deps.specRail.findChannelBinding({
    channelType: "telegram",
    externalChatId: refs.chatId,
    externalThreadId: refs.threadId,
  });

  const projectId = deps.projectId;

  if (!binding?.trackId) {
    const track = await deps.specRail.createTrack({
      title: deriveTrackTitle(prompt),
      description: prompt,
      priority: "medium",
      projectId,
    });

    const bound = await deps.specRail.bindChannel({
      projectId: track.track.projectId ?? projectId ?? "project-default",
      channelType: "telegram",
      externalChatId: refs.chatId,
      externalThreadId: refs.threadId,
      externalUserId: refs.userId,
      trackId: track.track.id,
      planningSessionId: binding?.planningSessionId,
    });
    binding = bound.binding;

    await deps.telegram.sendMessage({
      chatId: refs.chatId,
      messageThreadId: refs.threadId,
      text: `Created SpecRail track ${track.track.id} and starting a run.`,
    });
  } else {
    await deps.telegram.sendMessage({
      chatId: refs.chatId,
      messageThreadId: refs.threadId,
      text: `Using existing SpecRail track ${binding.trackId}. Starting a new run.`,
    });
  }

  const trackId = binding.trackId;
  if (!trackId) {
    throw new Error("channel binding is missing trackId");
  }

  for (const attachment of parseAttachmentReferences(message)) {
    await deps.specRail.registerAttachment({
      ...attachment,
      trackId,
      planningSessionId: binding.planningSessionId,
    });
  }

  const run = await deps.specRail.startRun({
    trackId,
    prompt,
    planningSessionId: binding.planningSessionId,
  });

  await deps.telegram.sendMessage({
    chatId: refs.chatId,
    messageThreadId: refs.threadId,
    text: `Run ${run.run.id} is ${run.run.status}.`,
  });

  for await (const event of deps.specRail.streamRunEvents(run.run.id)) {
    if (!event.summary) {
      continue;
    }

    await deps.telegram.sendMessage({
      chatId: refs.chatId,
      messageThreadId: refs.threadId,
      text: formatRunEventTelegramMessage(run.run.id, event.summary, deps.runReportBaseUrl),
    });

    if (isTerminalRunSummary(event.summary)) {
      break;
    }
  }
}

export function createTelegramWebhookServer(config: TelegramAppConfig, deps: TelegramFrontendDeps): http.Server {
  return http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === config.webhookPath) {
      try {
        const update = await readJson<TelegramUpdate>(request);
        await handleTelegramUpdate(update, deps);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "unknown error" });
      }
      return;
    }

    sendJson(response, 404, { ok: false, error: "not found" });
  });
}

export function createDefaultTelegramServer(config: TelegramAppConfig = loadTelegramAppConfig()): http.Server {
  const specRail = new SpecRailApiClient(config.apiBaseUrl);
  const telegram = new TelegramBotClient(config.telegramBotToken);
  return createTelegramWebhookServer(config, {
    specRail,
    telegram,
    projectId: config.projectId,
    runReportBaseUrl: config.apiBaseUrl,
  });
}

const isMainModule = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMainModule) {
  const config = loadTelegramAppConfig();
  const server = createDefaultTelegramServer(config);

  server.listen(config.port, () => {
    console.log(`[specrail] telegram frontend listening on port ${config.port}`);
  });
}
