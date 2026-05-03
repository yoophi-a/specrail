import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  operatorUiApprovalDecisionPath,
  operatorUiArtifactProposalPath,
  operatorUiCleanupApplyPath,
  operatorUiCleanupPreviewPath,
  operatorUiEscapeHtml,
  operatorUiMetadataHtml,
  operatorUiPlanningMessageAppendPath,
  operatorUiPlanningSessionCreatePath,
  operatorUiPreviewHtml,
  operatorUiProjectCreatePath,
  operatorUiProjectUpdatePath,
  operatorUiRunCancelPath,
  operatorUiRunCreatePath,
  operatorUiRunEventStreamPath,
  operatorUiRunResumePath,
  operatorUiTrackCreatePath,
  operatorUiTrackUpdatePath,
  renderOperatorUiClientScript,
  renderOperatorUiHtml,
  renderOperatorUiStyleCss,
} from "../operator-ui.js";

function assertContainsAll(body: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(body, pattern);
  }
}

type HostedUiFetchCall = {
  path: string;
  method: string;
  body: unknown;
};

class FakeElement {
  public value = "";
  public textContent = "";
  public innerHTML = "";
  public className = "";
  public disabled = false;
  public hidden = false;
  public isConnected = true;
  public children: FakeElement[] = [];
  private readonly listeners = new Map<string, Array<(event: { currentTarget: FakeElement }) => unknown>>();
  private readonly descendants = new Map<string, FakeElement>();

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
    if (existing) return existing;
    const created = new FakeElement();
    this.descendants.set(selector, created);
    return created;
  }

  public querySelectorAll(): FakeElement[] {
    return [];
  }
}

function createHostedUiClientHarness() {
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
  const tracks: Array<Record<string, unknown>> = [];
  const calls: HostedUiFetchCall[] = [];
  let projectCounter = 2;
  let trackCounter = 1;

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
      return { ok: true, json: async () => ({ track, planningContext: {}, artifacts: {} }) };
    }
    if (/^\/tracks\/[^/]+\/artifacts\/(spec|plan|tasks)$/.test(path) && method === "GET") {
      return { ok: true, json: async () => ({ approvalRequests: [] }) };
    }
    if (path === "/runs?page=1&pageSize=20" && method === "GET") {
      return { ok: true, json: async () => ({ runs: [] }) };
    }
    throw new Error(`Unhandled fetch ${method} ${path}`);
  }

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
    EventSource: undefined,
  });

  return { calls, elements, scope };
}

