export function operatorUiText(value: unknown): string {
  return value === undefined || value === null || value === "" ? "unknown" : String(value);
}

export function operatorUiEscapeHtml(value: unknown): string {
  return operatorUiText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function operatorUiMetadataHtml(fields: Array<readonly [string, unknown]>): string {
  return `<dl>${fields
    .map(([key, value]) => `<dt>${operatorUiEscapeHtml(key)}</dt><dd>${operatorUiEscapeHtml(value)}</dd>`)
    .join("")}</dl>`;
}

export function operatorUiPreviewHtml(label: string, value: unknown): string {
  if (!value) {
    return "";
  }

  return `<h3>${operatorUiEscapeHtml(label)}</h3><div class="artifact-preview">${operatorUiEscapeHtml(String(value).slice(0, 2_000))}</div>`;
}

export function operatorUiProjectCreatePath(): string {
  return "/projects";
}

export function operatorUiProjectUpdatePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function operatorUiTrackCreatePath(): string {
  return "/tracks";
}

export function operatorUiTrackUpdatePath(trackId: string): string {
  return `/tracks/${encodeURIComponent(trackId)}`;
}

export function operatorUiPlanningSessionCreatePath(trackId: string): string {
  return `/tracks/${encodeURIComponent(trackId)}/planning-sessions`;
}

export function operatorUiPlanningMessageAppendPath(planningSessionId: string): string {
  return `/planning-sessions/${encodeURIComponent(planningSessionId)}/messages`;
}

export function operatorUiApprovalDecisionPath(approvalRequestId: string, decision: "approve" | "reject"): string {
  return `/approval-requests/${encodeURIComponent(approvalRequestId)}/${decision}`;
}

export function operatorUiArtifactProposalPath(trackId: string, artifact: "spec" | "plan" | "tasks"): string {
  return `/tracks/${encodeURIComponent(trackId)}/artifacts/${artifact}`;
}

export function operatorUiRunCreatePath(): string {
  return "/runs";
}

export function operatorUiRunResumePath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/resume`;
}

export function operatorUiRunCancelPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/cancel`;
}

export function operatorUiCleanupPreviewPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/workspace-cleanup/preview`;
}

export function operatorUiCleanupApplyPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/workspace-cleanup/apply`;
}

export function operatorUiRunEventStreamPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/events/stream`;
}

export function renderOperatorUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SpecRail Operator</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 2rem; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; display: grid; gap: 1rem; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 1.75rem; }
    section { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 0.75rem; padding: 1rem; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
    label { display: grid; gap: 0.35rem; font-weight: 600; }
    select, button { font: inherit; padding: 0.5rem 0.65rem; border-radius: 0.5rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
    button { cursor: pointer; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
    li { padding: 0.65rem; border-radius: 0.5rem; background: color-mix(in srgb, Canvas 90%, CanvasText 10%); }
    .muted { color: color-mix(in srgb, CanvasText 65%, transparent); }
    .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 999px; background: color-mix(in srgb, CanvasText 10%, transparent); font-size: 0.85em; }
    .detail-grid { display: grid; gap: 0.75rem; }
    .detail-grid dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 0.75rem; margin: 0; }
    .detail-grid dt { font-weight: 700; }
    .artifact-preview { max-height: 12rem; overflow: auto; padding: 0.65rem; border-radius: 0.5rem; background: color-mix(in srgb, Canvas 88%, CanvasText 12%); white-space: pre-wrap; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>SpecRail Operator</h1>
        <p class="muted">Thin hosted slice over the existing HTTP/SSE API.</p>
      </div>
      <button id="refresh">Refresh</button>
    </header>
    <section>
      <label>Project scope
        <select id="project-scope"><option value="">All projects</option></select>
      </label>
      <p><button id="project-create">Create project</button> <button id="project-update">Update selected project</button> <button id="track-create">Create track</button></p>
      <p id="status" class="muted">Loading…</p>
    </section>
    <div class="grid">
      <section><h2>Tracks</h2><ul id="tracks"></ul></section>
      <section><h2>Runs</h2><ul id="runs"></ul></section>
    </div>
    <section><h2>Selected detail</h2><div id="detail" class="muted">Select a track or run.</div></section>
  </main>
  <script type="module">
    const scope = document.querySelector('#project-scope');
    const status = document.querySelector('#status');
    const tracks = document.querySelector('#tracks');
    const runs = document.querySelector('#runs');
    const detail = document.querySelector('#detail');
    const refresh = document.querySelector('#refresh');
    const projectCreate = document.querySelector('#project-create');
    const projectUpdate = document.querySelector('#project-update');
    const trackCreate = document.querySelector('#track-create');
    let activeEventStream = null;
    let projectsById = new Map();

    async function api(path, init) {
      const response = await fetch(path, { headers: { accept: 'application/json', 'content-type': 'application/json' }, ...init });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function postJson(path, body) {
      return api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    }

    function patchJson(path, body) {
      return api(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
    }

    function item(label, meta, onClick) {
      const node = document.createElement('li');
      node.innerHTML = '<strong></strong><br><span class="muted"></span>';
      node.querySelector('strong').textContent = label;
      node.querySelector('span').textContent = meta;
      node.addEventListener('click', onClick);
      return node;
    }

    function text(value) {
      return value === undefined || value === null || value === '' ? 'unknown' : String(value);
    }

    function escapeHtml(value) {
      return text(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function metadata(fields) {
      return '<dl>' + fields.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('') + '</dl>';
    }

    function preview(label, value) {
      if (!value) return '';
      return '<h3>' + escapeHtml(label) + '</h3><div class="artifact-preview">' + escapeHtml(String(value).slice(0, 2000)) + '</div>';
    }

    function artifactApprovalActions(artifactPayloads) {
      const pending = artifactPayloads.flatMap(([artifact, payload]) => (payload.approvalRequests ?? [])
        .filter((request) => request.status === 'pending')
        .map((request) => ({ ...request, artifact })));
      if (pending.length === 0) {
        return '<h3>Approval actions</h3><p class="muted">No pending artifact approvals.</p>';
      }
      return '<h3>Approval actions</h3><ul>' + pending.map((request) => '<li><strong>' + escapeHtml(request.artifact) + ' approval</strong><br><span class="muted">' + escapeHtml(request.id) + '</span><br><button data-approval-id="' + escapeHtml(request.id) + '" data-decision="approve">Approve</button> <button data-approval-id="' + escapeHtml(request.id) + '" data-decision="reject">Reject</button></li>').join('') + '</ul>';
    }

    function closeEventStream() {
      if (activeEventStream) {
        activeEventStream.close();
        activeEventStream = null;
      }
    }

    function renderTrackDetail(payload, artifactPayloads) {
      closeEventStream();
      const track = payload.track;
      const planning = payload.planningContext ?? {};
      detail.className = 'detail-grid';
      detail.innerHTML = '<h3>' + escapeHtml(track.title ?? track.id) + '</h3>'
        + metadata([
          ['Track ID', track.id],
          ['Project', track.projectId],
          ['Status', track.status],
          ['Priority', track.priority],
          ['Spec approval', track.specStatus],
          ['Plan approval', track.planStatus],
          ['Planning session', planning.planningSessionId],
          ['Pending planning changes', planning.hasPendingChanges ? 'yes' : 'no'],
          ['Updated', track.updatedAt],
        ])
        + '<h3>Track workflow</h3><button data-track-update="workflow">Update track workflow</button>'
        + '<h3>Planning</h3><button data-planning-session-create="' + escapeHtml(track.id) + '">Create planning session</button> <button data-planning-message-append="' + escapeHtml(planning.planningSessionId ?? '') + '">Append planning message</button>'
        + '<h3>Artifact proposals</h3><button data-artifact-proposal="spec">Propose spec</button> <button data-artifact-proposal="plan">Propose plan</button> <button data-artifact-proposal="tasks">Propose tasks</button>'
        + '<h3>Run lifecycle</h3><button data-run-start="' + escapeHtml(track.id) + '">Start run</button>'
        + artifactApprovalActions(artifactPayloads)
        + preview('Spec preview', payload.artifacts?.spec)
        + preview('Plan preview', payload.artifacts?.plan)
        + preview('Tasks preview', payload.artifacts?.tasks);
      detail.querySelector('[data-track-update]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const statusInput = window.prompt('Track status for ' + track.id + ' (new, planned, ready, in_progress, blocked, review, done, failed)', track.status ?? 'new');
        if (!statusInput) {
          status.textContent = 'Track update cancelled for ' + track.id + '.';
          return;
        }
        const specStatusInput = window.prompt('Spec status for ' + track.id + ' (draft, pending, approved, rejected)', track.specStatus ?? 'draft');
        const planStatusInput = window.prompt('Plan status for ' + track.id + ' (draft, pending, approved, rejected)', track.planStatus ?? 'draft');
        button.disabled = true;
        try {
          status.textContent = 'Updating track ' + track.id + '…';
          await patchJson('/tracks/' + encodeURIComponent(track.id), {
            status: statusInput,
            specStatus: specStatusInput || undefined,
            planStatus: planStatusInput || undefined,
          });
          await load();
          await loadTrackDetail(track.id);
          status.textContent = 'Updated track ' + track.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      detail.querySelector('[data-planning-session-create]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const planningStatus = window.prompt('Planning session status (active, waiting_user, waiting_agent, approved, archived)', 'active') ?? 'active';
        button.disabled = true;
        try {
          status.textContent = 'Creating planning session for ' + track.id + '…';
          await postJson('/tracks/' + encodeURIComponent(track.id) + '/planning-sessions', { status: planningStatus });
          await loadTrackDetail(track.id);
          status.textContent = 'Created planning session for ' + track.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      detail.querySelector('[data-planning-message-append]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const planningSessionId = button.getAttribute('data-planning-message-append');
        if (!planningSessionId) {
          status.textContent = 'Create a planning session before appending a message for ' + track.id + '.';
          return;
        }
        const body = window.prompt('Planning message body for ' + track.id);
        if (!body) {
          status.textContent = 'Planning message cancelled for ' + track.id + '.';
          return;
        }
        const authorType = window.prompt('Planning message author (user, agent, system)', 'user') ?? 'user';
        const kind = window.prompt('Planning message kind (message, question, decision, note)', 'message') ?? 'message';
        const relatedArtifact = window.prompt('Related artifact (spec, plan, tasks; blank for none)', '') || undefined;
        button.disabled = true;
        try {
          status.textContent = 'Appending planning message for ' + track.id + '…';
          await postJson('/planning-sessions/' + encodeURIComponent(planningSessionId) + '/messages', { authorType, kind, body, relatedArtifact });
          await loadTrackDetail(track.id);
          status.textContent = 'Appended planning message for ' + track.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      detail.querySelectorAll('[data-artifact-proposal]').forEach((button) => {
        button.addEventListener('click', async () => {
          const artifact = button.getAttribute('data-artifact-proposal');
          const content = window.prompt('New ' + artifact + ' content for ' + track.id, payload.artifacts?.[artifact] ?? '');
          if (!content) {
            status.textContent = 'Artifact proposal cancelled for ' + artifact + '.';
            return;
          }
          const summaryText = window.prompt('Proposal summary for ' + artifact, 'Proposed from hosted operator UI') ?? undefined;
          button.disabled = true;
          try {
            status.textContent = 'Proposing ' + artifact + ' revision for ' + track.id + '…';
            await postJson('/tracks/' + encodeURIComponent(track.id) + '/artifacts/' + artifact, { content, summary: summaryText, createdBy: 'user' });
            await loadTrackDetail(track.id);
            status.textContent = 'Proposed ' + artifact + ' revision for ' + track.id + '.';
          } catch (error) {
            button.disabled = false;
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        });
      });
      detail.querySelector('[data-run-start]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const promptText = window.prompt('Prompt for the new run on ' + track.id, 'Implement the selected track.');
        if (!promptText) {
          status.textContent = 'Run start cancelled for ' + track.id + '.';
          return;
        }
        button.disabled = true;
        try {
          status.textContent = 'Starting run for ' + track.id + '…';
          const runPayload = await postJson('/runs', { trackId: track.id, prompt: promptText });
          await load();
          await loadRunDetail(runPayload.run.id);
          status.textContent = 'Started run ' + runPayload.run.id + ' for ' + track.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      detail.querySelectorAll('[data-approval-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          const approvalId = button.getAttribute('data-approval-id');
          const decision = button.getAttribute('data-decision');
          button.disabled = true;
          try {
            status.textContent = (decision === 'approve' ? 'Approving ' : 'Rejecting ') + approvalId + '…';
            await postJson('/approval-requests/' + encodeURIComponent(approvalId) + '/' + decision, { decidedBy: 'user', comment: 'decided from hosted operator UI' });
            await loadTrackDetail(track.id);
            status.textContent = 'Artifact approval ' + decision + ' completed for ' + approvalId + '.';
          } catch (error) {
            button.disabled = false;
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        });
      });
    }

    function appendRunEvent(event) {
      const list = detail.querySelector('#run-events');
      if (!list) return;
      list.append(item(event.type, (event.summary ?? '') + ' · ' + (event.timestamp ?? ''), () => {}));
      while (list.children.length > 20) {
        list.firstElementChild?.remove();
      }
    }

    function startRunEventStream(runId) {
      closeEventStream();
      if (typeof EventSource === 'undefined') {
        status.textContent = 'Live event stream unavailable in this browser.';
        return;
      }
      activeEventStream = new EventSource('/runs/' + encodeURIComponent(runId) + '/events/stream');
      activeEventStream.addEventListener('execution-event', (message) => {
        appendRunEvent(JSON.parse(message.data));
        status.textContent = 'Live event received for ' + runId + '.';
      });
      activeEventStream.onerror = () => {
        status.textContent = 'Live event stream disconnected for ' + runId + '; recent events remain visible.';
        closeEventStream();
      };
    }

    function renderRunDetail(runPayload, eventsPayload, cleanupPayload) {
      const run = runPayload.run;
      const events = eventsPayload.events ?? [];
      const cleanupPlan = cleanupPayload?.cleanupPlan;
      const cleanupSection = cleanupPlan
        ? '<h3>Workspace cleanup</h3>' + metadata([
          ['Eligible', cleanupPlan.eligible ? 'yes' : 'no'],
          ['Operations', (cleanupPlan.operations ?? []).length],
          ['Refusal reasons', (cleanupPlan.refusalReasons ?? []).join('; ') || 'none'],
        ]) + '<button data-cleanup-preview="' + escapeHtml(run.id) + '">Refresh cleanup preview</button> <button data-cleanup-apply="' + escapeHtml(run.id) + '"' + (cleanupPlan.eligible ? '' : ' disabled') + '>Apply with server confirmation</button>'
        : '<h3>Workspace cleanup</h3><button data-cleanup-preview="' + escapeHtml(run.id) + '">Load cleanup preview</button>';
      detail.className = 'detail-grid';
      detail.innerHTML = '<h3>Run ' + escapeHtml(run.id) + '</h3>'
        + metadata([
          ['Run ID', run.id],
          ['Track ID', run.trackId],
          ['Status', run.status],
          ['Backend', run.backend],
          ['Profile', run.profile],
          ['Workspace', run.workspacePath],
          ['Branch', run.branchName],
          ['Planning session', run.planningSessionId],
          ['Started', run.startedAt],
          ['Finished', run.finishedAt],
        ])
        + '<h3>Run lifecycle</h3><button data-run-resume="' + escapeHtml(run.id) + '">Resume run</button> <button data-run-cancel="' + escapeHtml(run.id) + '">Cancel run</button>'
        + cleanupSection
        + '<h3>Recent events</h3><p class="muted">Live updates use <code>GET /runs/:runId/events/stream</code> while this run is selected.</p><ul id="run-events">' + events.slice(-10).map((event) => '<li><span class="pill">' + escapeHtml(event.type) + '</span> ' + escapeHtml(event.summary) + '<br><span class="muted">' + escapeHtml(event.timestamp) + '</span></li>').join('') + '</ul>';
      detail.querySelector('[data-run-resume]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const promptText = window.prompt('Resume prompt for ' + run.id, 'Continue with verification.');
        if (!promptText) {
          status.textContent = 'Run resume cancelled for ' + run.id + '.';
          return;
        }
        button.disabled = true;
        try {
          status.textContent = 'Resuming run ' + run.id + '…';
          await postJson('/runs/' + encodeURIComponent(run.id) + '/resume', { prompt: promptText });
          await load();
          await loadRunDetail(run.id);
          status.textContent = 'Resumed run ' + run.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      detail.querySelector('[data-run-cancel]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const accepted = window.confirm('Cancel run ' + run.id + '?');
        if (!accepted) {
          status.textContent = 'Run cancel skipped for ' + run.id + '.';
          return;
        }
        button.disabled = true;
        try {
          status.textContent = 'Cancelling run ' + run.id + '…';
          await postJson('/runs/' + encodeURIComponent(run.id) + '/cancel', {});
          await load();
          await loadRunDetail(run.id);
          status.textContent = 'Cancelled run ' + run.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      detail.querySelector('[data-cleanup-preview]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          status.textContent = 'Loading cleanup preview for ' + run.id + '…';
          await loadRunDetail(run.id, true);
          status.textContent = 'Cleanup preview refreshed for ' + run.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      startRunEventStream(run.id);
      detail.querySelector('[data-cleanup-apply]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          status.textContent = 'Requesting cleanup confirmation for ' + run.id + '…';
          const confirmationPayload = await postJson('/runs/' + encodeURIComponent(run.id) + '/workspace-cleanup/apply', { confirm: '' });
          const expectedConfirmation = confirmationPayload.expectedConfirmation;
          const accepted = window.confirm('Apply workspace cleanup for ' + run.id + '?\n\nServer confirmation phrase:\n' + expectedConfirmation);
          if (!accepted) {
            button.disabled = false;
            status.textContent = 'Workspace cleanup apply cancelled for ' + run.id + '.';
            return;
          }
          const applyPayload = await postJson('/runs/' + encodeURIComponent(run.id) + '/workspace-cleanup/apply', { confirm: expectedConfirmation });
          await loadRunDetail(run.id, true);
          status.textContent = 'Workspace cleanup ' + applyPayload.cleanupResult.status + ' for ' + run.id + '.';
        } catch (error) {
          button.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    }

    async function loadTrackDetail(trackId) {
      detail.className = 'muted';
      detail.textContent = 'Loading track ' + trackId + '…';
      const [trackPayload, specPayload, planPayload, tasksPayload] = await Promise.all([
        api('/tracks/' + encodeURIComponent(trackId)),
        api('/tracks/' + encodeURIComponent(trackId) + '/artifacts/spec'),
        api('/tracks/' + encodeURIComponent(trackId) + '/artifacts/plan'),
        api('/tracks/' + encodeURIComponent(trackId) + '/artifacts/tasks'),
      ]);
      renderTrackDetail(trackPayload, [['spec', specPayload], ['plan', planPayload], ['tasks', tasksPayload]]);
    }

    async function loadRunDetail(runId, includeCleanupPreview) {
      detail.className = 'muted';
      detail.textContent = 'Loading run ' + runId + '…';
      const [runPayload, eventsPayload, cleanupPayload] = await Promise.all([
        api('/runs/' + encodeURIComponent(runId)),
        api('/runs/' + encodeURIComponent(runId) + '/events'),
        includeCleanupPreview ? api('/runs/' + encodeURIComponent(runId) + '/workspace-cleanup/preview').catch((error) => ({ cleanupPlan: { eligible: false, operations: [], refusalReasons: [error instanceof Error ? error.message : String(error)] } })) : Promise.resolve(null),
      ]);
      renderRunDetail(runPayload, eventsPayload, cleanupPayload);
    }

    async function load() {
      closeEventStream();
      status.textContent = 'Loading…';
      const projectId = scope.value;
      const query = projectId ? '&projectId=' + encodeURIComponent(projectId) : '';
      const [projectPayload, trackPayload, runPayload] = await Promise.all([
        api('/projects'),
        api('/tracks?page=1&pageSize=20' + query),
        api('/runs?page=1&pageSize=20'),
      ]);

      const selectedProject = scope.value;
      projectsById = new Map(projectPayload.projects.map((project) => [project.id, project]));
      scope.replaceChildren(new Option('All projects', ''), ...projectPayload.projects.map((project) => new Option(project.name + ' (' + project.id + ')', project.id)));
      scope.value = selectedProject;

      tracks.replaceChildren(...trackPayload.tracks.map((track) => item(
        track.title ?? track.id,
        track.id + ' · ' + (track.projectId ?? 'project?') + ' · ' + (track.status ?? 'unknown') + ' · ' + (track.priority ?? 'medium'),
        () => { loadTrackDetail(track.id).catch((error) => { detail.className = 'muted'; detail.textContent = error instanceof Error ? error.message : String(error); }); },
      )));
      runs.replaceChildren(...runPayload.runs.map((run) => item(
        run.id,
        run.trackId + ' · ' + (run.status ?? 'unknown') + ' · ' + (run.backend ?? 'backend?'),
        () => { loadRunDetail(run.id).catch((error) => { detail.className = 'muted'; detail.textContent = error instanceof Error ? error.message : String(error); }); },
      )));
      status.textContent = 'Loaded ' + projectPayload.projects.length + ' projects, ' + trackPayload.tracks.length + ' tracks, and ' + runPayload.runs.length + ' runs.';
    }

    projectCreate.addEventListener('click', async () => {
      const name = window.prompt('New project name');
      if (!name) {
        status.textContent = 'Project creation cancelled.';
        return;
      }
      projectCreate.disabled = true;
      try {
        status.textContent = 'Creating project ' + name + '…';
        const payload = await postJson('/projects', { name });
        scope.value = payload.project.id;
        await load();
        projectCreate.disabled = false;
        status.textContent = 'Created project ' + payload.project.id + '.';
      } catch (error) {
        projectCreate.disabled = false;
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });

    trackCreate.addEventListener('click', async () => {
      const title = window.prompt('New track title');
      if (!title) {
        status.textContent = 'Track creation cancelled.';
        return;
      }
      const description = window.prompt('New track description', '') ?? '';
      const priority = window.prompt('Track priority (low, medium, high)', 'medium') ?? 'medium';
      const projectId = scope.value || undefined;
      trackCreate.disabled = true;
      try {
        status.textContent = 'Creating track ' + title + '…';
        const payload = await postJson('/tracks', { projectId, title, description, priority });
        await load();
        await loadTrackDetail(payload.track.id);
        trackCreate.disabled = false;
        status.textContent = 'Created track ' + payload.track.id + '.';
      } catch (error) {
        trackCreate.disabled = false;
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });

    projectUpdate.addEventListener('click', async () => {
      const projectId = scope.value;
      if (!projectId) {
        status.textContent = 'Select a project before updating it.';
        return;
      }
      const currentProject = projectsById.get(projectId) ?? {};
      const currentLabel = scope.selectedOptions[0]?.textContent ?? projectId;
      const currentName = currentProject.name ?? currentLabel.replace(/ \([^)]*\)$/, '');
      const name = window.prompt('Updated project name for ' + projectId, currentName);
      if (!name) {
        status.textContent = 'Project update cancelled for ' + projectId + '.';
        return;
      }
      const repoUrlInput = window.prompt('Repository URL for ' + projectId + ' (blank clears)', currentProject.repoUrl ?? '');
      const localRepoPathInput = window.prompt('Local repository path for ' + projectId + ' (blank clears)', currentProject.localRepoPath ?? '');
      const workflowPolicyInput = window.prompt('Default workflow policy for ' + projectId + ' (blank clears)', currentProject.defaultWorkflowPolicy ?? '');
      const planningSystemInput = window.prompt('Default planning system for ' + projectId + ' (blank clears)', currentProject.defaultPlanningSystem ?? '');
      const optionalText = (value) => value === null ? undefined : value.trim() === '' ? null : value.trim();
      projectUpdate.disabled = true;
      try {
        status.textContent = 'Updating project ' + projectId + '…';
        const payload = await patchJson('/projects/' + encodeURIComponent(projectId), {
          name,
          repoUrl: optionalText(repoUrlInput),
          localRepoPath: optionalText(localRepoPathInput),
          defaultWorkflowPolicy: optionalText(workflowPolicyInput),
          defaultPlanningSystem: optionalText(planningSystemInput),
        });
        scope.value = payload.project.id;
        await load();
        projectUpdate.disabled = false;
        status.textContent = 'Updated project ' + payload.project.id + '.';
      } catch (error) {
        projectUpdate.disabled = false;
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });

    scope.addEventListener('change', load);
    refresh.addEventListener('click', load);
    load().catch((error) => { status.textContent = error instanceof Error ? error.message : String(error); });
  </script>
</body>
</html>`;
}
