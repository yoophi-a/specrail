import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import {
  appendRunEvents,
  bootstrapTerminalState,
  createEmptyRunEventFeedState,
  renderAppShell,
  refreshTerminalState,
  runTerminalApp,
  SpecRailTerminalApiClient,
  setRunFilter,
  selectNextItem,
  syncRunEventSelection,
  type TerminalAppState,
} from "../index.js";

test("SpecRailTerminalApiClient loads a summary snapshot", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input) => {
    const url = String(input);

    if (url.endsWith("/projects")) {
      return new Response(JSON.stringify({ projects: [{ id: "project-1", name: "SpecRail" }] }), { status: 200 });
    }

    if (url.includes("/tracks?page=")) {
      assert.ok(url.includes("projectId=project-1"));
      return new Response(JSON.stringify({ tracks: [{ id: "track-1", projectId: "project-1", title: "Terminal shell", status: "ready" }] }), { status: 200 });
    }

    if (url.includes("/runs?page=")) {
      return new Response(JSON.stringify({ runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }] }), {
        status: 200,
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const summary = await client.loadSummary("project-1");
  assert.equal(summary.projects?.[0]?.id, "project-1");
  assert.equal(summary.tracks[0]?.id, "track-1");
  assert.equal(summary.runs[0]?.id, "run-1");
});

