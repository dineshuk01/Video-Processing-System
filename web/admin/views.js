/* ============================================================
   VideoStream Admin — pages: Dashboard, Videos, Processing Jobs,
   Logs, System and the preview player.
   Depends on common.js and app.js.
   ============================================================ */
(function () {
  const VF = window.VF;
  const { esc, formatBytes, formatDate, timeAgo, formatDuration, toast, confirmDialog, dialog, reconcile, copyText, icon } = VF;
  const store = VF.store;
  const MAX_ATTEMPTS = 3;
  const QUALITIES = [360, 480, 720, 1080];

  // ─── Shared helpers ────────────────────────────────────────
  const STATUS_LABEL = {
    PENDING: 'Pending', UPLOADING: 'Uploading', UPLOADED: 'Queued',
    PROCESSING: 'Processing', PAUSED: 'Paused', COMPLETED: 'Completed', FAILED: 'Failed',
  };
  const pill = (status) => `<span class="pill pill-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
  const titleOf = (v) => v.title || v.originalName;
  const qualityOf = (v) => (v.metadata && v.metadata.height ? `${v.metadata.height}p` : '—');
  const durationOf = (v) => (v.metadata && v.metadata.duration ? formatDuration(v.metadata.duration) : '—');
  const isActive = (v) => VF.ACTIVE_STATUSES.includes(v.status);
  const watchHref = (v) => (v.status === 'COMPLETED' ? `#/watch/${encodeURIComponent(v.id)}` : '#/jobs');
  // What processing actually produced. Before a video has been processed, show what was asked for.
  const requestedOf = (v) => (v.qualities && v.qualities.length ? v.qualities : [360, 480, 720, 1080]).map((q) => `${q}p`);
  const renditionsOf = (v) => (v.renditions && v.renditions.length
    ? v.renditions.join(', ')
    : v.status === 'COMPLETED' ? '—' : `${requestedOf(v).join(', ')} (planned)`);
  const skippedOf = (v) => (v.renditions && v.renditions.length ? requestedOf(v).filter((r) => !v.renditions.includes(r)) : []);
  // Size classes: a video reaches a class when it is at least that wide or that tall
  const CLASS_WIDTH = { 360: 640, 480: 854, 720: 1280, 1080: 1920 };
  const reachesClass = (v, q) => !v.metadata || !v.metadata.width
    || v.metadata.width >= CLASS_WIDTH[q] * 0.98 || v.metadata.height >= q * 0.98;

  const visibilityPill = (v) => (v.status !== 'COMPLETED'
    ? '<span class="muted">—</span>'
    : v.published ? '<span class="pill pill-COMPLETED">Published</span>' : '<span class="pill pill-PENDING">Draft</span>');

  const thumb = (v) => (v.thumbnailUrl
    ? `<img class="thumb" src="${esc(v.thumbnailUrl)}" alt="" loading="lazy" />`
    : `<span class="thumb thumb-empty">${icon('film', 18)}</span>`);

  // Phases follow the progress milestones in transcoderTask.ts
  function phaseOf(v) {
    const p = Math.round(v.progress || 0);
    if (v.status === 'PENDING' || v.status === 'UPLOADING') return 'Waiting for the upload to finish';
    if (v.status === 'UPLOADED') return 'In queue — waiting for a transcoder';
    if (v.status === 'PAUSED') return 'Paused — the original is kept';
    if (v.status !== 'PROCESSING') return STATUS_LABEL[v.status] || v.status;
    if (p < 10) return 'Preparing video';
    if (p <= 80) return 'Encoding resolutions';
    if (p < 91) return 'Creating thumbnail';
    return 'Publishing files';
  }

  // A broken thumbnail falls back to the placeholder instead of a broken-image icon
  document.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' && e.target.classList.contains('thumb')) {
      const span = document.createElement('span');
      span.className = 'thumb thumb-empty';
      span.innerHTML = icon('film', 18);
      e.target.replaceWith(span);
    }
  }, true);

  // Calls the admin API and returns its data, or throws an Error with the server's message
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.success) throw new Error(json?.error?.message || `Request failed (HTTP ${res.status})`);
    return json.data;
  }

  // ─── Actions ───────────────────────────────────────────────
  async function deleteVideo(id) {
    const video = store.videos[id];
    const ok = await confirmDialog({
      title: video && ['PROCESSING', 'UPLOADED'].includes(video.status) ? 'Stop and delete this video?' : 'Delete this video?',
      message: `"${video ? titleOf(video) : id}" and all of its files (the original and the processed versions) will be permanently removed.${video && ['PROCESSING', 'UPLOADED'].includes(video.status) ? ' Processing will be stopped.' : ''}${video && video.published ? ' It is published, so it will disappear from the public site.' : ''}`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    try {
      await api(`/api/admin/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      VF.removeVideo(id);
      VF.refreshOverview();
      toast('Video deleted', 'success');
      return true;
    } catch (err) {
      toast(`Failed to delete video: ${err.message}`, 'error');
      return false;
    }
  }

  async function setPublished(id, published) {
    try {
      const video = await api(`/api/admin/videos/${encodeURIComponent(id)}/publish`, { method: 'POST', body: { published } });
      store.videos = { ...store.videos, [id]: { ...store.videos[id], ...video } };
      store.emit('videos');
      VF.refreshOverview();
      toast(published ? 'Published to the public site' : 'Unpublished. It is now a draft.', 'success', 2500);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  async function retryVideo(id, qualities) {
    try {
      const video = await api(`/api/admin/videos/${encodeURIComponent(id)}/retry`, { method: 'POST', body: qualities ? { qualities } : {} });
      store.videos = { ...store.videos, [id]: { ...store.videos[id], ...video } };
      store.emit('videos');
      VF.refreshOverview();
      toast('Queued for processing again', 'success', 2500);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  const canRetry = (v) => ['FAILED', 'COMPLETED', 'PAUSED'].includes(v.status);
  const retryLabel = (v) => (v.status === 'FAILED' ? 'Retry processing' : v.status === 'PAUSED' ? 'Resume processing' : 'Reprocess');
  const canPause = (v) => v.status === 'PROCESSING' || v.status === 'UPLOADED';
  const canDeleteProcessed = (v) => ['COMPLETED', 'PAUSED', 'FAILED'].includes(v.status) && !!v.hlsPlaylistUrl;

  // Stops the running or queued job and holds the video. Resume starts again from the beginning.
  async function pauseVideo(id) {
    const video = store.videos[id];
    const ok = await confirmDialog({
      title: 'Pause processing?',
      message: `"${video ? titleOf(video) : id}" will stop processing now and be held, with the original upload kept. Resuming starts processing again from the beginning.`,
      confirmText: 'Pause',
    });
    if (!ok) return false;
    try {
      const updated = await api(`/api/admin/videos/${encodeURIComponent(id)}/pause`, { method: 'POST' });
      store.videos = { ...store.videos, [id]: { ...store.videos[id], ...updated } };
      store.emit('videos');
      VF.refreshOverview();
      toast('Paused. Processing is stopping.', 'success', 2500);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  // Remove the processed output only; the original upload stays so it can be processed again
  async function deleteProcessedFiles(id) {
    const video = store.videos[id];
    const ok = await confirmDialog({
      title: 'Delete the processed files?',
      message: `The processed (streaming) files of "${video ? titleOf(video) : id}" will be removed${video && video.published ? ' and it will disappear from the public site' : ''}. The original upload is kept, so you can process it again.`,
      confirmText: 'Delete processed files',
      danger: true,
    });
    if (!ok) return false;
    try {
      const updated = await api(`/api/admin/videos/${encodeURIComponent(id)}/delete-processed`, { method: 'POST' });
      store.videos = { ...store.videos, [id]: { ...store.videos[id], ...updated } };
      store.emit('videos');
      VF.refreshOverview();
      toast('Processed files deleted. The original is kept.', 'success', 3000);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  function rowMenu(anchor, video) {
    const items = [];
    if (video.status === 'COMPLETED') {
      items.push({ label: 'Preview', icon: 'play', onClick: () => { location.hash = watchHref(video); } });
      items.push(video.published
        ? { label: 'Unpublish', icon: 'x', onClick: () => setPublished(video.id, false) }
        : { label: 'Publish', icon: 'check', onClick: () => setPublished(video.id, true) });
      if (video.hlsPlaylistUrl) items.push({ label: 'Copy stream URL', icon: 'copy', onClick: () => copyText(new URL(video.hlsPlaylistUrl, location.origin).href, 'Stream URL copied') });
    } else {
      items.push({ label: 'View job & log', icon: 'eye', onClick: () => openJobDialog(video.id) });
    }
    if (canPause(video)) items.push({ label: 'Pause processing', icon: 'pause', onClick: () => pauseVideo(video.id) });
    if (canRetry(video)) items.push({ label: retryLabel(video), icon: 'refresh', onClick: () => retryVideo(video.id) });
    items.push({ label: 'Rename', icon: 'edit', onClick: () => openEditDialog(video.id, { focusTitle: true }) });
    items.push({ label: 'Edit settings', icon: 'settings', onClick: () => openEditDialog(video.id) });
    if (canDeleteProcessed(video)) items.push({ label: 'Delete processed files', icon: 'trash', danger: true, onClick: () => deleteProcessedFiles(video.id) });
    items.push({ label: ['PROCESSING', 'UPLOADED'].includes(video.status) ? 'Stop & delete' : 'Delete video', icon: 'trash', danger: true, onClick: () => deleteVideo(video.id) });
    VF.menu(anchor, items);
  }

  // Quick buttons shown in table rows: pause/resume/retry and delete without opening a menu
  function quickActions(v) {
    const id = esc(v.id);
    const buttons = [];
    if (canPause(v)) buttons.push(`<button class="btn btn-ghost btn-sm" data-pause="${id}">${icon('pause', 13)} Pause</button>`);
    else if (v.status === 'PAUSED') buttons.push(`<button class="btn btn-primary btn-sm" data-retry="${id}">${icon('play', 13)} Resume</button>`);
    else if (v.status === 'FAILED') buttons.push(`<button class="btn btn-primary btn-sm" data-retry="${id}">${icon('refresh', 13)} Retry</button>`);
    buttons.push(`<button class="btn btn-ghost btn-sm btn-danger-text" data-delete="${id}" aria-label="Delete ${esc(titleOf(v))}">${icon('trash', 13)} Delete</button>`);
    return buttons.join(' ');
  }

  // One click handler for the quick buttons, shared by the Videos and Jobs tables
  function handleQuickActions(e) {
    const pause = e.target.closest('[data-pause]');
    const retry = e.target.closest('[data-retry]');
    const del = e.target.closest('[data-delete]');
    const job = e.target.closest('[data-job]');
    if (pause) { pauseVideo(pause.dataset.pause); return true; }
    if (retry) { retryVideo(retry.dataset.retry); return true; }
    if (del) { deleteVideo(del.dataset.delete); return true; }
    if (job) { openJobDialog(job.dataset.job); return true; }
    return false;
  }

  // Clicking a row opens it, unless the click was on a button or link inside it
  function rowNavigation(tbody) {
    tbody.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input')) return;
      const row = e.target.closest('tr[data-href]');
      if (row) location.hash = row.dataset.href;
    });
  }

  function skeletonRows(cols, n = 4) {
    return Array.from({ length: n }, () => `<tr class="sk-row">${Array.from({ length: cols }, () => '<td><span class="sk-line"></span></td>').join('')}</tr>`).join('');
  }

  const kv = (label, value) => `<div class="kv"><span>${esc(label)}</span><span>${value}</span></div>`;

  // ─── Edit settings dialog ──────────────────────────────────
  function openEditDialog(id, { focusTitle = false } = {}) {
    const v = store.videos[id];
    if (!v) return;
    const selected = v.qualities && v.qualities.length ? v.qualities : QUALITIES;
    const modal = dialog({
      title: 'Video settings',
      html: `
        <form id="edit-form" class="edit-form">
          <label class="field"><span>Title</span>
            <input class="input" name="title" maxlength="120" value="${esc(v.title || '')}" placeholder="${esc(v.originalName)}" />
            <small>Shown on the public site. Leave empty to use the file name.</small></label>
          <fieldset class="field"><legend>Output qualities</legend>
            ${QUALITIES.map((q) => `<label class="check"><input type="checkbox" name="quality" value="${q}" ${selected.includes(q) ? 'checked' : ''} /> ${q}p${reachesClass(v, q) ? '' : ' <span class="muted">— larger than the source, needs upscaling</span>'}</label>`).join('')}
            <small>Applied the next time this video is processed.${v.metadata ? ` The source is ${esc(v.metadata.width)}×${esc(v.metadata.height)}.` : ''}</small></fieldset>
          <label class="check"><input type="checkbox" name="allowUpscale" ${v.allowUpscale ? 'checked' : ''} /> Also create sizes larger than the source</label>
          <small class="muted">Upscaled sizes add no real detail, take longer to encode and use more storage.</small>
          <label class="check"><input type="checkbox" name="autoPublish" ${v.autoPublish ? 'checked' : ''} /> Publish automatically when processing finishes</label>
          <div class="alert-box hidden" id="edit-error"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
            ${canRetry(v) ? '<button type="button" class="btn btn-ghost" id="save-reprocess">Save &amp; reprocess</button>' : ''}
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>`,
    });
    const form = modal.el.querySelector('#edit-form');
    const errBox = modal.el.querySelector('#edit-error');
    if (focusTitle) { form.title.focus(); form.title.select(); }
    const read = () => ({
      title: form.title.value.trim(),
      qualities: [...form.querySelectorAll('input[name="quality"]:checked')].map((el) => Number(el.value)),
      autoPublish: form.autoPublish.checked,
      allowUpscale: form.allowUpscale.checked,
    });
    async function save(reprocess) {
      const values = read();
      errBox.classList.add('hidden');
      if (values.qualities.length === 0) { errBox.textContent = 'Choose at least one quality.'; errBox.classList.remove('hidden'); return; }
      try {
        const updated = await api(`/api/admin/videos/${encodeURIComponent(id)}`, { method: 'PATCH', body: values });
        store.videos = { ...store.videos, [id]: { ...store.videos[id], ...updated } };
        store.emit('videos');
        if (reprocess) await retryVideo(id, values.qualities);
        else if (values.title !== (v.title || '')) toast('Renamed. The new title shows on the public site within a few seconds.', 'success', 3500);
        else toast('Settings saved', 'success', 2200);
        modal.close();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
    const sr = modal.el.querySelector('#save-reprocess');
    if (sr) sr.addEventListener('click', () => save(true));
  }

  // ─── Job details + processing log dialog ───────────────────
  function logLinesHtml(events) {
    if (!events.length) return '<p class="muted">No log lines yet.</p>';
    return `<ul class="log-list">${events.map((e) => `
      <li class="log-${esc(e.level)}"><span class="log-time">${esc(new Date(e.at).toLocaleTimeString())}</span>
        <span class="lvl lvl-${esc(e.level)}">${esc(e.level)}</span><span class="log-msg">${esc(e.message)}</span></li>`).join('')}</ul>`;
  }

  async function openJobDialog(id) {
    const v = store.videos[id];
    if (!v) return;
    const started = v.processingStartedAt || v.createdAt;
    const modal = dialog({
      title: titleOf(v),
      wide: true,
      html: `
        ${kv('Job ID', `<code>${esc(v.id)}</code>`)}
        ${kv('Status', pill(v.status))}
        ${kv('Progress', `${Math.round(v.status === 'COMPLETED' ? 100 : v.progress || 0)}% · ${esc(phaseOf(v))}`)}
        ${kv('Attempts', `${v.attempts || 0}${v.attempts ? ` (up to ${MAX_ATTEMPTS} per run)` : ''}`)}
        ${kv('Renditions made', esc(renditionsOf(v)))}
        ${skippedOf(v).length ? `<div class="alert-box">Not made: ${esc(skippedOf(v).join(', '))}. They are larger than the source${v.metadata ? ` (${esc(v.metadata.width)}×${esc(v.metadata.height)})` : ''}. To create them anyway, open <strong>Edit settings</strong>, tick <em>Also create sizes larger than the source</em> and reprocess.</div>` : ''}
        ${kv('Started', esc(formatDate(started)))}
        ${v.completedAt ? kv('Completed', esc(formatDate(v.completedAt))) : ''}
        ${v.failedAt ? kv('Failed', esc(formatDate(v.failedAt))) : ''}
        ${v.error ? `<div class="alert-box">${esc(v.error)}</div>` : ''}
        <h4 class="subhead">Processing log</h4>
        <div id="job-log"><p class="muted">Loading…</p></div>
        <div class="modal-actions">
          ${v.status === 'COMPLETED' ? `<a class="btn btn-ghost" href="#/watch/${encodeURIComponent(v.id)}" data-close>Preview</a>` : ''}
          ${canDeleteProcessed(v) ? '<button class="btn btn-ghost btn-danger-text" id="job-del-processed">Delete processed files</button>' : ''}
          <button class="btn btn-ghost btn-danger-text" id="job-delete">${['PROCESSING', 'UPLOADED'].includes(v.status) ? 'Stop &amp; delete' : 'Delete video'}</button>
          ${canPause(v) ? `<button class="btn btn-ghost" id="job-pause">${icon('pause', 15)} Pause</button>` : ''}
          ${canRetry(v) ? `<button class="btn btn-primary" id="job-retry">${icon(v.status === 'PAUSED' ? 'play' : 'refresh', 15)} ${retryLabel(v)}</button>` : ''}
          <button class="btn btn-ghost" data-close>Close</button>
        </div>`,
    });
    const retry = modal.el.querySelector('#job-retry');
    if (retry) retry.addEventListener('click', async () => { if (await retryVideo(id)) modal.close(); });
    const bind = (sel, fn) => { const el = modal.el.querySelector(sel); if (el) el.addEventListener('click', async () => { if (await fn(id)) modal.close(); }); };
    bind('#job-pause', pauseVideo);
    bind('#job-delete', deleteVideo);
    bind('#job-del-processed', deleteProcessedFiles);
    try {
      const data = await api(`/api/admin/videos/${encodeURIComponent(id)}/logs`);
      const target = modal.el.querySelector('#job-log');
      if (target) target.innerHTML = logLinesHtml(data.events);
    } catch (err) {
      const target = modal.el.querySelector('#job-log');
      if (target) target.innerHTML = `<div class="alert-box">${esc(err.message)}</div>`;
    }
  }

  // ═════════════════════════════════════════════════════════
  // Dashboard
  // ═════════════════════════════════════════════════════════
  VF.views.dashboard = {
    title: () => 'Dashboard',
    mount(root) {
      root.innerHTML = `
        <div class="page-head"><h1>Dashboard</h1><p>Uploads, processing and publishing at a glance.</p></div>

        <section class="stat-grid" aria-label="Summary">
          <div class="stat-card"><span class="stat-ico ico-blue">${icon('film', 20)}</span><div><div class="stat-label">Videos</div><div class="stat-value" id="s-total">0</div><div class="stat-sub" id="s-total-sub"></div></div></div>
          <div class="stat-card"><span class="stat-ico ico-green">${icon('eye', 20)}</span><div><div class="stat-label">Published</div><div class="stat-value" id="s-pub">0</div><div class="stat-sub muted-sub" id="s-pub-sub"></div></div></div>
          <div class="stat-card"><span class="stat-ico ico-orange">${icon('clock', 20)}</span><div><div class="stat-label">In progress</div><div class="stat-value" id="s-prog">0</div><div class="stat-sub muted-sub" id="s-prog-sub"></div></div></div>
          <div class="stat-card"><span class="stat-ico ico-red">${icon('alert', 20)}</span><div><div class="stat-label">Failed</div><div class="stat-value" id="s-fail">0</div><div class="stat-sub" id="s-fail-sub"></div></div></div>
        </section>

        <div class="two-col">
          <section class="card"><div class="card-head"><h2 class="card-title">Processing engine</h2><a class="link-btn" href="#/system">Details ${icon('forward', 14)}</a></div><div id="engine"></div></section>
          <section class="card"><div class="card-head"><h2 class="card-title">Job queue</h2><a class="link-btn" href="#/jobs">All jobs ${icon('forward', 14)}</a></div><div id="queue"></div></section>
        </div>

        <section class="card hidden" id="attention">
          <div class="card-head"><h2 class="card-title">Needs attention</h2></div>
          <div id="attention-list"></div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title">Recent videos</h2><a class="link-btn" href="#/videos">View all ${icon('forward', 14)}</a></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Video</th><th>Status</th><th>Visibility</th><th>Duration</th><th>Uploaded</th></tr></thead>
            <tbody id="recent"></tbody></table></div>
          <div class="empty hidden" id="recent-empty"></div>
        </section>`;

      const tbody = root.querySelector('#recent');
      const empty = root.querySelector('#recent-empty');
      rowNavigation(tbody);
      tbody.innerHTML = skeletonRows(5, 3);
      const set = (id, text) => { root.querySelector(`#${id}`).textContent = text; };

      function render() {
        const o = store.overview;
        if (o) {
          set('s-total', o.totals.videos);
          set('s-total-sub', `+${o.totals.uploadedToday} in the last 24 h · ${formatBytes(o.totals.storageBytes)}`);
          set('s-pub', o.totals.published);
          set('s-pub-sub', `${o.totals.drafts} draft${o.totals.drafts === 1 ? '' : 's'} ready to publish`);
          set('s-prog', o.totals.inProgress);
          set('s-prog-sub', [o.retrying ? `${o.retrying} being retried` : 'no retries', o.totals.paused ? `${o.totals.paused} paused` : ''].filter(Boolean).join(' · '));
          set('s-fail', o.totals.failed);
          set('s-fail-sub', o.totals.failed ? 'needs your attention' : 'none');
          root.querySelector('#s-fail-sub').classList.toggle('bad', o.totals.failed > 0);

          const c = o.compute;
          root.querySelector('#engine').innerHTML = `
            ${kv('Engine', esc(c.engine))}
            ${kv('Running now', `<strong>${c.running}</strong> job${c.running === 1 ? '' : 's'}`)}
            ${c.available ? '' : `<div class="alert-box">Could not read the engine status: ${esc(c.error || 'unknown error')}</div>`}
            ${(c.tasks || []).map((t) => kv(`Task ${t.id.slice(0, 8)}`, `${esc(t.status)}${t.startedAt ? ` · started ${esc(timeAgo(t.startedAt))}` : ''}`)).join('')}`;

          const q = o.queue;
          root.querySelector('#queue').innerHTML = q.available === false
            ? `<div class="alert-box">Could not read the queue: ${esc(q.error || 'unknown error')}</div>`
            : `<div class="metrics">
                <div><strong>${q.waiting}</strong><span>Waiting</span></div>
                <div><strong>${q.inFlight}</strong><span>In flight</span></div>
                <div><strong>${q.delayed}</strong><span>Delayed (retry)</span></div></div>
              ${(q.jobs || []).slice(0, 4).map((j) => {
                const v = store.videos[j.videoId];
                return kv(esc(v ? titleOf(v) : j.videoId), `${esc(j.state)}${j.retryCount ? ` · retry ${j.retryCount}` : ''}`);
              }).join('')}`;
        }

        if (!store.loaded) return;
        const all = store.list();
        if (tbody.querySelector('.sk-row')) tbody.innerHTML = '';

        const failed = all.filter((v) => v.status === 'FAILED');
        root.querySelector('#attention').classList.toggle('hidden', failed.length === 0);
        root.querySelector('#attention-list').innerHTML = failed.slice(0, 5).map((v) => `
          <div class="attn-row"><div><div class="cell-title">${esc(titleOf(v))}</div><div class="cell-sub err-text">${esc(v.error || 'Processing failed')}</div></div>
          <div class="attn-actions"><button class="btn btn-ghost btn-sm" data-job="${esc(v.id)}">View log</button>
          <button class="btn btn-primary btn-sm" data-retry="${esc(v.id)}">${icon('refresh', 14)} Retry</button></div></div>`).join('');

        empty.classList.toggle('hidden', all.length > 0);
        empty.innerHTML = all.length ? '' : `${icon('film', 32)}<h3>No videos yet</h3><p>Upload your first video to get started.</p><a class="btn btn-primary" href="#/upload">Upload a video</a>`;
        reconcile(tbody, all.slice(0, 5), {
          key: (v) => v.id,
          html: (v) => `<tr class="clickable" data-href="${watchHref(v)}">
            <td><a class="name-cell" href="${watchHref(v)}">${thumb(v)}<span><span class="cell-title">${esc(titleOf(v))}</span>
              <span class="cell-sub">${esc(qualityOf(v))} • ${formatBytes(v.fileSize)}</span></span></a></td>
            <td>${pill(v.status)}${v.status === 'PROCESSING' ? ` <span class="pct">${Math.round(v.progress || 0)}%</span>` : ''}</td>
            <td>${visibilityPill(v)}</td><td>${durationOf(v)}</td>
            <td class="muted">${esc(timeAgo(v.createdAt))}</td></tr>`,
        });
      }

      root.querySelector('#attention').addEventListener('click', (e) => {
        const job = e.target.closest('[data-job]');
        const retry = e.target.closest('[data-retry]');
        if (job) openJobDialog(job.dataset.job);
        if (retry) retryVideo(retry.dataset.retry);
      });

      render();
      const unsub = store.subscribe((t) => { if (t.has('videos') || t.has('overview')) render(); });
      const tick = setInterval(render, 30000);
      return () => { unsub(); clearInterval(tick); };
    },
  };

  // ═════════════════════════════════════════════════════════
  // Videos (manage: publish, edit, reprocess, delete)
  // ═════════════════════════════════════════════════════════
  VF.views.videos = {
    title: () => 'Videos',
    mount(root) {
      let page = 1;
      root.innerHTML = `
        <div class="page-head"><h1>Videos</h1><p>Publish, edit, reprocess and delete your videos.</p></div>
        <section class="card">
          <div class="toolbar">
            <label class="field-search"><span class="sr-only">Search videos</span>${icon('search', 16)}
              <input type="search" id="v-search" placeholder="Search by title, file name or ID…" autocomplete="off" /></label>
            <label><span class="sr-only">Filter</span>
              <select id="v-status" class="select">
                <option value="all">All videos</option><option value="published">Published</option>
                <option value="draft">Drafts</option><option value="active">In progress</option><option value="PAUSED">Paused</option><option value="FAILED">Failed</option>
              </select></label>
          </div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Video</th><th>Status</th><th>Visibility</th><th>Renditions</th><th>Duration</th><th>Uploaded</th><th class="right">Actions</th></tr></thead>
            <tbody id="rows"></tbody></table></div>
          <div class="empty hidden" id="empty"></div>
          <div class="pager hidden" id="pager"><span id="range"></span>
            <div><button class="btn btn-ghost btn-sm" id="prev">Previous</button> <button class="btn btn-ghost btn-sm" id="next">Next</button></div></div>
        </section>`;

      const search = root.querySelector('#v-search');
      const status = root.querySelector('#v-status');
      const tbody = root.querySelector('#rows');
      const empty = root.querySelector('#empty');
      const pager = root.querySelector('#pager');
      search.value = store.ui.search;
      status.value = store.ui.status;
      rowNavigation(tbody);
      tbody.innerHTML = skeletonRows(7, 4);

      const matches = (v) => {
        const { search: q, status: s } = store.ui;
        if (s === 'published' && !(v.published && v.status === 'COMPLETED')) return false;
        if (s === 'draft' && !(!v.published && v.status === 'COMPLETED')) return false;
        if (s === 'active' && !isActive(v)) return false;
        if (s === 'FAILED' && v.status !== 'FAILED') return false;
        if (s === 'PAUSED' && v.status !== 'PAUSED') return false;
        if (q) {
          const needle = q.toLowerCase();
          if (!titleOf(v).toLowerCase().includes(needle) && !v.originalName.toLowerCase().includes(needle) && !v.id.toLowerCase().includes(needle)) return false;
        }
        return true;
      };

      function render() {
        if (!store.loaded) return;
        if (tbody.querySelector('.sk-row')) tbody.innerHTML = '';
        const all = store.list();
        const filtered = all.filter(matches);
        const size = VF.config.pageSize;
        const pages = Math.max(1, Math.ceil(filtered.length / size));
        page = Math.min(page, pages);
        const from = (page - 1) * size;
        const slice = filtered.slice(from, from + size);

        reconcile(tbody, slice, {
          key: (v) => v.id,
          html: (v) => `<tr class="clickable" data-href="${watchHref(v)}">
            <td><a class="name-cell" href="${watchHref(v)}">${thumb(v)}<span><span class="cell-title">${esc(titleOf(v))}</span>
              <span class="cell-sub">${v.title ? `${esc(v.originalName)} • ` : ''}${formatBytes(v.fileSize)}</span></span></a></td>
            <td>${pill(v.status)}${v.status === 'PROCESSING' ? ` <span class="pct">${Math.round(v.progress || 0)}%</span>` : ''}</td>
            <td>${v.status === 'COMPLETED'
              ? `<button class="switch-btn ${v.published ? 'on' : ''}" role="switch" aria-checked="${!!v.published}" data-publish="${esc(v.id)}" data-to="${!v.published}" aria-label="${v.published ? 'Unpublish' : 'Publish'} ${esc(titleOf(v))}"><span class="knob"></span></button> <span class="switch-label">${v.published ? 'Published' : 'Draft'}</span>`
              : '<span class="muted">—</span>'}</td>
            <td class="muted">${esc(renditionsOf(v))}</td><td>${durationOf(v)}</td>
            <td class="muted">${esc(timeAgo(v.createdAt))}</td>
            <td class="right nowrap">${quickActions(v)} <button class="icon-btn" data-menu-anchor data-id="${esc(v.id)}" aria-label="More actions for ${esc(titleOf(v))}" aria-haspopup="menu">${icon('dots', 18)}</button></td></tr>`,
        });

        const none = filtered.length === 0;
        empty.classList.toggle('hidden', !none);
        if (none) {
          empty.innerHTML = all.length === 0
            ? `${icon('film', 32)}<h3>No videos yet</h3><p>Upload a video to get started.</p><a class="btn btn-primary" href="#/upload">Upload a video</a>`
            : `${icon('search', 32)}<h3>No matching videos</h3><p>Try a different search or filter.</p><button class="btn btn-ghost" id="clear">Clear filters</button>`;
        }
        pager.classList.toggle('hidden', filtered.length <= size);
        root.querySelector('#range').textContent = `Showing ${from + 1}–${from + slice.length} of ${filtered.length}`;
        root.querySelector('#prev').disabled = page <= 1;
        root.querySelector('#next').disabled = page >= pages;
      }

      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { store.ui.search = search.value.trim(); page = 1; store.emit('ui'); }, 150);
      });
      status.addEventListener('change', () => { store.ui.status = status.value; page = 1; render(); });
      root.querySelector('#prev').addEventListener('click', () => { page--; render(); });
      root.querySelector('#next').addEventListener('click', () => { page++; render(); });
      empty.addEventListener('click', (e) => {
        if (e.target.id !== 'clear') return;
        store.ui.search = ''; store.ui.status = 'all';
        search.value = ''; status.value = 'all';
        store.emit('ui');
      });
      tbody.addEventListener('click', (e) => {
        if (handleQuickActions(e)) return;
        const toggle = e.target.closest('[data-publish]');
        if (toggle) { setPublished(toggle.dataset.publish, toggle.dataset.to === 'true'); return; }
        const btn = e.target.closest('[data-menu-anchor]');
        if (btn && store.videos[btn.dataset.id]) rowMenu(btn, store.videos[btn.dataset.id]);
      });

      render();
      const unsub = store.subscribe((t) => {
        if (t.has('ui') && document.activeElement !== search) search.value = store.ui.search;
        if (t.has('videos') || t.has('ui')) { if (t.has('ui')) page = 1; render(); }
      });
      const tick = setInterval(render, 30000);
      return () => { unsub(); clearInterval(tick); };
    },
  };

  // ═════════════════════════════════════════════════════════
  // Processing Jobs
  // ═════════════════════════════════════════════════════════
  let jobsTab = 'all';

  VF.views.jobs = {
    title: () => 'Processing Jobs',
    mount(root) {
      root.innerHTML = `
        <div class="page-head"><h1>Processing Jobs</h1><p>Monitor transcoding, retries and failures.</p></div>
        <section class="card">
          <div class="tabs" role="tablist" id="job-tabs"></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>ID</th><th>Video</th><th>Status</th><th>Attempts</th><th>Progress</th><th>Started</th><th class="right">Actions</th></tr></thead>
            <tbody id="jobs"></tbody></table></div>
          <div class="empty hidden" id="jobs-empty"></div>
        </section>`;
      const tbody = root.querySelector('#jobs');
      const empty = root.querySelector('#jobs-empty');
      const tabsEl = root.querySelector('#job-tabs');
      tbody.innerHTML = skeletonRows(7, 4);

      const TABS = [['all', 'All'], ['active', 'In progress'], ['PAUSED', 'Paused'], ['FAILED', 'Failed'], ['COMPLETED', 'Completed']];
      const inTab = (v, tab) => tab === 'all' || (tab === 'active' ? isActive(v) : v.status === tab);

      function progressCell(v) {
        const done = v.status === 'COMPLETED';
        const waiting = ['PENDING', 'UPLOADING', 'UPLOADED'].includes(v.status);
        const pct = done ? 100 : waiting ? 0 : Math.round(v.progress || 0);
        if (v.status === 'PAUSED') return '<span class="muted">Paused</span>';
        const cls = done ? 'bar-ok' : v.status === 'FAILED' ? 'bar-bad' : '';
        return `<div class="prog"><span class="pct">${waiting ? 'Queued' : `${pct}%`}</span>
          <div class="progress ${waiting ? 'indeterminate' : ''}"><div class="progress-bar ${cls}" style="width:${waiting ? 35 : pct}%"></div></div></div>`;
      }

      function render() {
        if (!store.loaded) return;
        if (tbody.querySelector('.sk-row')) tbody.innerHTML = '';
        const all = store.list();
        tabsEl.innerHTML = TABS.map(([key, label]) => {
          const n = all.filter((v) => inTab(v, key)).length;
          return `<button role="tab" class="tab ${jobsTab === key ? 'active' : ''}" aria-selected="${jobsTab === key}" data-tab="${key}">${label}<span class="tab-count">${n}</span></button>`;
        }).join('');
        const list = all.filter((v) => inTab(v, jobsTab));
        reconcile(tbody, list, {
          key: (v) => v.id,
          html: (v) => `<tr>
            <td><code class="job-id">${esc(v.id.slice(0, 8))}</code></td>
            <td><span class="cell-title">${esc(titleOf(v))}</span><span class="cell-sub">${esc(phaseOf(v))}${v.status !== 'FAILED' && v.error ? ' · retrying' : ''}</span></td>
            <td>${pill(v.status)}</td>
            <td>${v.attempts || 0}</td>
            <td>${progressCell(v)}</td>
            <td class="muted">${esc(timeAgo(v.processingStartedAt || v.createdAt))}</td>
            <td class="right nowrap"><button class="btn btn-ghost btn-sm" data-job="${esc(v.id)}">Log</button> ${quickActions(v)}</td></tr>`,
        });
        empty.classList.toggle('hidden', list.length > 0);
        empty.innerHTML = list.length ? '' : `${icon('jobs', 32)}<h3>No jobs here</h3><p>${jobsTab === 'all' ? 'Upload a video to create a job.' : 'Nothing matches this tab right now.'}</p>`;
      }

      tabsEl.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { jobsTab = tab.dataset.tab; render(); }
      });
      tbody.addEventListener('click', handleQuickActions);

      render();
      const unsub = store.subscribe((t) => { if (t.has('videos')) render(); });
      const tick = setInterval(render, 30000);
      return () => { unsub(); clearInterval(tick); };
    },
  };

  // ═════════════════════════════════════════════════════════
  // Logs
  // ═════════════════════════════════════════════════════════
  VF.views.logs = {
    title: () => 'Logs',
    mount(root) {
      root.innerHTML = `
        <div class="page-head"><h1>Logs</h1><p>Processing activity across all videos, newest first.</p></div>
        <section class="card">
          <div class="toolbar">
            <label class="field-search"><span class="sr-only">Search logs</span>${icon('search', 16)}
              <input type="search" id="l-search" placeholder="Search messages or video names…" autocomplete="off" /></label>
            <label><span class="sr-only">Level</span>
              <select id="l-level" class="select"><option value="">All levels</option><option value="error">Errors</option><option value="warn">Warnings</option><option value="info">Info</option></select></label>
            <button class="btn btn-ghost" id="l-refresh">${icon('refresh', 15)} Refresh</button>
          </div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Time</th><th>Level</th><th>Video</th><th>Message</th></tr></thead>
            <tbody id="log-rows"></tbody></table></div>
          <div class="empty hidden" id="log-empty"></div>
          <p class="opt-note" id="log-note"></p>
        </section>`;

      const tbody = root.querySelector('#log-rows');
      const empty = root.querySelector('#log-empty');
      const search = root.querySelector('#l-search');
      const level = root.querySelector('#l-level');
      let lines = [];
      let loaded = false;
      tbody.innerHTML = skeletonRows(4, 5);

      async function load() {
        try {
          const params = new URLSearchParams({ limit: '300' });
          if (level.value) params.set('level', level.value);
          if (search.value.trim()) params.set('q', search.value.trim());
          const data = await api(`/api/admin/logs?${params}`);
          lines = data.lines;
          loaded = true;
          if (tbody.querySelector('.sk-row')) tbody.innerHTML = '';
          reconcile(tbody, lines, {
            key: (l) => `${l.videoId}|${l.at}|${l.message}`,
            html: (l) => `<tr class="log-${esc(l.level)}"><td class="muted nowrap" title="${esc(new Date(l.at).toLocaleString())}">${esc(new Date(l.at).toLocaleTimeString())} <span class="cell-sub">${esc(timeAgo(l.at))}</span></td>
              <td><span class="lvl lvl-${esc(l.level)}">${esc(l.level)}</span></td>
              <td><button class="link-btn" data-job="${esc(l.videoId)}">${esc(l.videoName)}</button></td>
              <td class="log-msg">${esc(l.message)}</td></tr>`,
          });
          empty.classList.toggle('hidden', lines.length > 0);
          empty.innerHTML = lines.length ? '' : `${icon('activity', 32)}<h3>No log lines</h3><p>Nothing matches these filters yet.</p>`;
          root.querySelector('#log-note').textContent = data.total > lines.length ? `Showing the latest ${lines.length} of ${data.total} lines.` : '';
        } catch (err) {
          if (!loaded) toast(err.message, 'error');
        }
      }

      let timer;
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
      level.addEventListener('change', load);
      root.querySelector('#l-refresh').addEventListener('click', load);
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-job]');
        if (btn && store.videos[btn.dataset.job]) openJobDialog(btn.dataset.job);
      });

      load();
      const poll = setInterval(() => { if (!document.hidden) load(); }, 5000);
      return () => clearInterval(poll);
    },
  };

  // ═════════════════════════════════════════════════════════
  // System (health, queue, engine, limits)
  // ═════════════════════════════════════════════════════════
  VF.views.system = {
    title: () => 'System',
    mount(root) {
      root.innerHTML = `
        <div class="page-head"><h1>System</h1><p>Health of the queue, storage and processing engine.</p></div>
        <div class="two-col">
          <section class="card"><div class="card-head"><h2 class="card-title">Health</h2><button class="btn btn-ghost btn-sm" id="recheck">${icon('refresh', 14)} Check again</button></div><div id="health"></div></section>
          <section class="card"><div class="card-head"><h2 class="card-title">Limits</h2></div><div id="limits"></div></section>
        </div>
        <div class="two-col">
          <section class="card"><div class="card-head"><h2 class="card-title">Job queue</h2></div><div id="queue"></div></section>
          <section class="card"><div class="card-head"><h2 class="card-title">Processing engine</h2></div><div id="engine"></div></section>
        </div>
        <section class="card"><div class="card-head"><h2 class="card-title">Links</h2></div>
          ${kv('Public site', '<a href="/" target="_blank" rel="noopener">Open the viewer app</a>')}
          ${kv('API documentation', '<a href="/api/docs" target="_blank" rel="noopener">Swagger UI</a>')}
          ${kv('Prometheus metrics', '<a href="/metrics" target="_blank" rel="noopener">/metrics</a>')}
        </section>`;

      const status = (ok) => (ok ? '<span class="pill pill-COMPLETED">Up</span>' : '<span class="pill pill-FAILED">Down</span>');

      function render() {
        const h = store.health;
        const names = { api: 'API server', database: 'Database', storage: 'Storage', queue: 'Job queue' };
        root.querySelector('#health').innerHTML = !h ? '<p class="muted">Checking…</p>' : `
          ${kv('Overall', h.ok ? '<span class="pill pill-COMPLETED">Healthy</span>' : '<span class="pill pill-FAILED">Degraded</span>')}
          ${kv('Provider', h.provider ? esc(h.provider === 'aws' ? 'AWS (S3, SQS, ECS)' : 'Local (filesystem)') : '—')}
          ${Object.keys(names).map((k) => kv(names[k], h.components && h.components[k] ? status(h.components[k] === 'UP') : '—')).join('')}
          ${kv('Last checked', esc(timeAgo(h.checkedAt)))}`;
        const lim = h && h.limits;
        root.querySelector('#limits').innerHTML = !lim ? '<p class="muted">—</p>' : `
          ${kv('Maximum upload size', esc(VF.config.maxUploadLabel))}
          ${kv('Accepted formats', esc(lim.allowedMimeTypes.map((m) => m.replace('video/', '').replace('x-matroska', 'mkv').replace('quicktime', 'mov')).join(', ').toUpperCase()))}
          ${kv('Attempts per run', `${lim.maxAttempts} (retried after 15 s, then 45 s)`)}
          ${kv('CDN', h.cdnEnabled ? 'Enabled' : 'Not configured')}`;

        const o = store.overview;
        if (!o) return;
        const q = o.queue;
        root.querySelector('#queue').innerHTML = q.available === false
          ? `<div class="alert-box">Could not read the queue: ${esc(q.error || 'unknown error')}</div>`
          : `<div class="metrics"><div><strong>${q.waiting}</strong><span>Waiting</span></div><div><strong>${q.inFlight}</strong><span>In flight</span></div><div><strong>${q.delayed}</strong><span>Delayed (retry)</span></div></div>
            ${(q.jobs || []).map((j) => { const v = store.videos[j.videoId]; return kv(esc(v ? titleOf(v) : j.videoId), `${esc(j.state)}${j.retryCount ? ` · retry ${j.retryCount}` : ''}`); }).join('')}`;
        const c = o.compute;
        root.querySelector('#engine').innerHTML = `
          ${kv('Engine', esc(c.engine))}
          ${kv('Running now', `<strong>${c.running}</strong> job${c.running === 1 ? '' : 's'}`)}
          ${c.available ? '' : `<div class="alert-box">Could not read the engine status: ${esc(c.error || 'unknown error')}</div>`}
          ${(c.tasks || []).map((t) => kv(`Task ${t.id.slice(0, 8)}`, `${esc(t.status)}${t.cpu ? ` · ${esc(t.cpu)} CPU / ${esc(t.memory)} MiB` : ''}`)).join('')}
          ${c.provider === 'aws' && (c.tasks || []).length === 0 && c.available ? '<p class="muted">No transcoder tasks running.</p>' : ''}`;
      }

      root.querySelector('#recheck').addEventListener('click', () => { VF.refreshHealth(); VF.refreshOverview(); });
      render();
      const unsub = store.subscribe((t) => { if (t.has('health') || t.has('overview') || t.has('videos')) render(); });
      return unsub;
    },
  };

  // ═════════════════════════════════════════════════════════
  // Watch
  // ═════════════════════════════════════════════════════════
  VF.views.watch = {
    dark: true,
    nav: 'videos',
    title: (route) => (store.videos[route.param] ? titleOf(store.videos[route.param]) : 'Preview'),
    mount(root, route) {
      const id = route.param;
      let video = store.videos[id] || null;
      let built = false;
      let teardownPlayer = null;
      let destroyed = false;
      let notFound = false;

      function message({ iconName, title, text, progress, error }) {
        root.innerHTML = `
          <a class="back-link" href="#/videos">${icon('back', 16)} Back to Videos</a>
          <div class="waiting-card ${error ? 'is-error' : ''}" role="status">
            <div class="wait-ico">${icon(iconName, 36)}</div>
            <h2>${esc(title)}</h2><p>${esc(text)}</p>
            ${progress ? `<div class="prog-labels"><span>${esc(progress.label)}</span>${progress.pct != null ? `<span>${progress.pct}%</span>` : ''}</div>
              <div class="progress ${progress.pct == null ? 'indeterminate' : ''}"><div class="progress-bar" style="width:${progress.pct == null ? 35 : progress.pct}%"></div></div>` : ''}
            <a class="btn btn-ghost mt" href="#/videos">Back to Videos</a>
          </div>`;
      }

      function refresh() {
        if (destroyed || built) return;
        if (!video) {
          if (notFound) message({ iconName: 'alert', error: true, title: 'Video not found', text: 'It may have been deleted.' });
          else root.innerHTML = '<div class="spinner" role="status" aria-label="Loading video"></div>';
          return;
        }
        document.title = `${titleOf(video)} — VideoStream Admin`;
        if (video.status === 'COMPLETED' && video.hlsPlaylistUrl) {
          built = true;
          teardownPlayer = buildPlayer(root, video);
        } else if (video.status === 'FAILED') {
          message({ iconName: 'alert', error: true, title: 'Processing failed', text: video.error || 'This video could not be transcoded.' });
        } else {
          const processing = video.status === 'PROCESSING';
          message({
            iconName: 'activity', title: 'Your video is being prepared',
            text: 'It will start playing here automatically when it is ready.',
            progress: { label: `${phaseOf(video)}…`, pct: processing ? Math.round(video.progress || 0) : null },
          });
        }
      }

      if (!video) {
        VF.fetchVideo(id).then((v) => { video = store.videos[id] || v; refresh(); })
          .catch((err) => { if (err.status === 404) notFound = true; else toast(err.message, 'error'); refresh(); });
      }
      refresh();

      const unsub = store.subscribe((t) => {
        if (!t.has('videos')) return;
        if (store.videos[id]) { video = store.videos[id]; refresh(); }
        else if (store.loaded && built === false && video) { notFound = true; video = null; refresh(); }
      });

      return () => { destroyed = true; unsub(); if (teardownPlayer) teardownPlayer(); };
    },
  };

  // The video player and its panels. Returns a teardown function.
  function buildPlayer(root, video) {
    const meta = video.metadata;
    const posKey = `vf-pos-${video.id}`;
    const storage = {
      get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
      del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    };

    root.innerHTML = `
      <a class="back-link" href="#/videos">${icon('back', 16)} Back to Videos</a>
      <div class="watch-grid">
        <section aria-label="Video player">
          <div class="video-wrap">
            <video id="hls-video" controls playsinline preload="metadata"
                   ${video.subtitleUrl ? 'crossorigin="anonymous"' : ''}
                   ${video.thumbnailUrl ? `poster="${esc(video.thumbnailUrl)}"` : ''}>
              ${video.subtitleUrl ? `<track kind="subtitles" label="English" srclang="en" src="${esc(video.subtitleUrl)}">` : ''}
            </video>
            <div class="player-overlay" id="overlay-buffering" aria-hidden="true"><div class="spinner"></div></div>
            <div class="player-overlay interactive" id="overlay-error" role="alert">
              ${icon('alert', 32)}<p id="error-text"></p>
              <button class="btn btn-primary btn-sm" id="retry-btn">Try again</button>
            </div>
          </div>

          <div class="watch-title"><h1 id="watch-h1">${esc(titleOf(video))}</h1>${pill(video.status)}</div>
          <div class="meta-row">
            <span>${icon('clock', 15)} ${esc(durationOf(video))}</span>
            <span>${icon('hdd', 15)} ${esc(formatBytes(video.fileSize))}</span>
            <span>${icon('layers', 15)} ${esc(qualityOf(video))}</span>
            <span>Uploaded ${esc(timeAgo(video.createdAt))}</span>
          </div>

          <div class="admin-bar">
            <span class="admin-bar-label">Admin preview</span>
            <span id="vis-pill">${visibilityPill(video)}</span>
            <button class="btn btn-ghost btn-sm" id="pub-btn">${video.published ? 'Unpublish' : 'Publish to public site'}</button>
            <button class="btn btn-ghost btn-sm" id="edit-btn">Rename &amp; settings</button>
          </div>

          <div class="controls-bar">
            <div class="control-group"><label for="speed-select">Speed</label>
              <select class="select" id="speed-select">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}×</option>`).join('')}</select></div>
            ${video.subtitleUrl ? '<button class="btn btn-ghost btn-sm btn-toggle" id="cc-toggle" aria-pressed="false">Captions: Off</button>' : ''}
          </div>

          <div class="tabs" role="tablist" id="watch-tabs">
            <button class="tab active" role="tab" aria-selected="true" data-tab="details">Details</button>
            <button class="tab" role="tab" aria-selected="false" data-tab="transcode">Transcoding Info</button>
            <button class="tab" role="tab" aria-selected="false" data-tab="logs">Logs</button>
          </div>
          <div class="tab-panel" id="tab-panel" role="tabpanel"></div>
        </section>

        <aside class="watch-side">
          <section class="card panel"><h2 class="card-title">Video Quality</h2><ul class="quality-list" id="quality-list"></ul></section>
          <section class="card panel"><h2 class="card-title">Share</h2>
            <div class="share"><input class="input" id="share-url" readonly value="${esc(new URL(video.hlsPlaylistUrl, location.origin).href)}" aria-label="Stream URL" />
              <button class="icon-btn solid" id="copy-url" aria-label="Copy stream URL">${icon('copy', 16)}</button></div>
            <p class="opt-note">HLS playlist (.m3u8). Opens in any HLS-compatible player.</p></section>
          <section class="card panel"><h2 class="card-title">Keyboard Shortcuts</h2>
            <div class="shortcuts">
              <span><kbd>Space</kbd> <kbd>K</kbd></span><span>Play / pause</span>
              <span><kbd>←</kbd> <kbd>→</kbd></span><span>Seek 5 s</span>
              <span><kbd>J</kbd> <kbd>L</kbd></span><span>Seek 10 s</span>
              <span><kbd>↑</kbd> <kbd>↓</kbd></span><span>Volume</span>
              <span><kbd>M</kbd></span><span>Mute</span><span><kbd>F</kbd></span><span>Fullscreen</span>
              ${video.subtitleUrl ? '<span><kbd>C</kbd></span><span>Captions</span>' : ''}
            </div></section>
        </aside>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const videoEl = $('#hls-video');
    const speedSel = $('#speed-select');
    const ccBtn = $('#cc-toggle');
    const bufferingOverlay = $('#overlay-buffering');
    const errorOverlay = $('#overlay-error');
    let hls = null;
    let levels = [];
    let selectedLevel = -1;
    let autoLevel = null;
    let netRetries = 0;
    let mediaRetries = 0;
    let activeTab = 'details';

    // ── Quality panel ──
    function renderQuality() {
      const list = $('#quality-list');
      if (!hls && !levels.length) {
        list.innerHTML = `<li class="q-note">${videoEl.canPlayType('application/vnd.apple.mpegurl') && !(window.Hls && Hls.isSupported()) ? 'Quality is managed automatically by your browser.' : 'Loading qualities…'}</li>`;
        return;
      }
      const options = [{ idx: -1, label: autoLevel && selectedLevel === -1 ? `Auto (${autoLevel}p)` : 'Auto', tag: 'ABR' }]
        .concat(levels.map((l, idx) => ({ idx, label: `${l.height}p${l.height >= 720 ? ' (HD)' : ''}`, tag: 'HLS', h: l.height })).sort((a, b) => b.h - a.h));
      list.innerHTML = options.map((o) => `
        <li><button class="q-item ${o.idx === selectedLevel ? 'active' : ''}" data-level="${o.idx}" role="radio" aria-checked="${o.idx === selectedLevel}">
          <span class="radio"></span><span class="q-label">${esc(o.label)}</span><span class="q-tag">${o.tag}</span></button></li>`).join('');
    }
    $('#quality-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-level]');
      if (!btn || !hls) return;
      selectedLevel = parseInt(btn.dataset.level, 10);
      hls.currentLevel = selectedLevel;
      renderQuality();
    });

    // ── Tabs ──
    function kv(label, value) { return `<div class="detail"><span class="detail-label">${esc(label)}</span><span class="detail-value">${value}</span></div>`; }
    function renderTab() {
      const panel = $('#tab-panel');
      if (activeTab === 'details') {
        panel.innerHTML = `<div class="detail-grid">
          ${kv('File Name', esc(video.originalName))}
          ${kv('Original Size', esc(formatBytes(video.fileSize)))}
          ${kv('Duration', esc(durationOf(video)))}
          ${kv('Resolution', meta ? `${esc(meta.width)} x ${esc(meta.height)}` : '—')}
          ${kv('Codec', esc(meta?.codec || '—'))}
          ${kv('Frame Rate', meta?.fps ? `${esc(meta.fps)} fps` : '—')}
          ${kv('Bitrate', meta?.bitrate ? `${esc(meta.bitrate.toLocaleString())} kbps` : '—')}
          ${kv('Format', esc(video.contentType))}</div>`;
      } else if (activeTab === 'transcode') {
        const rows = levels.slice().sort((a, b) => b.height - a.height).map((l) =>
          `<tr><td>${esc(l.width)} x ${esc(l.height)}</td><td>${esc(l.height)}p</td><td>${esc(Math.round(l.bitrate / 1000).toLocaleString())} kbps</td></tr>`).join('');
        panel.innerHTML = `
          <div class="detail-grid">
            ${kv('Output', 'HLS (adaptive)')}${kv('Video / Audio', 'H.264 / AAC')}${kv('Segment Length', '6 seconds')}
            ${kv('Poster Thumbnail', video.thumbnailUrl ? 'Yes' : 'No')}${kv('Captions', video.subtitleUrl ? 'English' : 'None')}${kv('Renditions', levels.length || '—')}
          </div>
          ${levels.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Resolution</th><th>Rendition</th><th>Bitrate</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
      } else {
        const events = [
          ['Upload registered', video.createdAt],
          ['Processing started', video.processingStartedAt],
          ['Processing completed', video.completedAt],
          ['Processing failed', video.failedAt],
        ].filter(([, at]) => at);
        panel.innerHTML = `<ul class="timeline">${events.map(([label, at]) =>
          `<li><span class="tl-dot"></span><span class="tl-label">${esc(label)}</span><span class="tl-time">${esc(new Date(at).toLocaleString())}</span></li>`).join('')}</ul>
          ${video.error ? `<div class="alert-box">${esc(video.error)}</div>` : ''}`;
      }
    }
    $('#watch-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (!tab) return;
      activeTab = tab.dataset.tab;
      root.querySelectorAll('#watch-tabs .tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      renderTab();
    });

    const absoluteUrl = new URL(video.hlsPlaylistUrl, location.origin).href;
    $('#copy-url').addEventListener('click', () => copyText(absoluteUrl, 'Stream URL copied'));

    // Publish / unpublish right from the preview
    let published = !!video.published;
    $('#pub-btn').addEventListener('click', async () => {
      if (await setPublished(video.id, !published)) {
        published = !published;
        $('#vis-pill').innerHTML = visibilityPill({ status: 'COMPLETED', published });
        $('#pub-btn').textContent = published ? 'Unpublish' : 'Publish to public site';
      }
    });
    $('#edit-btn').addEventListener('click', () => openEditDialog(video.id, { focusTitle: true }));

    // A rename made in the dialog shows in the preview straight away
    const unsubTitle = store.subscribe((t) => {
      const latest = t.has('videos') && store.videos[video.id];
      if (!latest) return;
      $('#watch-h1').textContent = titleOf(latest);
      document.title = `${titleOf(latest)} — VideoStream Admin`;
    });
    $('#share-url').addEventListener('focus', (e) => e.target.select());

    // ── Overlays ──
    const setBuffering = (on) => bufferingOverlay.classList.toggle('visible', on);
    function showError(text) {
      setBuffering(false);
      $('#error-text').textContent = text;
      errorOverlay.classList.add('visible');
    }
    videoEl.addEventListener('waiting', () => setBuffering(true));
    ['playing', 'canplay', 'pause', 'seeked'].forEach((evt) => videoEl.addEventListener(evt, () => setBuffering(false)));

    // ── Speed (remembered) ──
    const savedSpeed = storage.get('vf-speed');
    if (savedSpeed && [...speedSel.options].some((o) => o.value === savedSpeed)) {
      speedSel.value = savedSpeed;
      videoEl.playbackRate = parseFloat(savedSpeed);
    }
    speedSel.addEventListener('change', () => {
      videoEl.playbackRate = parseFloat(speedSel.value);
      storage.set('vf-speed', speedSel.value);
    });

    // ── Resume where you left off ──
    let lastSaved = 0;
    videoEl.addEventListener('loadedmetadata', () => {
      const pos = parseFloat(storage.get(posKey));
      if (pos > 5 && pos < videoEl.duration - 5) {
        videoEl.currentTime = pos;
        toast(`Resumed from ${formatDuration(pos)}`, 'info', 2500);
      }
      if (videoEl.textTracks[0]) videoEl.textTracks[0].mode = 'disabled';
    }, { once: true });
    videoEl.addEventListener('timeupdate', () => {
      if (Date.now() - lastSaved > 2000) { lastSaved = Date.now(); storage.set(posKey, videoEl.currentTime); }
    });
    videoEl.addEventListener('ended', () => storage.del(posKey));

    // ── Captions ──
    function setCaptions(on) {
      const track = videoEl.textTracks[0];
      if (!track || !ccBtn) return;
      track.mode = on ? 'showing' : 'disabled';
      ccBtn.setAttribute('aria-pressed', String(on));
      ccBtn.textContent = `Captions: ${on ? 'On' : 'Off'}`;
    }
    if (ccBtn) ccBtn.addEventListener('click', () => setCaptions(ccBtn.getAttribute('aria-pressed') !== 'true'));

    // ── Hls.js ──
    function startPlayback(resumeAt) {
      errorOverlay.classList.remove('visible');
      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, capLevelToPlayerSize: true });
        hls.loadSource(video.hlsPlaylistUrl);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          levels = data.levels;
          selectedLevel = -1;
          renderQuality();
          if (activeTab === 'transcode') renderTab();
          if (resumeAt) videoEl.currentTime = resumeAt;
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          const level = hls.levels[data.level];
          autoLevel = level ? level.height : null;
          if (selectedLevel === -1) renderQuality();
        });
        hls.on(Hls.Events.FRAG_LOADED, () => { netRetries = 0; mediaRetries = 0; });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          console.error('Hls.js fatal error:', data.type, data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 3) return hls.startLoad();
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 3) return hls.recoverMediaError();
          hls.destroy();
          hls = null;
          showError(data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'The connection was lost while loading the video.'
            : 'This video could not be played.');
        });
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = video.hlsPlaylistUrl; // Safari: native HLS, no manual quality switching
        renderQuality();
      } else {
        showError('Your browser does not support HLS playback.');
      }
    }
    $('#retry-btn').addEventListener('click', () => {
      const at = videoEl.currentTime;
      if (hls) hls.destroy();
      hls = null;
      netRetries = mediaRetries = 0;
      startPlayback(at);
    });

    // ── Keyboard shortcuts ──
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('button, a, select, input, textarea, [role="dialog"], [role="alertdialog"]')) return;
      const key = e.key.toLowerCase();
      // With the video focused the browser already handles these natively
      const native = [' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f'];
      if (document.activeElement === videoEl && native.includes(key)) return;
      const toggle = () => (videoEl.paused ? videoEl.play() : videoEl.pause());
      const actions = {
        ' ': toggle, k: toggle,
        arrowleft: () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 5); },
        arrowright: () => { videoEl.currentTime += 5; },
        j: () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 10); },
        l: () => { videoEl.currentTime += 10; },
        arrowup: () => { videoEl.volume = Math.min(1, videoEl.volume + 0.1); },
        arrowdown: () => { videoEl.volume = Math.max(0, videoEl.volume - 0.1); },
        m: () => { videoEl.muted = !videoEl.muted; },
        f: () => (document.fullscreenElement ? document.exitFullscreen() : videoEl.parentElement.requestFullscreen()),
        c: () => ccBtn && setCaptions(ccBtn.getAttribute('aria-pressed') !== 'true'),
      };
      if (actions[key]) { e.preventDefault(); actions[key](); }
    }
    document.addEventListener('keydown', onKey);

    renderQuality();
    renderTab();
    startPlayback(0);

    return () => {
      unsubTitle();
      document.removeEventListener('keydown', onKey);
      if (hls) hls.destroy();
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    };
  }

  // Exposed so the job dialog can be opened from the row menu
  VF.openJobDialog = openJobDialog;
})();
