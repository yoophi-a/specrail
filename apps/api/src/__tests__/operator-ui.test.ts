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
  operatorUiRunResumePath,
  operatorUiTrackCreatePath,
  operatorUiTrackUpdatePath,
  renderOperatorUiClientScript,
  renderOperatorUiHtml,
  renderOperatorUiStyleCss,
} from "../operator-ui.js";
import { createHostedUiClientHarness, flushClientPromises } from "./operator-ui-harness.js";

function assertContainsAll(body: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(body, pattern);
  }
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

  assert.deepEqual(calls.find((call) => call.method === "PATCH" && call.path === "/projects/project-3")?.body, {
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
  const { calls, createTrack, elements, loadInitialState, selectProject } = createHostedUiClientHarness();
  await loadInitialState();

  await selectProject("project-1");
  await createTrack({ title: "Project One Track" });

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/tracks")?.body, {
    projectId: "project-1",
    title: "Project One Track",
    description: "",
    priority: "medium",
  });

  await selectProject("project-2");
  await createTrack({ title: "Project Two Track" });

  const scopedTrackLoads = calls.filter((call) => call.method === "GET" && call.path.startsWith("/tracks?page=1&pageSize=20"));
  assert.ok(scopedTrackLoads.some((call) => call.path === "/tracks?page=1&pageSize=20&projectId=project-1"));
  assert.ok(scopedTrackLoads.some((call) => call.path === "/tracks?page=1&pageSize=20&projectId=project-2"));
  assert.equal(elements.get("#tracks")?.children.length, 1);

  await selectProject("");

  assert.equal(calls.at(-2)?.path, "/tracks?page=1&pageSize=20");
  assert.equal(elements.get("#status")?.textContent, "Loaded 2 projects, 2 tracks, and 0 runs.");
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

test("operator UI client harness submits selected-track detail actions", async () => {
  const { calls, createTrack, detail, loadInitialState, startRun } = createHostedUiClientHarness();
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

  await startRun("Implement selected track now.");

  assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/runs")?.body, {
    trackId: "track-1",
    prompt: "Implement selected track now.",
  });
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

  assert.equal(calls.some((call) => call.method === "GET" && call.path === "/runs/run-1/workspace-cleanup/preview"), true);

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