test("SpecRailTerminalApiClient loads planning workspace details for a track", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);

    if (url.endsWith("/tracks/track-1") && !init?.method) {
      return new Response(
        JSON.stringify({
          track: { id: "track-1", title: "Terminal shell", status: "review", planStatus: "pending" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { planningSessionId: "plan-1", hasPendingChanges: true, updatedAt: "2026-04-10T12:00:00.000Z" },
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/tracks/track-1/planning-sessions")) {
      return new Response(JSON.stringify({ planningSessions: [{ id: "plan-1", trackId: "track-1", status: "active", updatedAt: "2026-04-10T12:00:00.000Z" }] }), { status: 200 });
    }

    if (url.endsWith("/planning-sessions/plan-1/messages")) {
      return new Response(JSON.stringify({ messages: [{ id: "msg-1", planningSessionId: "plan-1", authorType: "user", kind: "question", relatedArtifact: "plan", body: "Need approval?", createdAt: "2026-04-10T12:01:00.000Z" }] }), { status: 200 });
    }

    if (url.endsWith("/tracks/track-1/artifacts/spec")) {
      return new Response(JSON.stringify({ revisions: [], approvalRequests: [] }), { status: 200 });
    }

    if (url.endsWith("/tracks/track-1/artifacts/plan")) {
      return new Response(JSON.stringify({
        revisions: [{ id: "rev-1", trackId: "track-1", artifact: "plan", version: 1, createdBy: "agent", content: "# Plan v1", approvalRequestId: "approval-1", createdAt: "2026-04-10T12:00:30.000Z" }],
        approvalRequests: [{ id: "approval-1", trackId: "track-1", artifact: "plan", revisionId: "rev-1", status: "pending", requestedBy: "agent", createdAt: "2026-04-10T12:00:31.000Z" }],
      }), { status: 200 });
    }

    if (url.endsWith("/tracks/track-1/artifacts/tasks")) {
      return new Response(JSON.stringify({ revisions: [], approvalRequests: [] }), { status: 200 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const detail = await client.loadTrackDetail("track-1");
  assert.equal(detail.planningWorkspace?.planningSessions[0]?.id, "plan-1");
  assert.equal(detail.planningWorkspace?.planningMessages[0]?.body, "Need approval?");
  assert.equal(detail.planningWorkspace?.approvalRequests.plan[0]?.id, "approval-1");
  assert.equal(detail.planningWorkspace?.selectedApprovalRequestId, "approval-1");
});

test("SpecRailTerminalApiClient surfaces API validation details for execution actions", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);

    if (url.endsWith("/runs") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            message: "request validation failed",
            details: [{ field: "prompt", message: "must not be empty" }],
          },
        }),
        { status: 422 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  await assert.rejects(() => client.startRun({ trackId: "track-1", prompt: "" }), /request validation failed \(prompt: must not be empty\)/);
});

test("SpecRailTerminalApiClient submits artifact revision proposals", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);

    if (url.endsWith("/tracks/track-1/artifacts/plan") && init?.method === "POST") {
      assert.equal(init.body?.toString(), JSON.stringify({ content: "# Plan v2", summary: "Tighten milestones", createdBy: "user" }));
      return new Response(
        JSON.stringify({
          revision: { id: "rev-2", trackId: "track-1", artifact: "plan", version: 2, createdBy: "user", content: "# Plan v2", createdAt: "2026-04-13T11:00:00.000Z" },
          approvalRequest: { id: "approval-2", trackId: "track-1", artifact: "plan", revisionId: "rev-2", status: "pending", requestedBy: "user", createdAt: "2026-04-13T11:00:01.000Z" },
        }),
        { status: 201 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await client.proposeArtifactRevision({
    trackId: "track-1",
    artifact: "plan",
    content: "# Plan v2",
    summary: "Tighten milestones",
    createdBy: "user",
  });

  assert.equal(result.revision.id, "rev-2");
  assert.equal(result.approvalRequest.id, "approval-2");
});

test("SpecRailTerminalApiClient previews and applies workspace cleanup with explicit confirmation", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body?.toString() });

    if (url.endsWith("/runs/run-cleanup-a/workspace-cleanup/preview") && !init?.method) {
      return new Response(
        JSON.stringify({
          cleanupPlan: {
            dryRun: true,
            eligible: true,
            operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
            refusalReasons: [],
          },
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/runs/run-cleanup-a/workspace-cleanup/apply") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          cleanupResult: {
            applied: true,
            status: "applied",
            operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a", status: "applied" }],
            refusalReasons: [],
          },
          expectedConfirmation: "apply workspace cleanup for run-cleanup-a",
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const preview = await client.previewWorkspaceCleanup("run-cleanup-a");
  assert.equal(preview.cleanupPlan.eligible, true);
  assert.equal(preview.cleanupPlan.operations[0]?.kind, "remove_directory");

  const apply = await client.applyWorkspaceCleanup("run-cleanup-a", "apply workspace cleanup for run-cleanup-a");
  assert.equal(apply.cleanupResult.status, "applied");
  assert.equal(apply.expectedConfirmation, "apply workspace cleanup for run-cleanup-a");
  assert.equal(requests[1]?.body, JSON.stringify({ confirm: "apply workspace cleanup for run-cleanup-a" }));
});

test("SpecRailTerminalApiClient preserves server refusal details for workspace cleanup apply", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input, init) => {
    const url = String(input);

    if (url.endsWith("/runs/run-cleanup-a/workspace-cleanup/apply") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          cleanupResult: {
            applied: false,
            status: "refused",
            operations: [],
            refusalReasons: ["Workspace cleanup apply requires explicit confirmation"],
          },
          expectedConfirmation: "apply workspace cleanup for run-cleanup-a",
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await client.applyWorkspaceCleanup("run-cleanup-a", "cleanup");
  assert.equal(result.cleanupResult.status, "refused");
  assert.deepEqual(result.cleanupResult.refusalReasons, ["Workspace cleanup apply requires explicit confirmation"]);
  assert.equal(result.expectedConfirmation, "apply workspace cleanup for run-cleanup-a");
});

test("SpecRailTerminalApiClient loads run events for post-action refresh", async () => {
  const client = new SpecRailTerminalApiClient("http://example.test", async (input) => {
    const url = String(input);

    if (url.endsWith("/runs/run-cleanup-a/events")) {
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "run-cleanup-a:workspace-cleanup:2026-05-03T00:00:00.000Z",
              executionId: "run-cleanup-a",
              type: "summary",
              timestamp: "2026-05-03T00:00:00.000Z",
              source: "specrail",
              summary: "Workspace cleanup applied for execution run-cleanup-a",
              payload: { status: "applied" },
            },
          ],
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  const events = await client.loadRunEvents("run-cleanup-a");
  assert.equal(events[0]?.summary, "Workspace cleanup applied for execution run-cleanup-a");
  assert.equal(events[0]?.payload?.status, "applied");
});

test("SpecRailTerminalApiClient parses SSE frames from run event streams", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"id":"evt-1","executionId":"run-1","type":"task_status_changed","timestamp":"2026-04-10T12:00:00.000Z","source":"codex","summary":"Run started","payload":{"status":"running"}}\n\n'),
    encoder.encode('data: {"id":"evt-2","executionId":"run-1","type":"task_status_changed","subtype":"codex_completed","timestamp":"2026-04-10T12:02:00.000Z","source":"codex","summary":"Run completed","payload":{"status":"completed"}}\n\n'),
  ];

  const client = new SpecRailTerminalApiClient("http://example.test", async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );

  const events = [] as Array<{ id: string; type: string; summary: string; subtype?: string }>;
  for await (const event of client.streamRunEvents("run-1")) {
    events.push({ id: event.id, type: event.type, summary: event.summary, subtype: event.subtype });
  }

  assert.deepEqual(events, [
    { id: "evt-1", type: "task_status_changed", summary: "Run started", subtype: undefined },
    { id: "evt-2", type: "task_status_changed", summary: "Run completed", subtype: "codex_completed" },
  ]);
});

test("bootstrapTerminalState initializes detail selections for tracks and runs", async () => {
  const state = await bootstrapTerminalState(
    {
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      initialScreen: "home",
      initialProjectId: "project-1",
      initialRunFilter: "active",
    },
    {
      async loadSummary(projectId) {
        assert.equal(projectId, "project-1");
        return {
          tracks: [{ id: "track-1", title: "Terminal shell", status: "ready", priority: "high" }],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:00:00.000Z",
        };
      },
      async loadTrackDetail() {
        return {
          track: { id: "track-1", title: "Terminal shell", status: "ready", priority: "high" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { hasPendingChanges: false },
        };
      },
      async loadRunDetail() {
        return {
          run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        };
      },
    },
  );

  assert.equal(state.screen, "home");
  assert.match(state.statusLine, /Loaded 1 tracks and 1 runs/);
  assert.equal(state.selectedProjectId, "project-1");
  assert.equal(state.tracks.selectedId, "track-1");
  assert.equal(state.runs.selectedId, "run-1");
  assert.equal(state.runFilter, "active");
  assert.equal(state.runEvents.runId, "run-1");
});

test("renderAppShell renders track list and selected detail preview", () => {
  const rendered = renderAppShell({
    screen: "tracks",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        track: {
          id: "track-1",
          title: "Terminal shell",
          status: "ready",
          priority: "high",
          specStatus: "approved",
          planStatus: "pending",
        },
        artifacts: {
          spec: "# Spec\nTerminal shell",
          plan: "# Plan\nAdd navigation",
          tasks: "# Tasks\n- Build it",
        },
        planningContext: { planningSessionId: "plan-1", hasPendingChanges: true },
        planningWorkspace: {
          planningSessions: [{ id: "plan-1", trackId: "track-1", status: "active", updatedAt: "2026-04-10T12:00:00.000Z" }],
          planningMessages: [{ id: "msg-1", planningSessionId: "plan-1", authorType: "user", kind: "question", relatedArtifact: "plan", body: "Need approval?", createdAt: "2026-04-10T12:01:00.000Z" }],
          revisions: {
            spec: [],
            plan: [
              { id: "rev-2", trackId: "track-1", artifact: "plan", version: 2, createdBy: "user", content: "# Plan\nShip it", approvalRequestId: "approval-2", approvedAt: "2026-04-10T12:10:00.000Z", createdAt: "2026-04-10T12:09:30.000Z" },
              { id: "rev-1", trackId: "track-1", artifact: "plan", version: 1, createdBy: "agent", content: "# Plan\nAdd navigation", approvalRequestId: "approval-1", createdAt: "2026-04-10T12:00:30.000Z" },
            ],
            tasks: [],
          },
          approvalRequests: {
            spec: [],
            plan: [{ id: "approval-1", trackId: "track-1", artifact: "plan", revisionId: "rev-1", status: "pending", requestedBy: "agent", createdAt: "2026-04-10T12:00:31.000Z" }],
            tasks: [],
          },
          selectedPlanningSessionId: "plan-1",
          selectedArtifact: "plan",
          selectedRevisionId: "rev-1",
          selectedApprovalRequestId: "approval-1",
        },
      },
    },
    runs: {
      selectedId: null,
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runFilter: "all",
    runEvents: createEmptyRunEventFeedState(),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready", priority: "high" }],
      runs: [],
    },
  });

  assert.match(rendered, /SpecRail Terminal/);
  assert.match(rendered, /\[TRACKS\]/);
  assert.match(rendered, /> track-1 \| project\? \| ready \| high \| Terminal shell/);
  assert.match(rendered, /planning session: plan-1/);
  assert.match(rendered, /pending planning changes: yes/);
  assert.match(rendered, /execution context signal: new approvals needed before new runs/);
  assert.match(rendered, /planning sessions:/);
  assert.match(rendered, /Need approval\?/);
  assert.match(rendered, /revision focus \(plan 2\/2\): v1 by agent/);
  assert.match(rendered, /pending approvals: plan -> rev-1 requested by agent/);
  assert.match(rendered, /planning actions: h\/l switches artifact focus, \[\/\] cycles revisions, v proposes a new revision for plan/);
  assert.match(rendered, /press a to approve or x to reject selected pending request/);
  assert.match(rendered, /execution actions: press s to start a run for this track/);
  assert.match(rendered, /spec preview: # Spec Terminal shell/);
  assert.match(rendered, /Keys: 1 home, 2 tracks, 3 runs, 4 settings, j\/k or ↑\/↓ select, P project scope, h\/l artifact, \[\/\] revision, v propose, f run filter, Space tail pause\/resume, s start, e resume, c cancel, w cleanup, a approve, x reject, r refresh, q quit/);
  assert.match(rendered, /Help: tracks — P cycles project scope, h\/l switches artifact, \[\/\] cycles revisions, v proposes, a\/x approves or rejects pending revisions, s starts a run\./);
});

test("renderAppShell renders run event monitor details", () => {
  const rendered = renderAppShell({
    screen: "runs",
    statusLine: "Streaming run events.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: {
          id: "run-1",
          trackId: "track-1",
          status: "failed",
          backend: "claude_code",
          profile: "sonnet",
          planningSessionId: "plan-1",
          planningContextStale: true,
          planningContextStaleReason: "plan changed after launch",
          summary: { eventCount: 9, lastEventSummary: "Failed Claude Code session run-1-claude" },
          startedAt: "2026-04-10T12:00:00.000Z",
          finishedAt: "2026-04-10T12:05:00.000Z",
        },
      },
    },
    runFilter: "terminal",
    runEvents: appendRunEvents(
      {
        ...createEmptyRunEventFeedState("run-1"),
        connection: "reconnecting",
        reconnectAttempts: 2,
      },
      [
        {
          id: "evt-tool",
          executionId: "run-1",
          type: "tool_call",
          subtype: "claude_tool_call",
          timestamp: "2026-04-10T12:02:30.000Z",
          source: "claude_code",
          summary: "Claude requested tool Bash",
          payload: { toolName: "Bash", toolUseId: "toolu-1", toolInput: { command: "pnpm test -- --runInBand" } },
        },
        {
          id: "evt-approval",
          executionId: "run-1",
          type: "approval_requested",
          subtype: "claude_permission_denial",
          timestamp: "2026-04-10T12:02:45.000Z",
          source: "claude_code",
          summary: "Claude requested approval for Bash",
          payload: { requestId: "approval-1", toolName: "Bash" },
        },
        {
          id: "evt-0",
          executionId: "run-1",
          type: "message",
          timestamp: "2026-04-10T12:03:00.000Z",
          source: "claude_code",
          summary: "STDERR run-1-claude",
          payload: { stream: "stderr", text: "first line\nsecond line with detailed provider output that should stay bounded in the terminal tail" },
        },
        {
          id: "evt-1",
          executionId: "run-1",
          type: "task_status_changed",
          timestamp: "2026-04-10T12:04:00.000Z",
          source: "claude_code",
          summary: "Failed Claude Code session run-1-claude",
          payload: { status: "failed", exitCode: 1 },
        },
      ],
    ),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:06:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "failed" }],
      runs: [{ id: "run-1", trackId: "track-1", status: "failed", backend: "claude_code" }],
    },
  });

  assert.match(rendered, /event summary: 4 events, last at 2026-04-10T12:04:00.000Z/);
  assert.match(rendered, /failure focus: Failed Claude Code session run-1-claude \(exit 1\)/);
  assert.match(rendered, /Runs \(1\/1, filter=terminal\)/);
  assert.match(rendered, /stream: reconnecting \(attempt 2\)/);
  assert.match(rendered, /report: \/runs\/run-1\/report\.md/);
  assert.match(rendered, /operator actions: press e to resume this run, w to preview workspace cleanup, Space to pause tail/);
  assert.match(rendered, /Help: runs — f cycles filters, Space pauses live tail, e resumes terminal runs, c cancels active runs, w previews workspace cleanup\./);
  assert.match(rendered, /recent activity:/);
  assert.match(rendered, /tool_call \| claude_tool_call \| Claude requested tool Bash — tool=Bash, id=toolu-1, input=\{\"command\":\"pnpm test -- --runInBand\"\}/);
  assert.match(rendered, /approval_requested \| claude_permission_denial \| Claude requested approval for Bash — request=approval-1, tool=Bash/);
  assert.match(rendered, /message \| stream=stderr \| STDERR run-1-claude — first line second line with detailed provider output/);
  assert.match(rendered, /task_status_changed \| status=failed \| Failed Claude Code session run-1-claude/);
});

