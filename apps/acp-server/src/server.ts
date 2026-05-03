import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type Execution,
  type ExecutionEvent,
  type RuntimeApprovalResolutionResult,
  type SpecRailService,
  NotFoundError,
  ValidationError,
} from "@specrail/core";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface AcpSessionRecord {
  sessionId: string;
  cwd: string;
  projectId?: string;
  trackId?: string;
  planningSessionId?: string;
  backend?: string;
  profile?: string;
  title?: string;
  runId?: string;
  status?: Execution["status"];
  pendingPermissionRequest?: {
    requestId: string;
    requestedAt: string;
    summary: string;
    toolName?: string;
    toolUseId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface PendingPromptState {
  cancelled: boolean;
}

interface SessionNewParams {
  cwd?: string;
  mcpServers?: unknown[];
  _meta?: {
    specrail?: {
      projectId?: string;
      trackId?: string;
      planningSessionId?: string;
      backend?: string;
      profile?: string;
      title?: string;
    };
  };
}

interface SessionPromptParams {
  sessionId?: string;
  prompt?: Array<{ type?: string; text?: string; resource?: { text?: string } }>;
  _meta?: {
    specrail?: {
      permissionResolution?: {
        requestId?: string;
        outcome?: "approved" | "rejected";
        decidedBy?: string;
        comment?: string;
      };
    };
  };
}

interface SessionLoadParams {
  sessionId?: string;
  cwd?: string;
}

interface SessionListParams {
  cwd?: string;
  cursor?: string;
}

interface SessionCancelParams {
  sessionId?: string;
}

export interface AcpServerOptions {
  service: SpecRailService;
  stateDir: string;
  now?: () => string;
  pollIntervalMs?: number;
  pageSize?: number;
}

export class SpecRailAcpServer {
  private readonly sessionsDir: string;
  private readonly now: () => string;
  private readonly pollIntervalMs: number;
  private readonly pageSize: number;
  private readonly pendingPrompts = new Map<string, PendingPromptState>();

  constructor(private readonly options: AcpServerOptions) {
    this.sessionsDir = path.join(options.stateDir, "acp-sessions");
    this.now = options.now ?? (() => new Date().toISOString());
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.pageSize = options.pageSize ?? 20;
  }

  async handleMessage(message: JsonRpcRequest, notify: (payload: unknown) => void): Promise<JsonRpcResponse | null> {
    if (message.method === undefined) {
      return null;
    }

    try {
      switch (message.method) {
        case "initialize":
          return this.ok(message.id, {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: false,
                audio: false,
                embeddedContext: true,
              },
              mcpCapabilities: {
                http: false,
                sse: false,
              },
              sessionCapabilities: {
                list: {},
              },
              _meta: {
                specrail: {
                  edgeAdapter: true,
                  sourceOfTruth: "specrail-service-and-http-api",
                },
              },
            },
            agentInfo: {
              name: "specrail-acp-server",
              title: "SpecRail ACP Edge Adapter",
              version: "0.1.0",
            },
            authMethods: [],
          });
        case "session/new":
          return this.ok(message.id, await this.handleSessionNew(message.params));
        case "session/load":
          await this.handleSessionLoad(message.params, notify);
          return this.ok(message.id, null);
        case "session/list":
          return this.ok(message.id, await this.handleSessionList(message.params));
        case "session/prompt":
          return this.ok(message.id, await this.handleSessionPrompt(message.params, notify));
        case "session/cancel":
          await this.handleSessionCancel(message.params);
          return message.id === undefined ? null : this.ok(message.id, null);
        default:
          return this.error(message.id, -32601, `method not found: ${message.method}`);
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        return this.error(message.id, -32004, error.message);
      }

      if (error instanceof ValidationError || error instanceof Error) {
        return this.error(message.id, -32602, error.message);
      }

      return this.error(message.id, -32000, "unknown acp server error");
    }
  }

  private async handleSessionNew(params: unknown): Promise<{ sessionId: string }> {
    const body = (params ?? {}) as SessionNewParams;
    const cwd = this.requireAbsolutePath(body.cwd, "cwd");
    const specrail = body._meta?.specrail;
    const trackId = this.optionalString(specrail?.trackId);
    const sessionId = `specrail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = this.now();
    const session: AcpSessionRecord = {
      sessionId,
      cwd,
      projectId: this.optionalString(specrail?.projectId),
      trackId,
      planningSessionId: this.optionalString(specrail?.planningSessionId),
      backend: this.optionalString(specrail?.backend),
      profile: this.optionalString(specrail?.profile),
      title: this.optionalString(specrail?.title),
      createdAt,
      updatedAt: createdAt,
    };
    await this.writeSession(session);
    return { sessionId };
  }

  private async handleSessionLoad(params: unknown, notify: (payload: unknown) => void): Promise<void> {
    const body = (params ?? {}) as SessionLoadParams;
    const sessionId = this.requireNonEmptyString(body.sessionId, "sessionId");
    const session = await this.readSession(sessionId);

    if (body.cwd !== undefined && body.cwd !== session.cwd) {
      throw new ValidationError(`session cwd mismatch for ${sessionId}`);
    }

    if (!session.runId) {
      return;
    }

    const execution = await this.requireRun(session.runId);
    const events = await this.options.service.listRunEvents(execution.id);
    for (const event of events) {
      notify(this.toSessionUpdate(session.sessionId, event));
    }
    notify(this.toSessionInfoUpdate(session, execution));
  }

  private async handleSessionList(params: unknown): Promise<{ sessions: Array<Record<string, unknown>>; nextCursor?: string }> {
    const body = (params ?? {}) as SessionListParams;
    const all = await this.listSessions();
    const filtered = body.cwd ? all.filter((session) => session.cwd === body.cwd) : all;
    const offset = this.decodeCursor(body.cursor);
    const page = filtered.slice(offset, offset + this.pageSize);
    const nextOffset = offset + page.length;

    return {
      sessions: page.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
        _meta: {
          specrail: {
            projectId: session.projectId,
            trackId: session.trackId,
            planningSessionId: session.planningSessionId,
            backend: session.backend,
            profile: session.profile,
            runId: session.runId,
          },
        },
      })),
      ...(nextOffset < filtered.length ? { nextCursor: this.encodeCursor(nextOffset) } : {}),
    };
  }

  private async handleSessionPrompt(
    params: unknown,
    notify: (payload: unknown) => void,
  ): Promise<{ stopReason: "end_turn" | "cancelled" }> {
    const body = (params ?? {}) as SessionPromptParams;
    const sessionId = this.requireNonEmptyString(body.sessionId, "sessionId");
    const session = await this.readSession(sessionId);
    const prompt = this.flattenPrompt(body.prompt);
    if (!prompt) {
      throw new ValidationError("prompt must contain at least one text or embedded resource block");
    }

    const pending: PendingPromptState = { cancelled: false };
    this.pendingPrompts.set(sessionId, pending);

    try {
      let execution: Execution;
      let startingEventCount = 0;

      const permissionResolution = body._meta?.specrail?.permissionResolution;

      if (session.runId && permissionResolution) {
        execution = await this.requireRun(session.runId);
        startingEventCount = (await this.options.service.listRunEvents(execution.id)).length;
      } else if (session.runId) {
        execution = await this.options.service.resumeRun({ runId: session.runId, prompt, profile: session.profile, backend: session.backend });
        startingEventCount = (await this.options.service.listRunEvents(execution.id)).length;
      } else {
        const trackId = session.trackId ?? (await this.options.service.createTrack({
          title: session.title ?? this.deriveTrackTitle(prompt),
          description: prompt,
          priority: "medium",
          projectId: session.projectId,
        })).id;
        execution = await this.options.service.startRun({
          trackId,
          prompt,
          backend: session.backend,
          profile: session.profile,
          planningSessionId: session.planningSessionId,
        });
      }

      const track = await this.options.service.getTrack(execution.trackId);
      const title = session.title ?? track?.title ?? `Run ${execution.id}`;
      let updatedSession: AcpSessionRecord = {
        ...session,
        title,
        projectId: track?.projectId ?? session.projectId,
        trackId: execution.trackId,
        runId: execution.id,
        status: execution.status,
        updatedAt: this.now(),
      };
      await this.writeSession(updatedSession);
      notify(this.toSessionInfoUpdate(updatedSession, execution));

      if (permissionResolution) {
        const resolution = await this.resolvePendingPermission(updatedSession, execution, permissionResolution);
        if (resolution) {
          notify(this.toSessionUpdate(updatedSession.sessionId, resolution.event));
          if (permissionResolution.outcome === "approved" && resolution.callback.status !== "handled") {
            execution = await this.options.service.resumeRun({
              runId: execution.id,
              prompt,
              profile: session.profile,
              backend: session.backend,
            });
          }
        }
      }

      const seenEventIds = new Set<string>();
      const initialEvents = await this.options.service.listRunEvents(execution.id);
      for (const event of initialEvents.slice(startingEventCount)) {
        seenEventIds.add(event.id);
        updatedSession = await this.applyEventToSession(updatedSession, execution, event);
        for (const payload of this.toSessionNotifications(updatedSession, event)) {
          notify(payload);
        }
      }

      if (updatedSession.status === "waiting_approval" || updatedSession.pendingPermissionRequest) {
        return { stopReason: "end_turn" };
      }

      while (true) {
        if (pending.cancelled) {
          return { stopReason: "cancelled" };
        }

        const run = await this.requireRun(execution.id);
        const events = await this.options.service.listRunEvents(execution.id);
        for (const event of events) {
          if (!seenEventIds.has(event.id)) {
            seenEventIds.add(event.id);
            updatedSession = await this.applyEventToSession(updatedSession, run, event);
            for (const payload of this.toSessionNotifications(updatedSession, event)) {
              notify(payload);
            }
          }
        }

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          return { stopReason: run.status === "cancelled" ? "cancelled" : "end_turn" };
        }

        if (run.status === "waiting_approval" || updatedSession.pendingPermissionRequest) {
          return { stopReason: "end_turn" };
        }

        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    } finally {
      this.pendingPrompts.delete(sessionId);
    }
  }

  private async handleSessionCancel(params: unknown): Promise<void> {
    const body = (params ?? {}) as SessionCancelParams;
    const sessionId = this.requireNonEmptyString(body.sessionId, "sessionId");
    const session = await this.readSession(sessionId);
    const pending = this.pendingPrompts.get(sessionId);
    if (pending) {
      pending.cancelled = true;
    }
    if (session.runId) {
      await this.options.service.cancelRun({ runId: session.runId });
    }
  }

  private toSessionInfoUpdate(session: AcpSessionRecord, execution: Execution): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: session.title,
          updatedAt: session.updatedAt,
          _meta: {
            specrail: {
              runId: execution.id,
              projectId: session.projectId,
              trackId: execution.trackId,
              backend: execution.backend,
              profile: execution.profile,
              status: session.status ?? execution.status,
              planningSessionId: execution.planningSessionId,
              workspacePath: execution.workspacePath,
              pendingPermissionRequest: session.pendingPermissionRequest,
            },
          },
        },
      },
    };
  }

  private async applyEventToSession(
    session: AcpSessionRecord,
    execution: Execution,
    event: ExecutionEvent,
  ): Promise<AcpSessionRecord> {
    let nextSession = session;
    let dirty = false;

    const status = this.readSessionStatus(event);
    if (status && status !== session.status) {
      nextSession = { ...nextSession, status };
      dirty = true;
    }

    if (event.type === "approval_requested") {
      const pendingPermissionRequest = {
        requestId: event.id,
        requestedAt: event.timestamp,
        summary: event.summary,
        toolName: this.readString(event.payload?.toolName),
        toolUseId: this.readString(event.payload?.toolUseId),
      };
      nextSession = {
        ...nextSession,
        status: "waiting_approval",
        pendingPermissionRequest,
      };
      dirty = true;
    }

    if (event.type === "approval_resolved") {
      nextSession = {
        ...nextSession,
        pendingPermissionRequest: undefined,
      };
      dirty = true;
    }

    if (dirty) {
      nextSession = {
        ...nextSession,
        updatedAt: this.now(),
      };
      await this.writeSession(nextSession);
    }

    return nextSession;
  }

  private toSessionNotifications(session: AcpSessionRecord, event: ExecutionEvent): Array<Record<string, unknown>> {
    const notifications: Array<Record<string, unknown>> = [];
    const status = this.readSessionStatus(event);

    if (event.type === "approval_requested" || event.type === "approval_resolved" || status) {
      notifications.push(
        this.toSessionInfoUpdate(session, {
          id: session.runId ?? event.executionId,
          trackId: session.trackId ?? "",
          backend: session.backend ?? event.source,
          profile: session.profile ?? "default",
          workspacePath: "",
          branchName: "",
          planningSessionId: session.planningSessionId,
          status: session.status ?? "created",
          createdAt: session.createdAt,
        }),
      );
    }

    if (event.type === "approval_requested") {
      notifications.push(this.toPermissionRequest(session, event));
    }

    notifications.push(this.toSessionUpdate(session.sessionId, event));
    return notifications;
  }

  private toPermissionRequest(session: AcpSessionRecord, event: ExecutionEvent): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      method: "session/request_permission",
      params: {
        sessionId: session.sessionId,
        requestId: event.id,
        title: event.summary,
        toolName: this.readString(event.payload?.toolName),
        toolUseId: this.readString(event.payload?.toolUseId),
        toolInput: event.payload?.toolInput,
        message: this.readString(event.payload?.error) ?? event.summary,
        _meta: {
          specrail: {
            executionEvent: event,
          },
        },
      },
    };
  }

  private toSessionUpdate(sessionId: string, event: ExecutionEvent): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[${event.type}] ${event.summary}`,
          },
          _meta: {
            specrail: {
              executionEvent: event,
            },
          },
        },
      },
    };
  }

  private ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
  }

  private flattenPrompt(prompt: SessionPromptParams["prompt"]): string {
    return (prompt ?? [])
      .flatMap((block) => {
        if (block?.type === "text" && typeof block.text === "string") {
          return [block.text.trim()];
        }
        if (block?.type === "resource" && typeof block.resource?.text === "string") {
          return [block.resource.text.trim()];
        }
        return [];
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private deriveTrackTitle(prompt: string): string {
    const line = prompt.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0)?.trim() ?? "ACP request";
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
  }

  private requireAbsolutePath(value: unknown, field: string): string {
    const text = this.requireNonEmptyString(value, field);
    if (!path.isAbsolute(text)) {
      throw new ValidationError(`${field} must be an absolute path`);
    }
    return text;
  }

  private requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new ValidationError(`${field} is required`);
    }
    return value.trim();
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readSessionStatus(event: ExecutionEvent): Execution["status"] | null {
    const status = event.payload?.status;
    if (
      status === "created" ||
      status === "queued" ||
      status === "running" ||
      status === "waiting_approval" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return status;
    }

    if (event.type === "approval_requested") {
      return "waiting_approval";
    }

    return null;
  }

  private async resolvePendingPermission(
    session: AcpSessionRecord,
    execution: Execution,
    resolution: SessionPromptParams["_meta"] extends infer Meta
      ? Meta extends { specrail?: { permissionResolution?: infer R } }
        ? R
        : never
      : never,
  ): Promise<RuntimeApprovalResolutionResult | null> {
    const pending = session.pendingPermissionRequest;
    if (!pending) {
      throw new ValidationError("permissionResolution provided but there is no pending runtime permission request");
    }

    const requestId = this.requireNonEmptyString(resolution?.requestId, "_meta.specrail.permissionResolution.requestId");
    if (requestId !== pending.requestId) {
      throw new ValidationError(`permissionResolution.requestId does not match pending request: ${requestId}`);
    }

    const outcome = resolution?.outcome;
    if (outcome !== "approved" && outcome !== "rejected") {
      throw new ValidationError("_meta.specrail.permissionResolution.outcome must be approved or rejected");
    }

    const decidedBy = this.optionalString(resolution?.decidedBy) ?? "user";
    if (decidedBy !== "user" && decidedBy !== "agent" && decidedBy !== "system") {
      throw new ValidationError("_meta.specrail.permissionResolution.decidedBy must be user, agent, or system");
    }

    const result = await this.options.service.resolveRuntimeApprovalRequest({
      runId: execution.id,
      requestId,
      outcome,
      decidedBy,
      comment: this.optionalString(resolution?.comment),
    });

    const updatedSession: AcpSessionRecord = {
      ...session,
      pendingPermissionRequest: undefined,
      status: outcome === "approved" ? "running" : "cancelled",
      updatedAt: this.now(),
    };
    await this.writeSession(updatedSession);
    Object.assign(session, updatedSession);

    return result;
  }

  private async requireRun(runId: string): Promise<Execution> {
    const run = await this.options.service.getRun(runId);
    if (!run) {
      throw new NotFoundError(`Run not found: ${runId}`);
    }
    return run;
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private async writeSession(session: AcpSessionRecord): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.sessionPath(session.sessionId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  private async readSession(sessionId: string): Promise<AcpSessionRecord> {
    try {
      const content = await readFile(this.sessionPath(sessionId), "utf8");
      return JSON.parse(content) as AcpSessionRecord;
    } catch {
      throw new NotFoundError(`ACP session not found: ${sessionId}`);
    }
  }

  private async listSessions(): Promise<AcpSessionRecord[]> {
    try {
      const entries = await readdir(this.sessionsDir);
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .sort()
          .map(async (entry) => JSON.parse(await readFile(path.join(this.sessionsDir, entry), "utf8")) as AcpSessionRecord),
      );
      return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch {
      return [];
    }
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64");
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) {
      return 0;
    }

    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { offset?: number };
      return typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0;
    } catch {
      throw new ValidationError("cursor is invalid");
    }
  }
}
