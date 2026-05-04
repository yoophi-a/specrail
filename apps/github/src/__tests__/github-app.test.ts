import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGitHubSignature256,
  handleGitHubWebhookCommand,
  parseSpecRailIssueCommentCommand,
  verifyGitHubSignature256,
} from "../index.js";

const secret = "webhook-secret";
const rawBody = JSON.stringify({ action: "created" });
const signatureHeader = buildGitHubSignature256(secret, rawBody);

function payload(body: string) {
  return {
    action: "created",
    comment: { body },
    issue: { number: 123, title: "Implement GitHub entrypoint" },
    repository: { full_name: "yoophi-a/specrail" },
    sender: { login: "octocat", id: 42 },
  };
}

test("verifyGitHubSignature256 validates HMAC SHA-256 webhook signatures", () => {
  assert.equal(verifyGitHubSignature256({ secret, payload: rawBody, signatureHeader }), true);
  assert.equal(verifyGitHubSignature256({ secret, payload: rawBody, signatureHeader: "sha256=bad" }), false);
  assert.equal(verifyGitHubSignature256({ secret, payload: rawBody }), false);
});

test("parseSpecRailIssueCommentCommand extracts optional run prompts", () => {
  assert.deepEqual(parseSpecRailIssueCommentCommand("/specrail run"), { kind: "run" });
  assert.deepEqual(parseSpecRailIssueCommentCommand(" /specrail run keep opaque #123 text "), {
    kind: "run",
    prompt: "keep opaque #123 text",
  });
  assert.equal(parseSpecRailIssueCommentCommand("/specrail status"), undefined);
});

test("handleGitHubWebhookCommand accepts issue-comment created run commands", () => {
  const result = handleGitHubWebhookCommand({
    eventName: "issue_comment",
    signatureHeader,
    secret,
    rawBody,
    payload: payload("/specrail run ship the webhook skeleton"),
  });

  assert.equal(result.accepted, true);
  if (!result.accepted) {
    return;
  }
  assert.deepEqual(result.command, { kind: "run", prompt: "ship the webhook skeleton" });
  assert.equal(result.repositoryFullName, "yoophi-a/specrail");
  assert.equal(result.issueNumber, 123);
  assert.equal(result.senderLogin, "octocat");
  assert.equal(result.isPullRequest, false);
});

test("handleGitHubWebhookCommand rejects invalid signatures, unsupported events, and non-command comments", () => {
  assert.deepEqual(
    handleGitHubWebhookCommand({ eventName: "issue_comment", signatureHeader: "sha256=bad", secret, rawBody, payload: payload("/specrail run") }),
    { accepted: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    handleGitHubWebhookCommand({ eventName: "pull_request", signatureHeader, secret, rawBody, payload: payload("/specrail run") }),
    { accepted: false, reason: "unsupported_event" },
  );
  assert.deepEqual(
    handleGitHubWebhookCommand({ eventName: "issue_comment", signatureHeader, secret, rawBody, payload: payload("Looks good") }),
    { accepted: false, reason: "unsupported_command" },
  );
});
