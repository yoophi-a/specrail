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

export function operatorUiRunReportPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/report.md`;
}

export function renderOperatorUiStyleCss(): string {
  return `:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 2rem; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; display: grid; gap: 1rem; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 1.75rem; }
    section { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 0.75rem; padding: 1rem; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; }
    label { display: grid; gap: 0.35rem; font-weight: 600; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; align-items: end; }
    select, input, textarea, button { font: inherit; padding: 0.5rem 0.65rem; border-radius: 0.5rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
    input, textarea { background: Canvas; color: CanvasText; }
    textarea { min-height: 5rem; resize: vertical; }
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
`;
}

export function renderOperatorUiClientScript(): string {
  return `const scope = document.querySelector('#project-scope');
    const status = document.querySelector('#status');
    const tracks = document.querySelector('#tracks');
    const runs = document.querySelector('#runs');
    const detail = document.querySelector('#detail');
    const refresh = document.querySelector('#refresh');
    const projectCreate = document.querySelector('#project-create');
    const projectUpdate = document.querySelector('#project-update');
    const trackCreate = document.querySelector('#track-create');
    const projectName = document.querySelector('#project-name');
    const projectRepoUrl = document.querySelector('#project-repo-url');
    const projectLocalRepoPath = document.querySelector('#project-local-repo-path');
    const projectWorkflowPolicy = document.querySelector('#project-workflow-policy');
    const projectPlanningSystem = document.querySelector('#project-planning-system');
    const trackTitle = document.querySelector('#track-title');
    const trackDescription = document.querySelector('#track-description');
    const trackPriority = document.querySelector('#track-priority');
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

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    async function withAction(button, inFlightText, action, successText) {
      button.disabled = true;
      status.textContent = inFlightText;
      try {
        const result = await action();
        if (successText !== undefined) {
          status.textContent = typeof successText === 'function' ? successText(result) : successText;
        }
        if (button.isConnected) {
          button.disabled = false;
        }
        return result;
      } catch (error) {
        if (button.isConnected) {
          button.disabled = false;
        }
        status.textContent = errorMessage(error);
        return undefined;
      }
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

    function option(value, label, selectedValue) {
      return '<option value="' + escapeHtml(value) + '"' + (value === selectedValue ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }

    function optionalInputValue(input) {
      return input.value.trim() === '' ? undefined : input.value.trim();
    }

    function optionalNullableInputValue(input) {
      return input.value.trim() === '' ? null : input.value.trim();
    }

    function populateProjectForm(projectId) {
      const project = projectsById.get(projectId) ?? {};
      projectName.value = project.name ?? '';
      projectRepoUrl.value = project.repoUrl ?? '';
      projectLocalRepoPath.value = project.localRepoPath ?? '';
      projectWorkflowPolicy.value = project.defaultWorkflowPolicy ?? '';
      projectPlanningSystem.value = project.defaultPlanningSystem ?? '';
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
        + '<h3>Track workflow</h3><div class="form-grid" data-control-group="track-workflow"><label>Status <select id="track-workflow-status">' + ['new', 'planned', 'ready', 'in_progress', 'blocked', 'review', 'done', 'failed'].map((value) => option(value, value, track.status ?? 'new')).join('') + '</select></label><label>Spec approval <select id="track-workflow-spec-status">' + ['draft', 'pending', 'approved', 'rejected'].map((value) => option(value, value, track.specStatus ?? 'draft')).join('') + '</select></label><label>Plan approval <select id="track-workflow-plan-status">' + ['draft', 'pending', 'approved', 'rejected'].map((value) => option(value, value, track.planStatus ?? 'draft')).join('') + '</select></label><p><button data-track-update="workflow">Update track workflow</button></p></div>'
        + '<h3>Planning</h3><div class="form-grid" data-control-group="track-planning"><label>Session status <select id="planning-session-status"><option value="active">active</option><option value="waiting_user">waiting_user</option><option value="waiting_agent">waiting_agent</option><option value="approved">approved</option><option value="archived">archived</option></select></label><p><button data-planning-session-create="' + escapeHtml(track.id) + '">Create planning session</button></p><label>Author <select id="planning-message-author"><option value="user">user</option><option value="agent">agent</option><option value="system">system</option></select></label><label>Kind <select id="planning-message-kind"><option value="message">message</option><option value="question">question</option><option value="decision">decision</option><option value="note">note</option></select></label><label>Related artifact <select id="planning-message-artifact"><option value="">none</option><option value="spec">spec</option><option value="plan">plan</option><option value="tasks">tasks</option></select></label><label>Message <textarea id="planning-message-body" placeholder="Planning message"></textarea></label><p><button data-planning-message-append="' + escapeHtml(planning.planningSessionId ?? '') + '">Append planning message</button></p></div>'
        + '<h3>Artifact proposals</h3><div class="form-grid" data-control-group="artifact-proposal"><label>Artifact <select id="artifact-proposal-kind"><option value="spec">spec</option><option value="plan">plan</option><option value="tasks">tasks</option></select></label><label>Summary <input id="artifact-proposal-summary" value="Proposed from hosted operator UI" /></label><label>Content <textarea id="artifact-proposal-content" placeholder="New artifact content"></textarea></label><p><button data-artifact-proposal="inline">Propose artifact</button></p></div>'
        + '<h3>Run lifecycle</h3><div class="form-grid" data-control-group="track-run-start"><label>Run prompt <textarea id="run-start-prompt">Implement the selected track.</textarea></label><p><button data-run-start="' + escapeHtml(track.id) + '">Start run</button></p></div>'
        + artifactApprovalActions(artifactPayloads)
        + preview('Spec preview', payload.artifacts?.spec)
        + preview('Plan preview', payload.artifacts?.plan)
        + preview('Tasks preview', payload.artifacts?.tasks);
      detail.querySelector('[data-track-update]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const statusInput = detail.querySelector('#track-workflow-status')?.value || 'new';
        const specStatusInput = detail.querySelector('#track-workflow-spec-status')?.value || undefined;
        const planStatusInput = detail.querySelector('#track-workflow-plan-status')?.value || undefined;
        await withAction(button, 'Updating track ' + track.id + '…', async () => {
          await patchJson('/tracks/' + encodeURIComponent(track.id), {
            status: statusInput,
            specStatus: specStatusInput,
            planStatus: planStatusInput,
          });
          await load();
          await loadTrackDetail(track.id);
        }, 'Updated track ' + track.id + '.');
      });
      detail.querySelector('[data-planning-session-create]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const planningStatus = detail.querySelector('#planning-session-status')?.value || 'active';
        await withAction(button, 'Creating planning session for ' + track.id + '…', async () => {
          await postJson('/tracks/' + encodeURIComponent(track.id) + '/planning-sessions', { status: planningStatus });
          await loadTrackDetail(track.id);
        }, 'Created planning session for ' + track.id + '.');
      });
      detail.querySelector('[data-planning-message-append]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const planningSessionId = button.getAttribute('data-planning-message-append');
        if (!planningSessionId) {
          status.textContent = 'Create a planning session before appending a message for ' + track.id + '.';
          return;
        }
        const body = detail.querySelector('#planning-message-body')?.value.trim();
        if (!body) {
          status.textContent = 'Planning message body is required for ' + track.id + '.';
          return;
        }
        const authorType = detail.querySelector('#planning-message-author')?.value || 'user';
        const kind = detail.querySelector('#planning-message-kind')?.value || 'message';
        const relatedArtifact = detail.querySelector('#planning-message-artifact')?.value || undefined;
        await withAction(button, 'Appending planning message for ' + track.id + '…', async () => {
          await postJson('/planning-sessions/' + encodeURIComponent(planningSessionId) + '/messages', { authorType, kind, body, relatedArtifact });
          await loadTrackDetail(track.id);
        }, 'Appended planning message for ' + track.id + '.');
      });
      detail.querySelectorAll('[data-artifact-proposal]').forEach((button) => {
        button.addEventListener('click', async () => {
          const artifact = detail.querySelector('#artifact-proposal-kind')?.value || 'spec';
          const content = detail.querySelector('#artifact-proposal-content')?.value.trim();
          if (!content) {
            status.textContent = 'Artifact proposal content is required for ' + artifact + '.';
            return;
          }
          const summaryText = detail.querySelector('#artifact-proposal-summary')?.value.trim() || undefined;
          await withAction(button, 'Proposing ' + artifact + ' revision for ' + track.id + '…', async () => {
            await postJson('/tracks/' + encodeURIComponent(track.id) + '/artifacts/' + artifact, { content, summary: summaryText, createdBy: 'user' });
            await loadTrackDetail(track.id);
          }, 'Proposed ' + artifact + ' revision for ' + track.id + '.');
        });
      });
      detail.querySelector('[data-run-start]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const promptText = detail.querySelector('#run-start-prompt')?.value.trim();
        if (!promptText) {
          status.textContent = 'Run start prompt is required for ' + track.id + '.';
          return;
        }
        await withAction(button, 'Starting run for ' + track.id + '…', async () => {
          const runPayload = await postJson('/runs', { trackId: track.id, prompt: promptText });
          await load();
          await loadRunDetail(runPayload.run.id);
          return runPayload;
        }, (runPayload) => 'Started run ' + runPayload.run.id + ' for ' + track.id + '.');
      });
      detail.querySelectorAll('[data-approval-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          const approvalId = button.getAttribute('data-approval-id');
          const decision = button.getAttribute('data-decision');
          await withAction(button, (decision === 'approve' ? 'Approving ' : 'Rejecting ') + approvalId + '…', async () => {
            await postJson('/approval-requests/' + encodeURIComponent(approvalId) + '/' + decision, { decidedBy: 'user', comment: 'decided from hosted operator UI' });
            await loadTrackDetail(track.id);
          }, 'Artifact approval ' + decision + ' completed for ' + approvalId + '.');
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
        ]) + '<button data-cleanup-preview="' + escapeHtml(run.id) + '">Refresh cleanup preview</button> <button data-cleanup-request="' + escapeHtml(run.id) + '"' + (cleanupPlan.eligible ? '' : ' disabled') + '>Request cleanup confirmation</button><div id="cleanup-confirm-panel" data-control-group="cleanup-confirmation" hidden><p class="muted">Server confirmation phrase: <code id="cleanup-expected-confirmation"></code></p><label>Confirmation <input id="cleanup-confirmation" autocomplete="off" placeholder="Paste server confirmation phrase" /></label><p><button data-cleanup-apply="' + escapeHtml(run.id) + '">Apply cleanup</button></p></div>'
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
        + '<h3>Run lifecycle</h3><div class="form-grid" data-control-group="run-lifecycle"><label>Resume prompt <textarea id="run-resume-prompt">Continue with verification.</textarea></label><label>Cancel confirmation <input id="run-cancel-confirmation" autocomplete="off" placeholder="Type cancel to confirm" /></label><p><button data-run-resume="' + escapeHtml(run.id) + '">Resume run</button> <button data-run-cancel="' + escapeHtml(run.id) + '">Cancel run</button></p></div>'
        + '<h3>Run report</h3><p data-control-group="run-report"><a data-run-report="' + escapeHtml(run.id) + '" href="/runs/' + encodeURIComponent(run.id) + '/report.md" target="_blank" rel="noopener">Open Markdown run report</a></p>'
        + cleanupSection
        + '<h3>Recent events</h3><p class="muted">Live updates use <code>GET /runs/:runId/events/stream</code> while this run is selected.</p><ul id="run-events">' + events.slice(-10).map((event) => '<li><span class="pill">' + escapeHtml(event.type) + '</span> ' + escapeHtml(event.summary) + '<br><span class="muted">' + escapeHtml(event.timestamp) + '</span></li>').join('') + '</ul>';
      detail.querySelector('[data-run-resume]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const promptText = detail.querySelector('#run-resume-prompt')?.value.trim();
        if (!promptText) {
          status.textContent = 'Run resume prompt is required for ' + run.id + '.';
          return;
        }
        await withAction(button, 'Resuming run ' + run.id + '…', async () => {
          await postJson('/runs/' + encodeURIComponent(run.id) + '/resume', { prompt: promptText });
          await load();
          await loadRunDetail(run.id);
        }, 'Resumed run ' + run.id + '.');
      });
      detail.querySelector('[data-run-cancel]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const confirmation = detail.querySelector('#run-cancel-confirmation')?.value.trim().toLowerCase();
        if (confirmation !== 'cancel') {
          status.textContent = 'Type cancel before cancelling run ' + run.id + '.';
          return;
        }
        await withAction(button, 'Cancelling run ' + run.id + '…', async () => {
          await postJson('/runs/' + encodeURIComponent(run.id) + '/cancel', {});
          await load();
          await loadRunDetail(run.id);
        }, 'Cancelled run ' + run.id + '.');
      });
      detail.querySelector('[data-cleanup-preview]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        await withAction(button, 'Loading cleanup preview for ' + run.id + '…', async () => {
          await loadRunDetail(run.id, true);
        }, 'Cleanup preview refreshed for ' + run.id + '.');
      });
      startRunEventStream(run.id);
      detail.querySelector('[data-cleanup-request]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        await withAction(button, 'Requesting cleanup confirmation for ' + run.id + '…', async () => {
          const confirmationPayload = await postJson('/runs/' + encodeURIComponent(run.id) + '/workspace-cleanup/apply', { confirm: '' });
          const expectedConfirmation = confirmationPayload.expectedConfirmation;
          detail.querySelector('#cleanup-expected-confirmation').textContent = expectedConfirmation;
          detail.querySelector('#cleanup-confirmation').value = '';
          detail.querySelector('#cleanup-confirm-panel').hidden = false;
        }, 'Cleanup confirmation phrase loaded for ' + run.id + '.');
      });
      detail.querySelector('[data-cleanup-apply]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const confirmation = detail.querySelector('#cleanup-confirmation')?.value.trim();
        if (!confirmation) {
          status.textContent = 'Cleanup confirmation phrase is required for ' + run.id + '.';
          return;
        }
        await withAction(button, 'Applying cleanup for ' + run.id + '…', async () => {
          const applyPayload = await postJson('/runs/' + encodeURIComponent(run.id) + '/workspace-cleanup/apply', { confirm: confirmation });
          const resultText = 'Workspace cleanup ' + applyPayload.cleanupResult.status + ' for ' + run.id + '.';
          status.textContent = resultText;
          try {
            await loadRunDetail(run.id, true);
            status.textContent = resultText;
          } catch (refreshError) {
            status.textContent = resultText + ' Refresh failed: ' + errorMessage(refreshError);
          }
        });
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
      populateProjectForm(selectedProject);

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
      const name = projectName.value.trim();
      if (!name) {
        status.textContent = 'Project name is required.';
        return;
      }
      await withAction(projectCreate, 'Creating project ' + name + '…', async () => {
        const payload = await postJson('/projects', {
          name,
          repoUrl: optionalInputValue(projectRepoUrl),
          localRepoPath: optionalInputValue(projectLocalRepoPath),
          defaultWorkflowPolicy: optionalInputValue(projectWorkflowPolicy),
          defaultPlanningSystem: optionalInputValue(projectPlanningSystem),
        });
        scope.value = payload.project.id;
        await load();
        return payload;
      }, (payload) => 'Created project ' + payload.project.id + '.');
    });

    trackCreate.addEventListener('click', async () => {
      const title = trackTitle.value.trim();
      if (!title) {
        status.textContent = 'Track title is required.';
        return;
      }
      const description = trackDescription.value.trim();
      const priority = trackPriority.value || 'medium';
      const projectId = scope.value || undefined;
      await withAction(trackCreate, 'Creating track ' + title + '…', async () => {
        const payload = await postJson('/tracks', { projectId, title, description, priority });
        await load();
        await loadTrackDetail(payload.track.id);
        trackTitle.value = '';
        trackDescription.value = '';
        trackPriority.value = 'medium';
        return payload;
      }, (payload) => 'Created track ' + payload.track.id + '.');
    });

    projectUpdate.addEventListener('click', async () => {
      const projectId = scope.value;
      if (!projectId) {
        status.textContent = 'Select a project before updating it.';
        return;
      }
      const name = projectName.value.trim();
      if (!name) {
        status.textContent = 'Project name is required before updating ' + projectId + '.';
        return;
      }
      await withAction(projectUpdate, 'Updating project ' + projectId + '…', async () => {
        const payload = await patchJson('/projects/' + encodeURIComponent(projectId), {
          name,
          repoUrl: optionalNullableInputValue(projectRepoUrl),
          localRepoPath: optionalNullableInputValue(projectLocalRepoPath),
          defaultWorkflowPolicy: optionalNullableInputValue(projectWorkflowPolicy),
          defaultPlanningSystem: optionalNullableInputValue(projectPlanningSystem),
        });
        scope.value = payload.project.id;
        await load();
        return payload;
      }, (payload) => 'Updated project ' + payload.project.id + '.');
    });

    scope.addEventListener('change', () => {
      populateProjectForm(scope.value);
      load().catch((error) => { status.textContent = errorMessage(error); });
    });
    refresh.addEventListener('click', () => {
      load().catch((error) => { status.textContent = errorMessage(error); });
    });
    load().catch((error) => { status.textContent = errorMessage(error); });