test("renderAppShell renders guarded workspace cleanup preview and confirmation state", () => {
  const rendered = renderAppShell({
    screen: "runs",
    statusLine: "Cleanup preview ready for run-cleanup-a.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-cleanup-a",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: { id: "run-cleanup-a", trackId: "track-1", status: "cancelled", backend: "codex" },
      },
    },
    runFilter: "terminal",
    runEvents: createEmptyRunEventFeedState("run-cleanup-a"),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    pendingWorkspaceCleanupAction: {
      runId: "run-cleanup-a",
      phase: "confirmation_ready",
      submitting: false,
      message: "Server confirmation phrase received. Press Enter again to apply cleanup with that exact phrase.",
      preview: {
        cleanupPlan: {
          dryRun: true,
          eligible: true,
          operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
          refusalReasons: [],
        },
      },
      result: {
        expectedConfirmation: "apply workspace cleanup for run-cleanup-a",
        cleanupResult: {
          applied: false,
          status: "refused",
          operations: [],
          refusalReasons: ["Workspace cleanup apply requires explicit confirmation"],
        },
      },
    },
    summary: {
      fetchedAt: "2026-04-10T12:06:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "failed" }],
      runs: [{ id: "run-cleanup-a", trackId: "track-1", status: "cancelled", backend: "codex" }],
    },
  });

  assert.match(rendered, /Workspace cleanup: run-cleanup-a/);
  assert.match(rendered, /eligible: yes/);
  assert.match(rendered, /remove_directory \/tmp\/specrail-workspaces\/run-cleanup-a/);
  assert.match(rendered, /server confirmation: apply workspace cleanup for run-cleanup-a/);
  assert.match(rendered, /result: refused/);
  assert.match(rendered, /Press Enter again to apply cleanup with that exact phrase/);
  assert.match(rendered, /Help: workspace cleanup — Enter requests confirmation\/applies when ready, Esc aborts, r refreshes selected run\./);
});

