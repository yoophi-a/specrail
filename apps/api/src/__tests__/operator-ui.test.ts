import test from "node:test";
import assert from "node:assert/strict";

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
  operatorUiRunForkPath,
  operatorUiRunReportPath,
  operatorUiRunResumePath,
  operatorUiRunSessionPath,
  operatorUiTrackCreatePath,
  operatorUiTrackUpdatePath,
  renderOperatorUiClientScript,
  renderOperatorUiHtml,
  renderOperatorUiStyleCss,
} from "../operator-ui.js";
import { createHostedUiClientHarness, flushClientPromises } from "./operator-ui-harness.js";

function formatHtmlSnapshot(body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  return compact.length > 4_000 ? `${compact.slice(0, 4_000)}...<truncated>` : compact;
}

function assertContainsAll(body: string, patterns: RegExp[], label: string): void {
  const missingPatterns = patterns.filter((pattern) => !pattern.test(body));
  assert.deepEqual(
    missingPatterns,
    [],
    `${label} missing expected rendered pattern(s): ${missingPatterns.map(String).join(", ")}\nRendered HTML snapshot:\n${formatHtmlSnapshot(body)}`,
  );
}

function formatHarnessCalls(calls: Array<{ method?: string; path?: string; body?: unknown }>): string {
  return (
    calls
      .slice(-20)
      .map((call, index) => `${index}: ${call.method ?? "GET"} ${call.path ?? "<missing>"} body=${JSON.stringify(call.body ?? null)}`)
      .join("\n") || "<none>"
  );
}

function assertCallObserved(
  calls: Array<{ method?: string; path?: string; body?: unknown }>,
  expected: { method: string; path: string },
  label: string,
): void {
  assert.ok(
    calls.some((call) => call.method === expected.method && call.path === expected.path),
    `${label} missing expected call ${expected.method} ${expected.path}.\nObserved calls:\n${formatHarnessCalls(calls)}`,
  );
}

function assertCallNotObserved(
  calls: Array<{ method?: string; path?: string; body?: unknown }>,
  forbidden: { method: string; path: string },
  label: string,
): void {
  assert.ok(
    !calls.some((call) => call.method === forbidden.method && call.path === forbidden.path),
    `${label} observed forbidden call ${forbidden.method} ${forbidden.path}.\nObserved calls:\n${formatHarnessCalls(calls)}`,
  );
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
  assert.equal(operatorUiRunReportPath("run/1"), "/runs/run%2F1/report.md");
  assert.equal(operatorUiRunSessionPath("run/1"), "/runs/run%2F1/session");
  assert.equal(operatorUiRunForkPath("run/1"), "/runs/run%2F1/fork");
});

test("operator UI renderer exposes style and client script helpers", () => {
  const style = renderOperatorUiStyleCss();
  const script = renderOperatorUiClientScript();

  assertContainsAll(
    style,
    [
      /\.detail-grid/,
      /\.artifact-preview/,
      /\.form-grid/,
      /textarea/,
    ],
    "operator UI style helpers",
  );
  assertContainsAll(
    script,
    [
      /async function withAction/,
      /populateProjectForm/,
      /function option/,
      /new EventSource/,
      /workspace-cleanup\/apply/,
    ],
    "operator UI client script helpers",
  );
});

test("operator UI client script stays on in-page controls instead of native dialogs", () => {
  const script = renderOperatorUiClientScript();
  const body = renderOperatorUiHtml();

  assert.doesNotMatch(script, /window\.prompt/);
  assert.doesNotMatch(script, /window\.confirm/);
  assert.match(script, /planning-message-body/);
  assert.match(script, /artifact-proposal-content/);
  assert.match(script, /run-start-prompt/);
  assert.match(script, /run-resume-prompt/);
  assertContainsAll(
    body,
    [
      /id="project-name"/,
      /id="track-title"/,
      /id="track-workflow-status"/,
      /id="run-cancel-confirmation"/,
      /id="cleanup-confirmation"/,
    ],
    "operator UI in-page controls",
  );
});

test("operator UI client harness submits top-level project and track actions", async () => {
  const { calls, createTrack, elements, loadInitialState, scope } = createHostedUiClientHarness();
  await loadInitialState();

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

  assert.deepEqual(calls.find((call) => call.method === "PATCH" && call.path === "/projects/project%2F3")?.body, {
    name: "Project Two Updated",
    repoUrl: null,
    localRepoPath: "/repo/two-updated",
    defaultWorkflowPolicy: null,
    defaultPlanningSystem: "speckit",
  });

  await createTrack({ title: "Track One", description: "Implement track one", priority: "high" });

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks")?.body, {
    projectId: scope.value,
    title: "Track One",
    description: "Implement track one",
    priority: "high",
  });
  assert.equal(elements.get("#track-title")!.value, "");
  assert.equal(elements.get("#track-priority")!.value, "medium");
});