async function flushClientPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("operator UI helpers escape metadata and previews", () => {
  assert.equal(operatorUiEscapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(operatorUiMetadataHtml([["Run", "run-1"], ["Missing", undefined]]), "<dl><dt>Run</dt><dd>run-1</dd><dt>Missing</dt><dd>unknown</dd></dl>");
  assert.equal(operatorUiPreviewHtml("Spec", "hello <world>"), '<h3>Spec</h3><div class="artifact-preview">hello &lt;world&gt;</div>');
  assert.equal(operatorUiPreviewHtml("Empty", ""), "");
});

test("operator UI helpers build encoded action URLs", () => {
  assert.equal(operatorUiProjectCreatePath(), "/projects");
  assert.equal(operatorUiProjectUpdatePath("project/1"), "/projects/project%2F1");
  assert.equal(operatorUiTrackCreatePath(), "/tracks");
  assert.equal(operatorUiTrackUpdatePath("track/1"), "/tracks/track%2F1");
  assert.equal(operatorUiPlanningSessionCreatePath("track/1"), "/tracks/track%2F1/planning-sessions");
  assert.equal(operatorUiPlanningMessageAppendPath("planning/1"), "/planning-sessions/planning%2F1/messages");
  assert.equal(operatorUiApprovalDecisionPath("approval/request 1", "approve"), "/approval-requests/approval%2Frequest%201/approve");
  assert.equal(operatorUiArtifactProposalPath("track/1", "spec"), "/tracks/track%2F1/artifacts/spec");
  assert.equal(operatorUiRunCreatePath(), "/runs");
  assert.equal(operatorUiRunResumePath("run/1"), "/runs/run%2F1/resume");
  assert.equal(operatorUiRunCancelPath("run/1"), "/runs/run%2F1/cancel");
  assert.equal(operatorUiCleanupPreviewPath("run/1"), "/runs/run%2F1/workspace-cleanup/preview");
  assert.equal(operatorUiCleanupApplyPath("run/1"), "/runs/run%2F1/workspace-cleanup/apply");
  assert.equal(operatorUiRunEventStreamPath("run/1"), "/runs/run%2F1/events/stream");
});

test("operator UI renderer exposes style and client script helpers", () => {
  const style = renderOperatorUiStyleCss();
  const script = renderOperatorUiClientScript();

  assert.match(style, /\.detail-grid/);
  assert.match(style, /\.artifact-preview/);
  assert.match(style, /\.form-grid/);
  assert.match(style, /textarea/);
  assert.match(script, /async function withAction/);
  assert.match(script, /populateProjectForm/);
  assert.match(script, /function option/);
  assert.match(script, /new EventSource/);
  assert.match(script, /workspace-cleanup\/apply/);
});

test("operator UI client script stays on in-page controls instead of native dialogs", () => {
  const script = renderOperatorUiClientScript();
  const body = renderOperatorUiHtml();

  assert.doesNotMatch(script, /window\.prompt/);
  assert.doesNotMatch(script, /window\.confirm/);
  assert.match(body, /id="project-name"/);
  assert.match(body, /id="track-title"/);
  assert.match(body, /id="planning-message-body"/);
  assert.match(body, /id="artifact-proposal-content"/);
  assert.match(body, /id="track-workflow-status"/);
  assert.match(body, /id="run-start-prompt"/);
  assert.match(body, /id="run-resume-prompt"/);
  assert.match(body, /id="run-cancel-confirmation"/);
  assert.match(body, /id="cleanup-confirmation"/);
});

test("operator UI client harness submits top-level project and track actions", async () => {
  const { calls, elements, scope } = createHostedUiClientHarness();
  await flushClientPromises();

  elements.get("#project-name")!.value = "Project Two";
  elements.get("#project-repo-url")!.value = "https://example.com/two";
  elements.get("#project-local-repo-path")!.value = "/repo/two";
  elements.get("#project-workflow-policy")!.value = "strict";
  elements.get("#project-planning-system")!.value = "native";
  await elements.get("#project-create")!.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/projects")?.body, {
    name: "Project Two",
    repoUrl: "https://example.com/two",
    localRepoPath: "/repo/two",
    defaultWorkflowPolicy: "strict",
    defaultPlanningSystem: "native",
  });

  elements.get("#project-name")!.value = "Project Two Updated";
  elements.get("#project-repo-url")!.value = "";
  elements.get("#project-local-repo-path")!.value = "/repo/two-updated";
  elements.get("#project-workflow-policy")!.value = "";
  elements.get("#project-planning-system")!.value = "speckit";
  await elements.get("#project-update")!.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "PATCH" && call.path === "/projects/project-2")?.body, {
    name: "Project Two Updated",
    repoUrl: null,
    localRepoPath: "/repo/two-updated",
    defaultWorkflowPolicy: null,
    defaultPlanningSystem: "speckit",
  });

  elements.get("#track-title")!.value = "Track One";
  elements.get("#track-description")!.value = "Implement track one";
  elements.get("#track-priority")!.value = "high";
  await elements.get("#track-create")!.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks")?.body, {
    projectId: scope.value,
    title: "Track One",
    description: "Implement track one",
    priority: "high",
  });
  assert.equal(elements.get("#track-title")!.value, "");
  assert.equal(elements.get("#track-priority")!.value, "medium");
});

test("operator UI shell keeps hosted action and stream wiring", () => {
  const body = renderOperatorUiHtml();

  const controlGroups = {
    shell: [/SpecRail Operator/, /<style>\n/, /<script type="module">\n/, /\.artifact-preview/],
    project: [/data-control-group="project-form"/, /id="project-create"/, /id="project-update"/, /id="project-name"/, /id="project-repo-url"/, /method: 'PATCH'/, /defaultWorkflowPolicy/, /defaultPlanningSystem/, /optionalNullableInputValue/],
    track: [/data-control-group="track-form"/, /id="track-create"/, /id="track-title"/, /id="track-priority"/, /data-track-update/, /data-control-group="track-workflow"/, /id="track-workflow-status"/, /id="track-workflow-spec-status"/],
    planning: [/data-control-group="track-planning"/, /data-planning-session-create/, /id="planning-session-status"/, /data-planning-message-append/, /id="planning-message-body"/, /id="planning-message-author"/],
    artifacts: [/data-approval-id/, /data-control-group="artifact-proposal"/, /data-artifact-proposal/, /id="artifact-proposal-kind"/, /id="artifact-proposal-content"/, /Propose artifact/, /createdBy: 'user'/],
    runs: [/data-control-group="track-run-start"/, /data-run-start/, /id="run-start-prompt"/, /data-control-group="run-lifecycle"/, /data-run-resume/, /id="run-resume-prompt"/, /id="run-cancel-confirmation"/, /data-run-cancel/],
    cleanup: [/workspace-cleanup\/preview/, /data-cleanup-request/, /data-control-group="cleanup-confirmation"/, /id="cleanup-confirmation"/, /workspace-cleanup\/apply/, /Refresh failed:/],
    streamsAndActions: [/new EventSource/, /events\/stream/, /async function withAction/, /function errorMessage/, /button.disabled = true/, /button.isConnected/],
  };

  for (const patterns of Object.values(controlGroups)) {
    assertContainsAll(body, patterns);
  }
});