test("selectNextItem advances run selection on runs screen", () => {
  const state = selectNextItem({
    screen: "runs",
    statusLine: "Loaded terminal snapshot.",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: {
      selectedId: "track-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: null,
    },
    runs: {
      selectedId: "run-1",
      selectedIndex: 0,
      loading: false,
      error: null,
      data: {
        run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
      },
    },
    runFilter: "all",
    runEvents: appendRunEvents(createEmptyRunEventFeedState("run-1"), [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
    ]),
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:00:00.000Z",
      tracks: [{ id: "track-1", title: "Terminal shell", status: "ready" }],
      runs: [
        { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        { id: "run-2", trackId: "track-1", status: "completed", backend: "claude_code" },
      ],
    },
  } satisfies TerminalAppState);

  assert.equal(state.runs.selectedId, "run-2");
  assert.equal(state.runs.selectedIndex, 1);
  assert.equal(state.runs.data, null);
  assert.equal(state.runEvents.runId, "run-2");
  assert.deepEqual(state.runEvents.items, []);
});

test("refreshTerminalState preserves selection and surfaces detail load errors", async () => {
  const nextState = await refreshTerminalState(
    {
      screen: "tracks",
      statusLine: "Loaded terminal snapshot.",
      apiBaseUrl: "http://127.0.0.1:4000",
      refreshIntervalMs: 5000,
      loading: false,
      error: null,
      tracks: {
        selectedId: "track-2",
        selectedIndex: 1,
        loading: false,
        error: null,
        data: null,
      },
      runs: {
        selectedId: "run-1",
        selectedIndex: 0,
        loading: false,
        error: null,
        data: null,
      },
      runFilter: "all",
      runEvents: createEmptyRunEventFeedState("run-1"),
      pendingTrackAction: null,
      pendingExecutionAction: null,
      pendingProposalAction: null,
      summary: {
        fetchedAt: "2026-04-10T12:00:00.000Z",
        tracks: [
          { id: "track-1", title: "A", status: "ready" },
          { id: "track-2", title: "B", status: "blocked" },
        ],
        runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
      },
    },
    {
      async loadSummary() {
        return {
          tracks: [
            { id: "track-1", title: "A", status: "ready" },
            { id: "track-2", title: "B", status: "blocked" },
          ],
          runs: [{ id: "run-1", trackId: "track-1", status: "running", backend: "codex" }],
          fetchedAt: "2026-04-10T12:05:00.000Z",
        };
      },
      async loadTrackDetail(trackId: string) {
        if (trackId === "track-2") {
          throw new Error("boom");
        }

        return {
          track: { id: trackId, title: "A", status: "ready" },
          artifacts: { spec: "# Spec", plan: "# Plan", tasks: "# Tasks" },
          planningContext: { hasPendingChanges: false },
        };
      },
      async loadRunDetail() {
        return {
          run: { id: "run-1", trackId: "track-1", status: "running", backend: "codex" },
        };
      },
    },
  );

  assert.equal(nextState.tracks.selectedId, "track-2");
  assert.equal(nextState.tracks.selectedIndex, 1);
  assert.equal(nextState.tracks.error, "boom");
  assert.match(nextState.statusLine, /Refreshed 2 tracks and 1 runs/);
});