test("operator UI client harness filters tracks by project scope", async () => {
  const { calls, createTrack, elements, loadInitialState, selectProject } = createHostedUiClientHarness({
    projectIds: ["project/1", "project/2"],
  });
  await loadInitialState();

  await selectProject("project/1");
  await createTrack({ title: "Project One Track" });

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks")?.body, {
    projectId: "project/1",
    title: "Project One Track",
    description: "",
    priority: "medium",
  });

  await selectProject("project/2");
  await createTrack({ title: "Project Two Track" });

  assertCallObserved(calls, { method: "GET", path: "/tracks?page=1&pageSize=20&projectId=project%2F1" }, "operator project scope loads");
  assertCallObserved(calls, { method: "GET", path: "/tracks?page=1&pageSize=20&projectId=project%2F2" }, "operator project scope loads");
  assert.equal(elements.get("#tracks")?.children.length, 1);

  await selectProject("");

  assert.equal(calls.at(-2)?.path, "/tracks?page=1&pageSize=20");
  assert.equal(elements.get("#status")?.textContent, "Loaded 2 projects, 2 tracks, and 0 runs.");
});

test("operator UI client harness surfaces top-level refresh failures", async () => {
  const { elements, failPath, loadInitialState } = createHostedUiClientHarness();
  await loadInitialState();

  failPath("/runs?page=1&pageSize=20", "run list unavailable");
  await elements.get("#refresh")!.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "run list unavailable");
  assert.equal(elements.get("#refresh")!.disabled, false);
});

test("operator UI client harness surfaces top-level create failures", async () => {
  const { calls, elements, failPath, loadInitialState, selectProject } = createHostedUiClientHarness({
    projectIds: ["project/1", "project/2"],
  });
  await loadInitialState();

  failPath("/projects", "project create refused", "POST");
  elements.get("#project-name")!.value = "Project Failure";
  elements.get("#project-repo-url")!.value = "https://example.com/failure";
  elements.get("#project-local-repo-path")!.value = "/repo/failure";
  const projectCreateButton = elements.get("#project-create")!;
  await projectCreateButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/projects")?.body, {
    name: "Project Failure",
    repoUrl: "https://example.com/failure",
    localRepoPath: "/repo/failure",
  });
  assert.equal(elements.get("#status")!.textContent, "project create refused");
  assert.equal(projectCreateButton.disabled, false);

  await selectProject("project/1");
  failPath("/tracks", "track create refused", "POST");
  elements.get("#track-title")!.value = "Track Failure";
  elements.get("#track-description")!.value = "Track failure description";
  elements.get("#track-priority")!.value = "high";
  const trackCreateButton = elements.get("#track-create")!;
  await trackCreateButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks")?.body, {
    projectId: "project/1",
    title: "Track Failure",
    description: "Track failure description",
    priority: "high",
  });
  assert.equal(elements.get("#status")!.textContent, "track create refused");
  assert.equal(trackCreateButton.disabled, false);
});

test("operator UI client harness surfaces selected-detail load failures", async () => {
  const { detail, elements, createTrack, failPath, loadInitialState, startRun } = createHostedUiClientHarness();
  await loadInitialState();
  await createTrack({ title: "Failure Detail Track" });

  failPath("/tracks/track-1", "track detail unavailable");
  await elements.get("#tracks")!.children[0]!.click();
  await flushClientPromises();

  assert.equal(detail.className, "muted");
  assert.equal(detail.textContent, "track detail unavailable");

  failPath("/runs/run-1", "run detail unavailable");
  await startRun("Start run before failure check");
  await elements.get("#runs")!.children[0]!.click();
  await flushClientPromises();

  assert.equal(detail.className, "muted");
  assert.equal(detail.textContent, "run detail unavailable");
});

test("operator UI client harness blocks invalid form submissions", async () => {
  const { calls, createTrack, detail, elements, loadInitialState, runs, selectProject } = createHostedUiClientHarness();
  await loadInitialState();

  await elements.get("#project-create")!.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Project name is required.");
  assertCallNotObserved(calls, { method: "POST", path: "/projects" }, "operator invalid project create");

  await elements.get("#track-create")!.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Track title is required.");
  assertCallNotObserved(calls, { method: "POST", path: "/tracks" }, "operator invalid track create");

  const callsBeforeMissingProjectUpdate = calls.length;
  await elements.get("#project-update")!.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Select a project before updating it.");
  assert.equal(calls.length, callsBeforeMissingProjectUpdate);

  await selectProject("project-1");
  elements.get("#project-name")!.value = "";
  const callsBeforeBlankProjectUpdate = calls.length;
  await elements.get("#project-update")!.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Project name is required before updating project-1.");
  assert.equal(calls.length, callsBeforeBlankProjectUpdate);

  await createTrack({ title: "Validation Track" });
  await detail.querySelector("[data-planning-session-create]").click();
  await flushClientPromises();
  const callsBeforeSelectedDetailValidation = calls.length;

  await detail.querySelector("[data-planning-message-append]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Planning message body is required for track-1.");
  assert.equal(calls.length, callsBeforeSelectedDetailValidation);

  detail.querySelector("#run-start-prompt").value = "";
  await detail.querySelector("[data-run-start]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Run start prompt is required for track-1.");
  assertCallNotObserved(calls, { method: "POST", path: "/runs" }, "operator invalid run start");

  detail.querySelector("#artifact-proposal-content").value = "";
  await detail.querySelector("[data-artifact-proposal]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Artifact proposal content is required for spec.");
  assertCallNotObserved(calls, { method: "POST", path: "/tracks/track-1/artifacts/spec" }, "operator invalid artifact proposal");
});

