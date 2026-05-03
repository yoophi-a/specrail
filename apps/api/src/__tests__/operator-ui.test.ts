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

test("operator UI shell keeps hosted action and stream wiring", () => {
  const body = renderOperatorUiHtml();

  assert.match(body, /SpecRail Operator/);
  assert.match(body, /<style>\n/);
  assert.match(body, /<script type="module">\n/);
  assert.match(body, /id="project-create"/);
  assert.match(body, /id="project-update"/);
  assert.match(body, /id="track-create"/);
  assert.match(body, /id="project-name"/);
  assert.match(body, /id="project-repo-url"/);
  assert.match(body, /id="track-title"/);
  assert.match(body, /id="track-priority"/);
  assert.match(body, /data-track-update/);
  assert.match(body, /id="track-workflow-status"/);
  assert.match(body, /id="track-workflow-spec-status"/);
  assert.match(body, /data-planning-session-create/);
  assert.match(body, /id="planning-session-status"/);
  assert.match(body, /data-planning-message-append/);
  assert.match(body, /id="planning-message-body"/);
  assert.match(body, /id="planning-message-author"/);
  assert.match(body, /method: 'PATCH'/);
  assert.match(body, /defaultWorkflowPolicy/);
  assert.match(body, /defaultPlanningSystem/);
  assert.match(body, /optionalNullableInputValue/);
  assert.match(body, /data-approval-id/);
  assert.match(body, /data-artifact-proposal/);
  assert.match(body, /id="artifact-proposal-kind"/);
  assert.match(body, /id="artifact-proposal-content"/);
  assert.match(body, /Propose artifact/);
  assert.match(body, /createdBy: 'user'/);
  assert.match(body, /data-run-start/);
  assert.match(body, /id="run-start-prompt"/);
  assert.match(body, /data-run-resume/);
  assert.match(body, /id="run-resume-prompt"/);
  assert.match(body, /id="run-cancel-confirmation"/);
  assert.match(body, /data-run-cancel/);
  assert.match(body, /workspace-cleanup\/preview/);
  assert.match(body, /data-cleanup-request/);
  assert.match(body, /id="cleanup-confirmation"/);
  assert.match(body, /workspace-cleanup\/apply/);
  assert.match(body, /new EventSource/);
  assert.match(body, /\.artifact-preview/);
  assert.match(body, /events\/stream/);
  assert.match(body, /async function withAction/);
  assert.match(body, /function errorMessage/);
  assert.match(body, /button.disabled = true/);
  assert.match(body, /button.isConnected/);
  assert.match(body, /Refresh failed:/);
});