test("appendRunEvents deduplicates by event id and syncRunEventSelection resets mismatched feeds", () => {
  const feed = appendRunEvents(
    appendRunEvents(createEmptyRunEventFeedState("run-1"), [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
    ]),
    [
      {
        id: "evt-1",
        executionId: "run-1",
        type: "task_status_changed",
        timestamp: "2026-04-10T12:00:00.000Z",
        source: "codex",
        summary: "Run started",
        payload: { status: "running" },
      },
      {
        id: "evt-2",
        executionId: "run-1",
        type: "summary",
        timestamp: "2026-04-10T12:01:00.000Z",
        source: "codex",
        summary: "Planning context updated",
      },
    ],
  );

  assert.equal(feed.items.length, 2);
  assert.equal(feed.lastEventAt, "2026-04-10T12:01:00.000Z");

  const reset = syncRunEventSelection({
    screen: "runs",
    statusLine: "ok",
    apiBaseUrl: "http://127.0.0.1:4000",
    refreshIntervalMs: 5000,
    loading: false,
    error: null,
    tracks: { selectedId: null, selectedIndex: 0, loading: false, error: null, data: null },
    runs: { selectedId: "run-2", selectedIndex: 1, loading: false, error: null, data: null },
    runFilter: "all",
    runEvents: { ...feed, runId: "run-1", connection: "live", paused: false },
    pendingTrackAction: null,
    pendingExecutionAction: null,
    pendingProposalAction: null,
    summary: {
      fetchedAt: "2026-04-10T12:02:00.000Z",
      tracks: [],
      runs: [{ id: "run-2", trackId: "track-1", status: "running" }],
    },
  });

  assert.equal(reset.runEvents.runId, "run-2");
  assert.deepEqual(reset.runEvents.items, []);
  assert.equal(reset.runEvents.connection, "idle");

  const filtered = setRunFilter({
    ...reset,
    summary: {
      fetchedAt: "2026-04-10T12:02:00.000Z",
      tracks: [],
      runs: [
        { id: "run-2", trackId: "track-1", status: "running" },
        { id: "run-3", trackId: "track-1", status: "completed" },
      ],
    },
    runs: { ...reset.runs, selectedId: "run-2", selectedIndex: 0 },
    runEvents: { ...reset.runEvents, runId: "run-2", paused: true, connection: "paused" },
  }, "terminal");

  assert.equal(filtered.runFilter, "terminal");
  assert.equal(filtered.runs.selectedId, "run-3");
  assert.equal(filtered.runEvents.runId, "run-3");
  assert.equal(filtered.runEvents.paused, true);
});