test("operator UI client harness blocks planning messages without a session", async () => {
  const { calls, createTrack, detail, elements, loadInitialState } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Planning Message Validation Track" });
  detail.querySelector("#planning-message-body").value = "Capture this planning note.";
  const callsBeforeAppend = calls.length;
  await detail.querySelector("[data-planning-message-append]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Create a planning session before appending a message for track-1.");
  assert.equal(calls.length, callsBeforeAppend);
  assertCallNotObserved(calls, { method: "POST", path: "/planning-sessions/unknown/messages" }, "operator missing planning session append");
});

test("operator UI client harness preserves empty editable control values", async () => {
  const { createTrack, detail, loadInitialState } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Empty Form Value Track" });

  assert.match(detail.innerHTML, /id="folder-session-path"[^>]*value=""/);
  assert.match(detail.innerHTML, /<textarea id="planning-message-body"><\/textarea>/);
  assert.match(detail.innerHTML, /<textarea id="artifact-proposal-content"><\/textarea>/);
  assert.doesNotMatch(detail.innerHTML, /id="folder-session-path"[^>]*value="unknown"/);
  assert.doesNotMatch(detail.innerHTML, /<textarea id="(?:planning-message-body|artifact-proposal-content)">unknown<\/textarea>/);
});

test("operator UI client harness surfaces failed mutating actions", async () => {
  const { createTrack, detail, elements, failPath, loadInitialState, selectProject } = createHostedUiClientHarness({
    projectIds: ["project/1", "project/2"],
    trackIds: ["track/1"],
  });
  await loadInitialState();

  await selectProject("project/1");
  elements.get("#project-name")!.value = "Project One Update";
  failPath("/projects/project%2F1", "project update refused", "PATCH");
  await elements.get("#project-update")!.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "project update refused");
  assert.equal(elements.get("#project-update")!.disabled, false);

  await createTrack({ title: "Action Failure Track" });
  detail.querySelector("#track-workflow-status").value = "review";
  failPath("/tracks/track%2F1", "track update refused", "PATCH");
  const trackUpdateButton = detail.querySelector("[data-track-update]");
  await trackUpdateButton.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "track update refused");
  assert.equal(trackUpdateButton.disabled, false);
});

test("operator UI client harness submits selected-track detail actions", async () => {
  const { calls, createTrack, detail, loadInitialState, runs, startRun } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Selected Track", description: "Exercise selected-track controls" });

  detail.querySelector("#track-workflow-status").value = "review";
  detail.querySelector("#track-workflow-spec-status").value = "approved";
  detail.querySelector("#track-workflow-plan-status").value = "pending";
  await detail.querySelector("[data-track-update]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "PATCH" && call.path === "/tracks/track-1")?.body, {
    status: "review",
    specStatus: "approved",
    planStatus: "pending",
  });

  detail.querySelector("#planning-session-status").value = "waiting_agent";
  await detail.querySelector("[data-planning-session-create]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks/track-1/planning-sessions")?.body, {
    status: "waiting_agent",
  });

  detail.querySelector("#planning-message-author").value = "agent";
  detail.querySelector("#planning-message-kind").value = "decision";
  detail.querySelector("#planning-message-artifact").value = "spec";
  detail.querySelector("#planning-message-body").value = "Proceed with the selected plan.";
  await detail.querySelector("[data-planning-message-append]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/planning-sessions/planning-1/messages")?.body, {
    authorType: "agent",
    kind: "decision",
    body: "Proceed with the selected plan.",
    relatedArtifact: "spec",
  });

  detail.querySelector("#artifact-proposal-kind").value = "plan";
  detail.querySelector("#artifact-proposal-summary").value = "Plan update";
  detail.querySelector("#artifact-proposal-content").value = "Updated plan content";
  await detail.querySelector("[data-artifact-proposal]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks/track-1/artifacts/plan")?.body, {
    content: "Updated plan content",
    summary: "Plan update",
    createdBy: "user",
  });

  const [approveButton] = detail.querySelectorAll("[data-approval-id]");
  await approveButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/approval-requests/approval-spec-1/approve")?.body, {
    decidedBy: "user",
    comment: "decided from hosted operator UI",
  });

  const [, , , rejectButton] = detail.querySelectorAll("[data-approval-id]");
  await rejectButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/approval-requests/approval-plan-1/reject")?.body, {
    decidedBy: "user",
    comment: "decided from hosted operator UI",
  });

  runs.push({ id: "run-existing", trackId: "track-1", status: "running", workspacePath: "/workspace/run-existing/app", backend: "codex", continuityMode: "fresh", summary: { lastEventSummary: "Existing folder work" } });
  detail.querySelector("#folder-session-path").value = "/workspace/run-existing";
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();

  assertCallObserved(
    calls,
    { method: "GET", path: "/runs?page=1&pageSize=10&workspacePath=%2Fworkspace%2Frun-existing" },
    "operator folder-session search",
  );
  assert.match(detail.querySelector("#folder-session-results").innerHTML, /data-folder-run-preview/);

  await detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview]")[0]?.click();
  await flushClientPromises();

  assertCallObserved(calls, { method: "GET", path: "/runs/run-existing/session-preview?eventLimit=5" }, "operator folder-session preview");
  const previewPanel = detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview-panel]")[0];
  assert.match(previewPanel?.innerHTML ?? "", /<strong>Workspace:<\/strong> \/workspace\/run-existing\/app/);
  assert.match(previewPanel?.innerHTML ?? "", /<a href="\/runs\/run-existing\/report\.md">\/runs\/run-existing\/report\.md<\/a>/);
  assert.match(previewPanel?.innerHTML ?? "", /contextCopyFork=true/);

  await startRun("Implement selected track now.");

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs")?.body, {
    trackId: "track-1",
    prompt: "Implement selected track now.",
  });
});

