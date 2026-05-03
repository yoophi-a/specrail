import test from "node:test";
import assert from "node:assert/strict";

import {
  operatorUiApprovalDecisionPath,
  operatorUiCleanupApplyPath,
  operatorUiCleanupPreviewPath,
  operatorUiEscapeHtml,
  operatorUiMetadataHtml,
  operatorUiPreviewHtml,
  operatorUiRunCancelPath,
  operatorUiRunCreatePath,
  operatorUiRunEventStreamPath,
  operatorUiRunResumePath,
  renderOperatorUiHtml,
} from "../operator-ui.js";

test("operator UI helpers escape metadata and previews", () => {
  assert.equal(operatorUiEscapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(operatorUiMetadataHtml([["Run", "run-1"], ["Missing", undefined]]), "<dl><dt>Run</dt><dd>run-1</dd><dt>Missing</dt><dd>unknown</dd></dl>");
  assert.equal(operatorUiPreviewHtml("Spec", "hello <world>"), '<h3>Spec</h3><div class="artifact-preview">hello &lt;world&gt;</div>');
  assert.equal(operatorUiPreviewHtml("Empty", ""), "");
});

test("operator UI helpers build encoded action URLs", () => {
  assert.equal(operatorUiApprovalDecisionPath("approval/request 1", "approve"), "/approval-requests/approval%2Frequest%201/approve");
  assert.equal(operatorUiRunCreatePath(), "/runs");
  assert.equal(operatorUiRunResumePath("run/1"), "/runs/run%2F1/resume");
  assert.equal(operatorUiRunCancelPath("run/1"), "/runs/run%2F1/cancel");
  assert.equal(operatorUiCleanupPreviewPath("run/1"), "/runs/run%2F1/workspace-cleanup/preview");
  assert.equal(operatorUiCleanupApplyPath("run/1"), "/runs/run%2F1/workspace-cleanup/apply");
  assert.equal(operatorUiRunEventStreamPath("run/1"), "/runs/run%2F1/events/stream");
});

test("operator UI shell keeps hosted action and stream wiring", () => {
  const body = renderOperatorUiHtml();

  assert.match(body, /SpecRail Operator/);
  assert.match(body, /data-approval-id/);
  assert.match(body, /data-run-start/);
  assert.match(body, /data-run-resume/);
  assert.match(body, /data-run-cancel/);
  assert.match(body, /workspace-cleanup\/preview/);
  assert.match(body, /workspace-cleanup\/apply/);
  assert.match(body, /new EventSource/);
  assert.match(body, /events\/stream/);
  assert.match(body, /button.disabled = true/);
});
