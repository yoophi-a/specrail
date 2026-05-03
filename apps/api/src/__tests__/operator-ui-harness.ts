import vm from "node:vm";

import { renderOperatorUiClientScript } from "../operator-ui.js";

export type HostedUiFetchCall = {
  path: string;
  method: string;
  body: unknown;
};

export class FakeElement {
  public value = "";
  public textContent = "";
  public className = "";
  public disabled = false;
  public hidden = false;
  public isConnected = true;
  public children: FakeElement[] = [];
  private readonly listeners = new Map<string, Array<(event: { currentTarget: FakeElement }) => unknown>>();
  private readonly descendants = new Map<string, FakeElement>();
  private readonly descendantLists = new Map<string, FakeElement[]>();
  private readonly attributes = new Map<string, string>();
  private innerHtmlValue = "";

  public get innerHTML(): string {
    return this.innerHtmlValue;
  }

  public set innerHTML(value: string) {
    this.innerHtmlValue = value;
    this.descendants.clear();
    this.descendantLists.clear();
  }

  public addEventListener(type: string, listener: (event: { currentTarget: FakeElement }) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public async click(): Promise<void> {
    for (const listener of this.listeners.get("click") ?? []) {
      await listener({ currentTarget: this });
    }
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  public append(child: FakeElement): void {
    this.children.push(child);
  }

  public get firstElementChild(): FakeElement | undefined {
    return this.children[0];
  }

  public remove(): void {
    this.isConnected = false;
  }

  public querySelector(selector: string): FakeElement {
    const existing = this.descendants.get(selector);
    if (existing) {
      this.syncAttributeFromInnerHtml(selector, existing);
      return existing;
    }
    const created = new FakeElement();
    this.syncAttributeFromInnerHtml(selector, created);
    this.descendants.set(selector, created);
    return created;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    if (selector === "[data-artifact-proposal]") {
      return [this.querySelector(selector)];
    }
    if (selector === "[data-approval-id]") {
      const existing = this.descendantLists.get(selector);
      if (existing) return existing;

      const buttons = Array.from(this.innerHTML.matchAll(/<button data-approval-id="([^"]*)" data-decision="([^"]*)">/g)).map((match) => {
        const button = new FakeElement();
        button.setAttribute("data-approval-id", match[1] ?? "");
        button.setAttribute("data-decision", match[2] ?? "");
        return button;
      });
      this.descendantLists.set(selector, buttons);
      return buttons;
    }
    return [];
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  private syncAttributeFromInnerHtml(selector: string, element: FakeElement): void {
    const attributeName = selector.match(/^\[([^\]]+)\]$/)?.[1];
    if (!attributeName) return;
    const attributeValue = this.innerHTML.match(new RegExp(`${attributeName}="([^"]*)"`))?.[1] ?? "";
    element.setAttribute(attributeName, attributeValue);
  }
}

export class FakeEventSource {
  public onerror: (() => void) | undefined;
  public closed = false;
  private readonly listeners = new Map<string, Array<(message: { data: string }) => void>>();

  public constructor(public readonly url: string) {}

  public addEventListener(type: string, listener: (message: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  public fail(): void {
    this.onerror?.();
  }

  public close(): void {
    this.closed = true;
  }
}

export function createHostedUiClientHarness() {
  const selectors = [
    "#project-scope",
    "#status",
    "#tracks",
    "#runs",
    "#detail",
    "#refresh",
    "#project-create",
    "#project-update",
    "#track-create",
    "#project-name",
    "#project-repo-url",
    "#project-local-repo-path",
    "#project-workflow-policy",
    "#project-planning-system",
    "#track-title",
    "#track-description",
    "#track-priority",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  const scope = elements.get("#project-scope")!;
  const trackPriority = elements.get("#track-priority")!;
  trackPriority.value = "medium";

  const projects = [{ id: "project-1", name: "Project One", repoUrl: "https://example.com/one", localRepoPath: "/repo/one", defaultWorkflowPolicy: "standard", defaultPlanningSystem: "native" }];
  const artifactApprovalRequests = {
    spec: [{ id: "approval-spec-1", status: "pending" }],
    plan: [{ id: "approval-plan-1", status: "pending" }],
    tasks: [],
  };
  const tracks: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const calls: HostedUiFetchCall[] = [];
  const eventSources: FakeEventSource[] = [];
  let projectCounter = 2;
  let trackCounter = 1;
  let runCounter = 1;
  let planningSessionId: string | undefined;

  const document = {
    querySelector(selector: string) {
      const element = elements.get(selector);
      if (!element) throw new Error(`Missing fake element for ${selector}`);
      return element;
    },
    createElement() {
      return new FakeElement();
    },
  };

  async function fetch(path: string, init?: { method?: string; body?: string }) {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ path, method, body });

    if (path === "/projects" && method === "GET") {
      return { ok: true, json: async () => ({ projects }) };
    }
    if (path === "/projects" && method === "POST") {
      const project = { id: `project-${projectCounter++}`, ...(body as Record<string, unknown>) };
      projects.push(project as typeof projects[number]);
      return { ok: true, json: async () => ({ project }) };
    }
    if (path.startsWith("/projects/") && method === "PATCH") {
      const projectId = decodeURIComponent(path.slice("/projects/".length));
      const project = { id: projectId, ...(body as Record<string, unknown>) };
      return { ok: true, json: async () => ({ project }) };
    }
    if (path.startsWith("/tracks?page=1&pageSize=20") && method === "GET") {
      return { ok: true, json: async () => ({ tracks }) };
    }
    if (path === "/tracks" && method === "POST") {
      const track = { id: `track-${trackCounter++}`, status: "new", ...(body as Record<string, unknown>) };
      tracks.push(track);
      return { ok: true, json: async () => ({ track }) };
    }
    if (/^\/tracks\/[^/]+$/.test(path) && method === "GET") {
      const trackId = decodeURIComponent(path.slice("/tracks/".length));
      const track = tracks.find((candidate) => candidate.id === trackId) ?? { id: trackId, title: trackId, status: "new" };
      return { ok: true, json: async () => ({ track, planningContext: { planningSessionId }, artifacts: {} }) };
    }
    if (/^\/tracks\/[^/]+$/.test(path) && method === "PATCH") {
      const trackId = decodeURIComponent(path.slice("/tracks/".length));
      const track = { id: trackId, ...(body as Record<string, unknown>) };
      return { ok: true, json: async () => ({ track }) };
    }
    if (/^\/tracks\/[^/]+\/planning-sessions$/.test(path) && method === "POST") {
      planningSessionId = "planning-1";
      return { ok: true, json: async () => ({ planningSession: { id: planningSessionId, ...(body as Record<string, unknown>) } }) };
    }
    if (/^\/planning-sessions\/[^/]+\/messages$/.test(path) && method === "POST") {
      return { ok: true, json: async () => ({ message: { id: "message-1", ...(body as Record<string, unknown>) } }) };
    }
    if (/^\/tracks\/[^/]+\/artifacts\/(spec|plan|tasks)$/.test(path) && method === "GET") {
      const artifact = path.split("/").at(-1) as keyof typeof artifactApprovalRequests;
      return { ok: true, json: async () => ({ approvalRequests: artifactApprovalRequests[artifact] }) };
    }
    if (/^\/tracks\/[^/]+\/artifacts\/(spec|plan|tasks)$/.test(path) && method === "POST") {
      return { ok: true, json: async () => ({ revision: { id: "revision-1", ...(body as Record<string, unknown>) } }) };
    }
    if (path === "/runs?page=1&pageSize=20" && method === "GET") {
      return { ok: true, json: async () => ({ runs }) };
    }
    if (path === "/runs" && method === "POST") {
      const run = { id: `run-${runCounter++}`, status: "running", ...(body as Record<string, unknown>) };
      runs.push(run);
      return { ok: true, json: async () => ({ run }) };
    }
    if (/^\/runs\/[^/]+$/.test(path) && method === "GET") {
      const runId = decodeURIComponent(path.slice("/runs/".length));
      const run = runs.find((candidate) => candidate.id === runId) ?? { id: runId, trackId: "track-1", status: "running" };
      return { ok: true, json: async () => ({ run }) };
    }
    if (/^\/runs\/[^/]+\/events$/.test(path) && method === "GET") {
      return { ok: true, json: async () => ({ events: [] }) };
    }
    if (/^\/runs\/[^/]+\/resume$/.test(path) && method === "POST") {
      return { ok: true, json: async () => ({ run: { id: path.split("/")[2], status: "running", ...(body as Record<string, unknown>) } }) };
    }
    if (/^\/runs\/[^/]+\/cancel$/.test(path) && method === "POST") {
      return { ok: true, json: async () => ({ run: { id: path.split("/")[2], status: "cancelled" } }) };
    }
    if (/^\/runs\/[^/]+\/workspace-cleanup\/preview$/.test(path) && method === "GET") {
      return { ok: true, json: async () => ({ cleanupPlan: { eligible: true, operations: [{ kind: "delete", path: "/tmp/specrail-worktree" }], refusalReasons: [] } }) };
    }
    if (/^\/runs\/[^/]+\/workspace-cleanup\/apply$/.test(path) && method === "POST") {
      if ((body as { confirm?: string }).confirm === "") {
        return { ok: true, json: async () => ({ expectedConfirmation: "APPLY CLEANUP run-1" }) };
      }
      return { ok: true, json: async () => ({ cleanupResult: { status: "completed", failures: [] } }) };
    }
    if (/^\/approval-requests\/[^/]+\/(approve|reject)$/.test(path) && method === "POST") {
      return { ok: true, json: async () => ({ approvalRequest: { id: path.split("/")[2], ...(body as Record<string, unknown>) } }) };
    }
    throw new Error(`Unhandled fetch ${method} ${path}`);
  }

  const EventSource = class extends FakeEventSource {
    public constructor(url: string) {
      super(url);
      eventSources.push(this);
    }
  };

  vm.runInNewContext(renderOperatorUiClientScript(), {
    document,
    fetch,
    Option: class FakeOption {
      public textContent: string;
      public value: string;
      public constructor(label: string, value: string) {
        this.textContent = label;
        this.value = value;
      }
    },
    EventSource,
  });

  const detail = elements.get("#detail")!;

  async function loadInitialState(): Promise<void> {
    await flushClientPromises();
  }

  async function createTrack(input: { title: string; description?: string; priority?: string }): Promise<void> {
    elements.get("#track-title")!.value = input.title;
    elements.get("#track-description")!.value = input.description ?? "";
    elements.get("#track-priority")!.value = input.priority ?? "medium";
    await elements.get("#track-create")!.click();
    await flushClientPromises();
  }

  async function startRun(prompt: string): Promise<void> {
    detail.querySelector("#run-start-prompt").value = prompt;
    await detail.querySelector("[data-run-start]").click();
    await flushClientPromises();
  }

  async function requestCleanupPreview(): Promise<void> {
    await detail.querySelector("[data-cleanup-preview]").click();
    await flushClientPromises();
  }

  async function requestCleanupConfirmation(): Promise<void> {
    await detail.querySelector("[data-cleanup-request]").click();
    await flushClientPromises();
  }

  return { calls, detail, elements, eventSources, scope, createTrack, loadInitialState, requestCleanupConfirmation, requestCleanupPreview, startRun };
}

export async function flushClientPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