test("operator UI client harness encodes opaque selected-track action paths", async () => {
  const { calls, createTrack, detail, loadInitialState } = createHostedUiClientHarness({
    trackIds: ["track/opaque"],
    planningSessionIds: ["planning/session-1"],
    artifactApprovalRequests: {
      spec: [{ id: "approval/spec-1", status: "pending" }],
      plan: [],
      tasks: [],
    },
  });
  await loadInitialState();

  await createTrack({ title: "Opaque Selected Track", description: "Exercise opaque selected-track controls" });

  detail.querySelector("#track-workflow-status").value = "review";
  detail.querySelector("#track-workflow-spec-status").value = "approved";
  detail.querySelector("#track-workflow-plan-status").value = "pending";
  await detail.querySelector("[data-track-update]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "PATCH" && call.path === "/tracks/track%2Fopaque")?.body, {
    status: "review",
    specStatus: "approved",
    planStatus: "pending",
  });

  detail.querySelector("#planning-session-status").value = "waiting_agent";
  await detail.querySelector("[data-planning-session-create]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks/track%2Fopaque/planning-sessions")?.body, {
    status: "waiting_agent",
  });

  detail.querySelector("#planning-message-author").value = "agent";
  detail.querySelector("#planning-message-kind").value = "decision";
  detail.querySelector("#planning-message-artifact").value = "spec";
  detail.querySelector("#planning-message-body").value = "Proceed with opaque planning context.";
  await detail.querySelector("[data-planning-message-append]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/planning-sessions/planning%2Fsession-1/messages")?.body, {
    authorType: "agent",
    kind: "decision",
    body: "Proceed with opaque planning context.",
    relatedArtifact: "spec",
  });

  detail.querySelector("#artifact-proposal-kind").value = "spec";
  detail.querySelector("#artifact-proposal-summary").value = "Spec update";
  detail.querySelector("#artifact-proposal-content").value = "Updated spec content";
  await detail.querySelector("[data-artifact-proposal]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks/track%2Fopaque/artifacts/spec")?.body, {
    content: "Updated spec content",
    summary: "Spec update",
    createdBy: "user",
  });

  const [approveButton] = detail.querySelectorAll("[data-approval-id]");
  await approveButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/approval-requests/approval%2Fspec-1/approve")?.body, {
    decidedBy: "user",
    comment: "decided from hosted operator UI",
  });
});

test("operator UI client harness surfaces selected-track run start failures", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState } = createHostedUiClientHarness({
    trackIds: ["track/run-start"],
  });
  await loadInitialState();

  await createTrack({ title: "Run Start Failure Track" });

  failPath("/runs", "run start refused", "POST");
  detail.querySelector("#run-start-prompt").value = "Start opaque track.";
  const runStartButton = detail.querySelector("[data-run-start]");
  await runStartButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs")?.body, {
    trackId: "track/run-start",
    prompt: "Start opaque track.",
  });
  assert.equal(elements.get("#status")!.textContent, "run start refused");
  assert.equal(runStartButton.disabled, false);
});

test("operator UI client harness surfaces selected-track detail action failures", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState } = createHostedUiClientHarness({
    trackIds: ["track/detail-failure"],
    planningSessionIds: ["planning/detail-failure"],
    artifactApprovalRequests: {
      spec: [{ id: "approval/detail-failure", status: "pending" }],
      plan: [],
      tasks: [],
    },
  });
  await loadInitialState();

  await createTrack({ title: "Detail Failure Track" });

  await detail.querySelector("[data-planning-session-create]").click();
  await flushClientPromises();

  failPath("/planning-sessions/planning%2Fdetail-failure/messages", "planning message refused", "POST");
  detail.querySelector("#planning-message-body").value = "Append failure path.";
  const planningMessageButton = detail.querySelector("[data-planning-message-append]");
  await planningMessageButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/planning-sessions/planning%2Fdetail-failure/messages")?.body, {
    authorType: "user",
    kind: "message",
    body: "Append failure path.",
  });
  assert.equal(elements.get("#status")!.textContent, "planning message refused");
  assert.equal(planningMessageButton.disabled, false);

  failPath("/tracks/track%2Fdetail-failure/artifacts/spec", "artifact proposal refused", "POST");
  detail.querySelector("#artifact-proposal-kind").value = "spec";
  detail.querySelector("#artifact-proposal-summary").value = "Failure proposal";
  detail.querySelector("#artifact-proposal-content").value = "Artifact failure path.";
  const artifactProposalButton = detail.querySelector("[data-artifact-proposal]");
  await artifactProposalButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks/track%2Fdetail-failure/artifacts/spec")?.body, {
    content: "Artifact failure path.",
    summary: "Failure proposal",
    createdBy: "user",
  });
  assert.equal(elements.get("#status")!.textContent, "artifact proposal refused");
  assert.equal(artifactProposalButton.disabled, false);

  failPath("/approval-requests/approval%2Fdetail-failure/approve", "approval decision refused", "POST");
  const [approvalButton] = detail.querySelectorAll("[data-approval-id]");
  await approvalButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/approval-requests/approval%2Fdetail-failure/approve")?.body, {
    decidedBy: "user",
    comment: "decided from hosted operator UI",
  });
  assert.equal(elements.get("#status")!.textContent, "approval decision refused");
  assert.equal(approvalButton.disabled, false);
});