test("runTerminalApp drives cleanup preview, confirmation, apply, and refresh through keypresses", async () => {
  const applyBodies: unknown[] = [];
  const requests: string[] = [];

  const server = createServer(async (request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/projects") {
      sendJson(response, { projects: [{ id: "project-default", name: "SpecRail" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tracks") {
      sendJson(response, { tracks: [{ id: "track-cleanup-a", projectId: "project-default", title: "Cleanup track", status: "ready" }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      sendJson(response, {
        runs: [
          {
            id: "run-cleanup-a",
            trackId: "track-cleanup-a",
            status: "completed",
            backend: "codex",
            profile: "default",
            workspacePath: "/tmp/specrail-workspaces/run-cleanup-a",
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run-cleanup-a") {
      sendJson(response, {
        run: {
          id: "run-cleanup-a",
          trackId: "track-cleanup-a",
          status: "completed",
          backend: "codex",
          profile: "default",
          workspacePath: "/tmp/specrail-workspaces/run-cleanup-a",
          summary: { eventCount: applyBodies.length >= 2 ? 1 : 0 },
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run-cleanup-a/workspace-cleanup/preview") {
      sendJson(response, {
        cleanupPlan: {
          dryRun: true,
          eligible: true,
          operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a" }],
          refusalReasons: [],
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/runs/run-cleanup-a/workspace-cleanup/apply") {
      const body = await readRequestJson(request);
      applyBodies.push(body);
      const confirm = typeof body === "object" && body !== null && "confirm" in body ? String(body.confirm) : "";
      const expectedConfirmation = "apply workspace cleanup for run-cleanup-a";
      sendJson(response, {
        cleanupResult: confirm === expectedConfirmation
          ? {
              applied: true,
              status: "applied",
              operations: [{ kind: "remove_directory", path: "/tmp/specrail-workspaces/run-cleanup-a", status: "applied" }],
              refusalReasons: [],
            }
          : {
              applied: false,
              status: "refused",
              operations: [],
              refusalReasons: ["Workspace cleanup apply requires explicit confirmation"],
            },
        expectedConfirmation,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs/run-cleanup-a/events") {
      sendJson(response, {
        events: [
          {
            id: "run-cleanup-a:workspace-cleanup:2026-05-03T00:00:00.000Z",
            executionId: "run-cleanup-a",
            type: "summary",
            timestamp: "2026-05-03T00:00:00.000Z",
            source: "specrail",
            summary: "Workspace cleanup applied for execution run-cleanup-a",
            payload: { status: "applied" },
          },
        ],
      });
      return;
    }

    sendJson(response, { error: { message: `Unexpected request: ${request.method} ${url.pathname}` } }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address);
  const { port } = address as AddressInfo;

  const stdin = new FakeTerminalStdin();
  const stdout = new FakeTerminalStdout();
  const app = runTerminalApp(
    { apiBaseUrl: `http://127.0.0.1:${port}`, refreshIntervalMs: 0, initialScreen: "runs", initialProjectId: null, initialRunFilter: "all" },
    { stdin, stdout } as never,
  );

  try {
    await waitFor(() => stdout.output.includes("run-cleanup-a"));

    stdin.key("w");
    await waitFor(() => stdout.output.includes("Cleanup preview ready for run-cleanup-a."));
    assert.equal(applyBodies.length, 0);

    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Workspace cleanup confirmation ready for run-cleanup-a."));
    assert.deepEqual(applyBodies, [{ confirm: "" }]);

    stdin.key("\r", "return");
    await waitFor(() => stdout.output.includes("Workspace cleanup applied for run-cleanup-a; detail and events refreshed."));
    assert.deepEqual(applyBodies[1], { confirm: "apply workspace cleanup for run-cleanup-a" });
    assert(stdout.output.includes("Workspace cleanup applied for execution run-cleanup-a"));
    assert(requests.includes("GET /runs/run-cleanup-a/events"));
  } finally {
    stdin.key("q");
    await app;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

class FakeTerminalStdin extends EventEmitter {
  isTTY = true;

  setRawMode(_enabled: boolean): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  key(input: string, name = input): void {
    this.emit("keypress", input, { name });
  }
}

class FakeTerminalStdout {
  output = "";

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}