`;
}

export function renderOperatorUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SpecRail Operator</title>
  <style>
${renderOperatorUiStyleCss()}
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
      <div class="form-grid" data-control-group="project-form">
        <label>Project name <input id="project-name" autocomplete="off" placeholder="New or selected project" /></label>
        <label>Repo URL <input id="project-repo-url" autocomplete="off" placeholder="https://github.com/org/repo" /></label>
        <label>Local repo path <input id="project-local-repo-path" autocomplete="off" placeholder="/path/to/repo" /></label>
        <label>Workflow policy <input id="project-workflow-policy" autocomplete="off" placeholder="optional" /></label>
        <label>Planning system <input id="project-planning-system" autocomplete="off" placeholder="native | openspec | speckit" /></label>
        <p><button id="project-create">Create project</button> <button id="project-update">Update selected project</button></p>
      </div>
      <div class="form-grid" data-control-group="track-form">
        <label>Track title <input id="track-title" autocomplete="off" placeholder="New track title" /></label>
        <label>Track description <input id="track-description" autocomplete="off" placeholder="What should be done?" /></label>
        <label>Track priority
          <select id="track-priority"><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option></select>
        </label>
        <p><button id="track-create">Create track</button></p>
      </div>
      <p id="status" class="muted">Loading…</p>
    </section>
    <div class="grid">
      <section><h2>Tracks</h2><ul id="tracks"></ul></section>
      <section><h2>Runs</h2><ul id="runs"></ul></section>
    </div>
    <section><h2>Selected detail</h2><div id="detail" class="muted">Select a track or run.</div></section>
  </main>
  <script type="module">
${renderOperatorUiClientScript()}
  </script>
</body>
</html>`;
}