test("operator UI client harness surfaces planning-session create failures", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState } = createHostedUiClientHarness({
    trackIds: ["track/planning-create"],
  });
  await loadInitialState();

  await createTrack({ title: "Planning Create Failure Track" });

  failPath("/tracks/track%2Fplanning-create/planning-sessions", "planning session create refused", "POST");
  detail.querySelector("#planning-session-status").value = "waiting_agent";
  const planningSessionButton = detail.querySelector("[data-planning-session-create]");
  await planningSessionButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks/track%2Fplanning-create/planning-sessions")?.body, {
    status: "waiting_agent",
  });
  assert.equal(elements.get("#status")!.textContent, "planning session create refused");
  assert.equal(planningSessionButton.disabled, false);
});

test("operator UI client harness renders unsafe folder-session report paths as text", async () => {
  const { createTrack, detail, loadInitialState, runs, setSessionPreviewReportPath } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Unsafe Report Link Track" });
  runs.push({ id: "run-unsafe", trackId: "track-1", status: "completed", workspacePath: "/workspace/run-unsafe" });
  setSessionPreviewReportPath("run-unsafe", "javascript:alert(1)");

  detail.querySelector("#folder-session-path").value = "/workspace/run-unsafe";
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();
  await detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview]")[0]?.click();
  await flushClientPromises();

  const previewPanel = detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview-panel]")[0];
  assert.doesNotMatch(previewPanel?.innerHTML ?? "", /<a href=/);
  assert.match(previewPanel?.innerHTML ?? "", /javascript:alert\(1\)/);
});

test("operator UI client harness blocks blank folder-session searches", async () => {
  const { calls, createTrack, detail, elements, loadInitialState } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Folder Search Validation Track" });
  detail.querySelector("#folder-session-path").value = "   ";
  const callsBeforeSearch = calls.length;
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();

  assert.equal(calls.length, callsBeforeSearch);
  assert.equal(elements.get("#status")!.textContent, "Folder path is required before previewing sessions for track-1.");
  assert.match(detail.querySelector("#folder-session-results").innerHTML, /Select or enter a folder path before looking up related sessions\./);
});

test("operator UI client harness surfaces folder-session search failures", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Folder Search Failure Track" });
  const searchButton = detail.querySelector("[data-folder-session-search]");
  detail.querySelector("#folder-session-path").value = "/workspace/search-failure";
  failPath("/runs?page=1&pageSize=10&workspacePath=%2Fworkspace%2Fsearch-failure", "folder session search refused");
  await searchButton.click();
  await flushClientPromises();

  assertCallObserved(
    calls,
    { method: "GET", path: "/runs?page=1&pageSize=10&workspacePath=%2Fworkspace%2Fsearch-failure" },
    "operator folder-session search failure",
  );
  assert.equal(elements.get("#status")!.textContent, "folder session search refused");
  assert.equal(searchButton.disabled, false);
});

test("operator UI client harness encodes opaque folder-session preview and resume paths", async () => {
  const { calls, createTrack, detail, eventSources, loadInitialState, runs } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Opaque Folder Session Track" });
  runs.push({ id: "run/folder", trackId: "track-1", status: "running", workspacePath: "/workspace/run-folder/app", backend: "codex", continuityMode: "fresh", summary: { lastEventSummary: "Opaque folder work" } });

  detail.querySelector("#folder-session-path").value = "/workspace/run-folder";
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();

  assertCallObserved(
    calls,
    { method: "GET", path: "/runs?page=1&pageSize=10&workspacePath=%2Fworkspace%2Frun-folder" },
    "operator folder-session search",
  );

  await detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview]")[0]?.click();
  await flushClientPromises();

  assertCallObserved(calls, { method: "GET", path: "/runs/run%2Ffolder/session-preview?eventLimit=5" }, "operator folder-session preview");
  const previewPanel = detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview-panel]")[0];
  assert.match(previewPanel?.innerHTML ?? "", /<a href="\/runs\/run%2Ffolder\/report\.md">\/runs\/run%2Ffolder\/report\.md<\/a>/);

  detail.querySelector("#run-start-prompt").value = "Resume opaque folder session.";
  await detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-resume]")[0]?.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffolder/resume")?.body, {
    prompt: "Resume opaque folder session.",
  });
  assert.equal(eventSources.at(-1)?.url, "/runs/run%2Ffolder/events/stream");
});

test("operator UI client harness surfaces folder-session preview failures", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState, runs } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Folder Preview Failure Track" });
  runs.push({ id: "run/preview-failure", trackId: "track-1", status: "running", workspacePath: "/workspace/run-preview-failure/app", backend: "codex", continuityMode: "fresh" });

  detail.querySelector("#folder-session-path").value = "/workspace/run-preview-failure";
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();

  failPath("/runs/run%2Fpreview-failure/session-preview?eventLimit=5", "session preview refused");
  const previewButton = detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-preview]")[0]!;
  await previewButton.click();
  await flushClientPromises();

  assertCallObserved(
    calls,
    { method: "GET", path: "/runs/run%2Fpreview-failure/session-preview?eventLimit=5" },
    "operator folder-session preview failure",
  );
  assert.equal(elements.get("#status")!.textContent, "session preview refused");
  assert.equal(previewButton.disabled, false);
});

