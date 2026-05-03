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