test("operator UI client harness surfaces folder-session action failures", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState, runs } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Folder Action Failure Track" });
  runs.push({ id: "run/folder-failure", trackId: "track-1", status: "running", workspacePath: "/workspace/run-folder-failure/app", backend: "codex", continuityMode: "fresh" });

  detail.querySelector("#folder-session-path").value = "/workspace/run-folder-failure";
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();

  failPath("/runs/run%2Ffolder-failure/resume", "folder resume refused", "POST");
  detail.querySelector("#run-start-prompt").value = "Resume folder failure.";
  const resumeButton = detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-resume]")[0]!;
  await resumeButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffolder-failure/resume")?.body, {
    prompt: "Resume folder failure.",
  });
  assert.equal(elements.get("#status")!.textContent, "folder resume refused");
  assert.equal(resumeButton.disabled, false);

  failPath("/runs/run%2Ffolder-failure/fork", "folder fork refused", "POST");
  detail.querySelector("#run-start-prompt").value = "Fork folder failure.";
  const forkButton = detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-fork]")[0]!;
  await forkButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffolder-failure/fork")?.body, {
    prompt: "Fork folder failure.",
  });
  assert.equal(elements.get("#status")!.textContent, "folder fork refused");
  assert.equal(forkButton.disabled, false);
});

test("operator UI client harness encodes opaque folder-session fork paths", async () => {
  const { calls, createTrack, detail, eventSources, loadInitialState, runs } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Opaque Folder Fork Track" });
  runs.push({ id: "run/fork-source", trackId: "track-1", status: "completed", workspacePath: "/workspace/run-fork-source/app", backend: "codex", continuityMode: "fresh", summary: { lastEventSummary: "Ready to fork" } });

  detail.querySelector("#folder-session-path").value = "/workspace/run-fork-source";
  await detail.querySelector("[data-folder-session-search]").click();
  await flushClientPromises();

  detail.querySelector("#run-start-prompt").value = "Fork opaque folder session.";
  await detail.querySelector("#folder-session-results").querySelectorAll("[data-folder-run-fork]")[0]?.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffork-source/fork")?.body, {
    prompt: "Fork opaque folder session.",
  });
  assert.equal(eventSources.at(-1)?.url, "/runs/run-1/events/stream");
});

test("operator UI client harness submits selected-run detail actions", async () => {
  const { calls, createTrack, detail, elements, eventSources, loadInitialState, requestCleanupConfirmation, requestCleanupPreview, startRun } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Run Harness Track", description: "Create a run for selected-run controls" });
  await startRun("Start run for harness.");

  assert.equal(eventSources.at(-1)?.url, "/runs/run-1/events/stream");

  eventSources.at(-1)?.emit("execution-event", { type: "log", summary: "streamed event", timestamp: "2026-01-01T00:00:00.000Z" });

  assert.equal(detail.querySelector("#run-events").children.length, 1);
  assert.equal(elements.get("#status")?.textContent, "Live event received for run-1.");

  detail.querySelector("#run-resume-prompt").value = "Resume with verification.";
  await detail.querySelector("[data-run-resume]").click();
  await flushClientPromises();

  assert.equal(eventSources[0]?.closed, true);
  assert.equal(eventSources.at(-1)?.url, "/runs/run-1/events/stream");

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run-1/resume")?.body, {
    prompt: "Resume with verification.",
  });

  detail.querySelector("#run-cancel-confirmation").value = "cancel";
  await detail.querySelector("[data-run-cancel]").click();
  await flushClientPromises();

  assert.equal(eventSources.at(-2)?.closed, true);
  assert.equal(eventSources.at(-1)?.url, "/runs/run-1/events/stream");

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run-1/cancel")?.body, {});

  eventSources.at(-1)?.fail();

  assert.equal(eventSources.at(-1)?.closed, true);
  assert.equal(elements.get("#status")?.textContent, "Live event stream disconnected for run-1; recent events remain visible.");

  await requestCleanupPreview();

  assertCallObserved(calls, { method: "GET", path: "/runs/run-1/workspace-cleanup/preview" }, "operator cleanup preview");

  await requestCleanupConfirmation();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run-1/workspace-cleanup/apply" && (call.body as { confirm?: string }).confirm === "")?.body, {
    confirm: "",
  });
  assert.equal(detail.querySelector("#cleanup-expected-confirmation").textContent, "APPLY CLEANUP run-1");
  assert.equal(detail.querySelector("#cleanup-confirm-panel").hidden, false);

  detail.querySelector("#cleanup-confirmation").value = "APPLY CLEANUP run-1";
  await detail.querySelector("[data-cleanup-apply]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run-1/workspace-cleanup/apply" && (call.body as { confirm?: string }).confirm === "APPLY CLEANUP run-1")?.body, {
    confirm: "APPLY CLEANUP run-1",
  });
});

test("operator UI client harness encodes opaque selected-run action paths", async () => {
  const { calls, detail, eventSources, loadInitialState, requestCleanupConfirmation, requestCleanupPreview } = createHostedUiClientHarness({
    search: "?runId=run%2Fopaque",
  });
  await loadInitialState();
  await flushClientPromises();

  assertCallObserved(calls, { method: "GET", path: "/runs/run%2Fopaque" }, "operator opaque run detail");
  assertCallObserved(calls, { method: "GET", path: "/runs/run%2Fopaque/events" }, "operator opaque run events");
  assert.equal(eventSources.at(-1)?.url, "/runs/run%2Fopaque/events/stream");

  detail.querySelector("#run-resume-prompt").value = "Resume opaque run.";
  await detail.querySelector("[data-run-resume]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Fopaque/resume")?.body, {
    prompt: "Resume opaque run.",
  });
  assert.equal(eventSources.at(-1)?.url, "/runs/run%2Fopaque/events/stream");

  detail.querySelector("#run-cancel-confirmation").value = "cancel";
  await detail.querySelector("[data-run-cancel]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Fopaque/cancel")?.body, {});

  await requestCleanupPreview();

  assertCallObserved(calls, { method: "GET", path: "/runs/run%2Fopaque/workspace-cleanup/preview" }, "operator opaque cleanup preview");

  await requestCleanupConfirmation();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Fopaque/workspace-cleanup/apply" && (call.body as { confirm?: string }).confirm === "")?.body, {
    confirm: "",
  });
  assert.equal(detail.querySelector("#cleanup-expected-confirmation").textContent, "APPLY CLEANUP run/opaque");

  detail.querySelector("#cleanup-confirmation").value = "APPLY CLEANUP run/opaque";
  await detail.querySelector("[data-cleanup-apply]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Fopaque/workspace-cleanup/apply" && (call.body as { confirm?: string }).confirm === "APPLY CLEANUP run/opaque")?.body, {
    confirm: "APPLY CLEANUP run/opaque",
  });

  detail.querySelector("#run-fork-prompt").value = "Fork opaque run.";
  await detail.querySelector("[data-run-fork]").click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Fopaque/fork")?.body, {
    prompt: "Fork opaque run.",
  });
  assert.equal(eventSources.at(-1)?.url, "/runs/run-1/events/stream");
});

test("operator UI client harness surfaces selected-run lifecycle failures", async () => {
  const { calls, detail, elements, failPath, loadInitialState } = createHostedUiClientHarness({
    search: "?runId=run%2Ffailure",
  });
  await loadInitialState();
  await flushClientPromises();

  failPath("/runs/run%2Ffailure/resume", "resume refused", "POST");
  detail.querySelector("#run-resume-prompt").value = "Resume failure path.";
  const resumeButton = detail.querySelector("[data-run-resume]");
  await resumeButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffailure/resume")?.body, {
    prompt: "Resume failure path.",
  });
  assert.equal(elements.get("#status")!.textContent, "resume refused");
  assert.equal(resumeButton.disabled, false);

  failPath("/runs/run%2Ffailure/fork", "fork refused", "POST");
  detail.querySelector("#run-fork-prompt").value = "Fork failure path.";
  const forkButton = detail.querySelector("[data-run-fork]");
  await forkButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffailure/fork")?.body, {
    prompt: "Fork failure path.",
  });
  assert.equal(elements.get("#status")!.textContent, "fork refused");
  assert.equal(forkButton.disabled, false);

  failPath("/runs/run%2Ffailure/cancel", "cancel refused", "POST");
  detail.querySelector("#run-cancel-confirmation").value = "cancel";
  const cancelButton = detail.querySelector("[data-run-cancel]");
  await cancelButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run%2Ffailure/cancel")?.body, {});
  assert.equal(elements.get("#status")!.textContent, "cancel refused");
  assert.equal(cancelButton.disabled, false);
});

test("operator UI client harness blocks invalid run lifecycle submissions", async () => {
  const { calls, createTrack, detail, elements, loadInitialState, startRun } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Run Lifecycle Validation Track" });
  await startRun("Start run before lifecycle validation.");

  detail.querySelector("#run-resume-prompt").value = "   ";
  await detail.querySelector("[data-run-resume]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Run resume prompt is required for run-1.");
  assertCallNotObserved(calls, { method: "POST", path: "/runs/run-1/resume" }, "operator invalid run resume");

  detail.querySelector("#run-fork-prompt").value = "   ";
  await detail.querySelector("[data-run-fork]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Run fork prompt is required for run-1.");
  assertCallNotObserved(calls, { method: "POST", path: "/runs/run-1/fork" }, "operator invalid run fork");

  detail.querySelector("#run-cancel-confirmation").value = "nope";
  await detail.querySelector("[data-run-cancel]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Type cancel before cancelling run run-1.");
  assertCallNotObserved(calls, { method: "POST", path: "/runs/run-1/cancel" }, "operator invalid run cancel");
});

test("operator UI client harness blocks blank cleanup confirmation", async () => {
  const { calls, createTrack, detail, elements, loadInitialState, requestCleanupConfirmation, requestCleanupPreview, startRun } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Cleanup Validation Track" });
  await startRun("Start run before cleanup validation.");
  await requestCleanupPreview();
  await requestCleanupConfirmation();

  const cleanupApplyCallsBeforeValidation = calls.filter((call) => call.method === "POST" && call.path === "/runs/run-1/workspace-cleanup/apply");

  detail.querySelector("#cleanup-confirmation").value = "   ";
  await detail.querySelector("[data-cleanup-apply]").click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "Cleanup confirmation phrase is required for run-1.");
  assert.deepEqual(calls.filter((call) => call.method === "POST" && call.path === "/runs/run-1/workspace-cleanup/apply"), cleanupApplyCallsBeforeValidation);
});

test("operator UI client harness surfaces cleanup failure states", async () => {
  const { createTrack, detail, elements, failPath, loadInitialState, requestCleanupPreview, startRun } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Cleanup Failure Track" });
  await startRun("Start run before cleanup failure checks.");

  failPath("/runs/run-1/workspace-cleanup/preview", "cleanup preview refused");
  const previewButton = detail.querySelector("[data-cleanup-preview]");
  await requestCleanupPreview();

  assert.equal(elements.get("#status")!.textContent, "Cleanup preview unavailable for run-1: cleanup preview refused");
  assert.match(detail.innerHTML, /cleanup preview refused/);
  assert.equal(previewButton.disabled, false);

  failPath("/runs/run-1/workspace-cleanup/apply", "cleanup confirmation refused", "POST");
  const requestButton = detail.querySelector("[data-cleanup-request]");
  await requestButton.click();
  await flushClientPromises();

  assert.equal(elements.get("#status")!.textContent, "cleanup confirmation refused");
  assert.equal(requestButton.disabled, false);
});

test("operator UI client harness preserves cleanup apply results when refresh fails", async () => {
  const { calls, createTrack, detail, elements, failPath, loadInitialState, requestCleanupConfirmation, requestCleanupPreview, startRun } = createHostedUiClientHarness();
  await loadInitialState();

  await createTrack({ title: "Cleanup Refresh Failure Track" });
  await startRun("Start run before cleanup refresh failure.");
  await requestCleanupPreview();
  await requestCleanupConfirmation();

  detail.querySelector("#cleanup-confirmation").value = "APPLY CLEANUP run-1";
  failPath("/runs/run-1", "run refresh refused");
  const cleanupApplyButton = detail.querySelector("[data-cleanup-apply]");
  await cleanupApplyButton.click();
  await flushClientPromises();

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs/run-1/workspace-cleanup/apply" && (call.body as { confirm?: string }).confirm === "APPLY CLEANUP run-1")?.body, {
    confirm: "APPLY CLEANUP run-1",
  });
  assert.equal(elements.get("#status")!.textContent, "Workspace cleanup completed for run-1. Refresh failed: run refresh refused");
  assert.equal(cleanupApplyButton.disabled, false);
});

test("operator UI shell keeps hosted action and stream wiring", () => {
  const body = renderOperatorUiHtml();

  const controlGroups = {
    shell: [/SpecRail Operator/, /<style>\n/, /<script type="module">\n/, /\.artifact-preview/, /\.pk-prompt-input/, /\.pk-tool/, /\.pk-system-message/],
    project: [/data-control-group="project-form"/, /id="project-create"/, /id="project-update"/, /id="project-name"/, /id="project-repo-url"/, /method: 'PATCH'/, /defaultWorkflowPolicy/, /defaultPlanningSystem/, /optionalNullableInputValue/],
    track: [/data-control-group="track-form"/, /id="track-create"/, /id="track-title"/, /id="track-priority"/, /data-track-update/, /data-control-group="track-workflow"/, /id="track-workflow-status"/, /id="track-workflow-spec-status"/],
    planning: [/data-control-group="track-planning"/, /data-planning-session-create/, /id="planning-session-status"/, /data-planning-message-append/, /planning-message-body/, /id="planning-message-author"/],
    artifacts: [/data-approval-id/, /data-control-group="artifact-proposal"/, /data-artifact-proposal/, /id="artifact-proposal-kind"/, /artifact-proposal-content/, /Propose artifact/, /createdBy: 'user'/],
    runs: [/data-control-group="track-run-start"/, /folder-session-path/, /data-folder-session-search/, /data-run-start/, /run-start-prompt/, /data-control-group="run-lifecycle"/, /data-run-resume/, /run-resume-prompt/, /data-run-fork/, /run-fork-prompt/, /id="run-cancel-confirmation"/, /data-run-cancel/],
    cleanup: [/workspace-cleanup\/preview/, /data-cleanup-request/, /data-control-group="cleanup-confirmation"/, /id="cleanup-confirmation"/, /workspace-cleanup\/apply/, /Refresh failed:/],
    streamsAndActions: [/new EventSource/, /events\/stream/, /async function withAction/, /function errorMessage/, /button.disabled = true/, /button.isConnected/, /function renderRunEventCard/, /function promptInput/, /function renderPlanningContextMessages/],
  };

  for (const [group, patterns] of Object.entries(controlGroups)) {
    assertContainsAll(body, patterns, `operator UI ${group} wiring`);
  }
});

test("operator UI client opens run detail from runId query parameter", async () => {
  const { calls, detail, loadInitialState } = createHostedUiClientHarness({ search: "?runId=run%2Flinked" });
  await loadInitialState();
  await flushClientPromises();

  assertCallObserved(calls, { method: "GET", path: "/runs/run%2Flinked" }, "operator linked run detail");
  assertCallObserved(calls, { method: "GET", path: "/runs/run%2Flinked/events" }, "operator linked run events");
  assert.match(detail.innerHTML, /Run run\/linked/);
});
