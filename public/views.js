/* ============================================================
   VideoStream — pages: Dashboard, My Videos, Processing Jobs,
   Settings and Watch. Depends on common.js and app.js.
   ============================================================ */
(function () {
  const VF = window.VF;
  const { esc, formatBytes, formatDate, timeAgo, formatDuration, toast, confirmDialog, dialog, reconcile, copyText, icon } = VF;
  const store = VF.store;

  // ─── Shared helpers ────────────────────────────────────────
  const STATUS_LABEL = {
    PENDING: 'Pending', UPLOADING: 'Uploading', UPLOADED: 'Queued',
    PROCESSING: 'Processing', COMPLETED: 'Completed', FAILED: 'Failed',
  };
  const pill = (status) => `<span class="pill pill-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
  const qualityOf = (v) => (v.metadata && v.metadata.height ? `${v.metadata.height}p` : '—');
  const durationOf = (v) => (v.metadata && v.metadata.duration ? formatDuration(v.metadata.duration) : '—');
  const isActive = (v) => VF.ACTIVE_STATUSES.includes(v.status);
  const watchHref = (v) => (v.status === 'COMPLETED' ? `#/watch/${encodeURIComponent(v.id)}` : '#/jobs');

  const thumb = (v) => (v.thumbnailUrl
    ? `<img class="thumb" src="${esc(v.thumbnailUrl)}" alt="" loading="lazy" />`
    : `<span class="thumb thumb-empty">${icon('film', 18)}</span>`);

  // Phases follow the progress milestones in transcoderTask.ts
  function phaseOf(v) {
    const p = Math.round(v.progress || 0);
    if (v.status === 'PENDING' || v.status === 'UPLOADING') return 'Waiting for the upload to finish';
    if (v.status === 'UPLOADED') return 'In queue — waiting for a transcoder';
    if (v.status !== 'PROCESSING') return STATUS_LABEL[v.status] || v.status;
    if (p < 10) return 'Preparing video';
    if (p <= 80) return 'Encoding resolutions';
    if (p < 91) return 'Creating thumbnail & captions';
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

  async function deleteVideo(id) {
    const video = store.videos[id];
    const ok = await confirmDialog({
      title: 'Delete this video?',
      message: `"${video ? video.originalName : id}" and all of its transcoded files will be permanently removed.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Delete failed');
      VF.removeVideo(id);
      toast('Video deleted', 'success');
      return true;
    } catch (err) {
      toast(`Failed to delete video: ${err.message}`, 'error');
      return false;
    }
  }

  function rowMenu(anchor, video) {
    const items = [];
    if (video.status === 'COMPLETED') {
      items.push({ label: 'Watch', icon: 'play', onClick: () => { location.hash = watchHref(video); } });
      if (video.hlsPlaylistUrl) items.push({ label: 'Copy stream URL', icon: 'copy', onClick: () => copyText(video.hlsPlaylistUrl, 'Stream URL copied') });
    } else {
      items.push({ label: 'View job', icon: 'eye', onClick: () => openJobDialog(video.id) });
    }
    items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteVideo(video.id) });
    VF.menu(anchor, items);
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

  // ═════════════════════════════════════════════════════════
  // Dashboard
  // ═════════════════════════════════════════════════════════
  VF.views.dashboard = {
    title: () => 'Dashboard',
    mount(root) {
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      root.innerHTML = `
        <div class="page-head">
          <h1>${greeting}, <span id="greet-name">${esc(VF.config.userName)}</span> 👋</h1>
          <p>Here's what's happening with your videos today.</p>
        </div>

        <section class="stat-grid" aria-label="Summary">
          <div class="stat-card"><span class="stat-ico ico-blue">${icon('play', 20)}</span><div><div class="stat-label">Total Videos</div><div class="stat-value" id="s-total">0</div><div class="stat-sub" id="s-total-sub"></div></div></div>
          <div class="stat-card"><span class="stat-ico ico-green">${icon('clock', 20)}</span><div><div class="stat-label">Processing</div><div class="stat-value" id="s-proc">0</div><div class="stat-sub" id="s-proc-sub"></div></div></div>
          <div class="stat-card"><span class="stat-ico ico-purple">${icon('layers', 20)}</span><div><div class="stat-label">Ready to Watch</div><div class="stat-value" id="s-ready">0</div><div class="stat-sub" id="s-ready-sub"></div></div></div>
          <div class="stat-card"><span class="stat-ico ico-orange">${icon('database', 20)}</span><div><div class="stat-label">Storage Used</div><div class="stat-value" id="s-store">0 B</div><div class="stat-sub" id="s-store-sub"></div></div></div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title">Recent Videos</h2><a class="link-btn" href="#/videos">View all ${icon('forward', 14)}</a></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Status</th><th>Duration</th><th>Uploaded At</th></tr></thead>
              <tbody id="recent"></tbody>
            </table>
          </div>
          <div class="empty hidden" id="recent-empty"></div>
        </section>`;

      const tbody = root.querySelector('#recent');
      const empty = root.querySelector('#recent-empty');
      rowNavigation(tbody);
      tbody.innerHTML = skeletonRows(4, 3);

      function render() {
        const all = store.list();
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const today = all.filter((v) => new Date(v.createdAt) >= startOfDay).length;
        const processing = all.filter(isActive);
        const queued = all.filter((v) => v.status === 'UPLOADED').length;
        const ready = all.filter((v) => v.status === 'COMPLETED').length;
        const failed = all.filter((v) => v.status === 'FAILED').length;
        const bytes = all.reduce((sum, v) => sum + (v.fileSize || 0), 0);
        const set = (id, text) => { root.querySelector(`#${id}`).textContent = text; };

        set('s-total', all.length);
        set('s-total-sub', `+${today} today`);
        set('s-proc', processing.length);
        set('s-proc-sub', queued ? `${queued} in queue` : 'nothing waiting');
        set('s-ready', ready);
        set('s-ready-sub', failed ? `${failed} failed` : 'all good');
        root.querySelector('#s-ready-sub').classList.toggle('bad', failed > 0);
        set('s-store', formatBytes(bytes));
        set('s-store-sub', `original uploads · ${all.length} video${all.length === 1 ? '' : 's'}`);

        if (!store.loaded) return;
        if (tbody.querySelector('.sk-row')) tbody.innerHTML = '';
        empty.classList.toggle('hidden', all.length > 0);
        empty.innerHTML = all.length ? '' : `${icon('film', 32)}<h3>No videos yet</h3><p>Upload your first video and it will show up here.</p><a class="btn btn-primary" href="#/upload">Upload a video</a>`;
        reconcile(tbody, all.slice(0, 5), {
          key: (v) => v.id,
          html: (v) => `<tr class="clickable" data-href="${watchHref(v)}">
            <td><a class="name-cell" href="${watchHref(v)}">${thumb(v)}<span><span class="cell-title">${esc(v.originalName)}</span>
              <span class="cell-sub">${esc(qualityOf(v))} • ${formatBytes(v.fileSize)}</span></span></a></td>
            <td>${pill(v.status)}${v.status === 'PROCESSING' ? ` <span class="pct">${Math.round(v.progress || 0)}%</span>` : ''}</td>
            <td>${durationOf(v)}</td>
            <td class="muted">${esc(timeAgo(v.createdAt))}</td></tr>`,
        });
      }

      render();
      const unsub = store.subscribe((t) => { if (t.has('videos')) render(); });
      const tick = setInterval(render, 30000);
      return () => { unsub(); clearInterval(tick); };
    },
  };

  // ═════════════════════════════════════════════════════════
  // My Videos
  // ═════════════════════════════════════════════════════════
  VF.views.videos = {
    title: () => 'My Videos',
    mount(root) {
      let page = 1;
      root.innerHTML = `
        <div class="page-head"><h1>My Videos</h1><p>Manage and play your processed videos.</p></div>
        <section class="card">
          <div class="toolbar">
            <label class="field-search"><span class="sr-only">Search videos</span>${icon('search', 16)}
              <input type="search" id="v-search" placeholder="Search by name or ID…" autocomplete="off" /></label>
            <label><span class="sr-only">Filter by status</span>
              <select id="v-status" class="select">
                <option value="all">All Status</option><option value="COMPLETED">Completed</option>
                <option value="active">Processing</option><option value="FAILED">Failed</option>
              </select></label>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Thumbnail</th><th>Name</th><th>Duration</th><th>Quality</th><th>Status</th><th>Uploaded At</th><th class="right">Actions</th></tr></thead>
              <tbody id="rows"></tbody>
            </table>
          </div>
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
        if (s === 'active' && !isActive(v)) return false;
        if ((s === 'COMPLETED' || s === 'FAILED') && v.status !== s) return false;
        if (q && !v.originalName.toLowerCase().includes(q.toLowerCase()) && !v.id.toLowerCase().includes(q.toLowerCase())) return false;
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
            <td>${thumb(v)}</td>
            <td><a class="cell-title link-plain" href="${watchHref(v)}">${esc(v.originalName)}</a><span class="cell-sub">${formatBytes(v.fileSize)}</span></td>
            <td>${durationOf(v)}</td><td>${esc(qualityOf(v))}</td>
            <td>${pill(v.status)}${v.status === 'PROCESSING' ? ` <span class="pct">${Math.round(v.progress || 0)}%</span>` : ''}</td>
            <td class="muted">${esc(timeAgo(v.createdAt))}</td>
            <td class="right"><button class="icon-btn" data-menu-anchor data-id="${esc(v.id)}" aria-label="Actions for ${esc(v.originalName)}" aria-haspopup="menu">${icon('dots', 18)}</button></td></tr>`,
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

  function openJobDialog(id) {
    const v = store.videos[id];
    if (!v) return;
    const row = (label, value) => `<div class="kv"><span>${esc(label)}</span><span>${value}</span></div>`;
    const started = v.processingStartedAt || v.createdAt;
    VF.dialog({
      title: v.originalName,
      html: `
        ${row('Job ID', `<code>${esc(v.id)}</code>`)}
        ${row('Status', pill(v.status))}
        ${row('Progress', `${Math.round(v.status === 'COMPLETED' ? 100 : v.progress || 0)}% · ${esc(phaseOf(v))}`)}
        ${row('Started', esc(formatDate(started)))}
        ${v.completedAt ? row('Completed', esc(formatDate(v.completedAt))) : ''}
        ${v.failedAt ? row('Failed', esc(formatDate(v.failedAt))) : ''}
        ${row('Original size', formatBytes(v.fileSize))}
        ${v.error ? `<div class="alert-box">${esc(v.error)}</div>` : ''}
        <div class="modal-actions">
          ${v.status === 'COMPLETED' ? `<a class="btn btn-primary" href="#/watch/${encodeURIComponent(v.id)}" data-close>Watch video</a>` : ''}
          <button class="btn btn-ghost" data-close>Close</button>
        </div>`,
    });
  }

  VF.views.jobs = {
    title: () => 'Processing Jobs',
    mount(root) {
      root.innerHTML = `
        <div class="page-head"><h1>Processing Jobs</h1><p>Track the status of your video processing jobs.</p></div>
        <section class="card">
          <div class="tabs" role="tablist" id="job-tabs"></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>ID</th><th>Video Name</th><th>Status</th><th>Progress</th><th>Started At</th><th class="right">Actions</th></tr></thead>
              <tbody id="jobs"></tbody>
            </table>
          </div>
          <div class="empty hidden" id="jobs-empty"></div>
        </section>`;
      const tbody = root.querySelector('#jobs');
      const empty = root.querySelector('#jobs-empty');
      const tabsEl = root.querySelector('#job-tabs');
      tbody.innerHTML = skeletonRows(6, 4);

      const TABS = [['all', 'All'], ['active', 'Processing'], ['COMPLETED', 'Completed'], ['FAILED', 'Failed']];
      const inTab = (v, tab) => tab === 'all' || (tab === 'active' ? isActive(v) : v.status === tab);

      function progressCell(v) {
        const done = v.status === 'COMPLETED';
        const pct = done ? 100 : ['PENDING', 'UPLOADING', 'UPLOADED'].includes(v.status) ? 0 : Math.round(v.progress || 0);
        const cls = done ? 'bar-ok' : v.status === 'FAILED' ? 'bar-bad' : '';
        const waiting = v.status === 'UPLOADED' || v.status === 'PENDING' || v.status === 'UPLOADING';
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
            <td><span class="cell-title">${esc(v.originalName)}</span><span class="cell-sub">${esc(phaseOf(v))}</span></td>
            <td>${pill(v.status)}</td>
            <td>${progressCell(v)}</td>
            <td class="muted">${esc(timeAgo(v.processingStartedAt || v.createdAt))}</td>
            <td class="right"><button class="btn btn-ghost btn-sm" data-job="${esc(v.id)}">View</button></td></tr>`,
        });
        empty.classList.toggle('hidden', list.length > 0);
        empty.innerHTML = list.length ? '' : `${icon('jobs', 32)}<h3>No jobs here</h3><p>${jobsTab === 'all' ? 'Upload a video to create a job.' : 'Nothing matches this tab right now.'}</p>`;
      }

      tabsEl.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { jobsTab = tab.dataset.tab; render(); }
      });
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-job]');
        if (btn) openJobDialog(btn.dataset.job);
      });

      render();
      const unsub = store.subscribe((t) => { if (t.has('videos')) render(); });
      const tick = setInterval(render, 30000);
      return () => { unsub(); clearInterval(tick); };
    },
  };

  // ═════════════════════════════════════════════════════════
  // Settings
  // ═════════════════════════════════════════════════════════
  VF.views.settings = {
    title: () => 'Settings',
    mount(root) {
      root.innerHTML = `
        <div class="page-head"><h1>Settings</h1><p>System status and preferences.</p></div>

        <section class="card">
          <div class="card-head"><h2 class="card-title">System Status</h2><button class="btn btn-ghost btn-sm" id="recheck">Check again</button></div>
          <div id="health"></div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title">Preferences</h2></div>
          <form class="form-row" id="name-form">
            <label for="display-name">Display name</label>
            <input id="display-name" class="input" maxlength="30" value="${esc(VF.config.userName)}" />
            <button class="btn btn-primary" type="submit">Save</button>
          </form>
          <p class="opt-note">Shown in the greeting and top bar. Saved in this browser only.</p>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="card-title">Limits &amp; Developer Links</h2></div>
          <div class="kv"><span>Maximum upload size</span><span>${VF.config.maxUploadLabel} per file</span></div>
          <div class="kv"><span>Accepted formats</span><span>MP4, MOV, MKV</span></div>
          <div class="kv"><span>API documentation</span><a href="/api/docs" target="_blank" rel="noopener">Open Swagger UI</a></div>
          <div class="kv"><span>Prometheus metrics</span><a href="/metrics" target="_blank" rel="noopener">/metrics</a></div>
          <div class="kv"><span>Detailed health</span><a href="/health/detailed" target="_blank" rel="noopener">/health/detailed</a></div>
        </section>`;

      const healthEl = root.querySelector('#health');
      function renderHealth() {
        const h = store.health;
        if (!h) { healthEl.innerHTML = '<div class="kv"><span>Checking…</span><span></span></div>'; return; }
        const names = { api: 'API server', database: 'Database', storage: 'Storage', queue: 'Job queue' };
        const comps = h.components || {};
        healthEl.innerHTML = `
          <div class="kv"><span>Overall</span><span>${h.ok ? '<span class="pill pill-COMPLETED">Healthy</span>' : '<span class="pill pill-FAILED">Degraded</span>'}</span></div>
          <div class="kv"><span>Provider</span><span>${h.provider ? esc(h.provider === 'aws' ? 'AWS (S3, SQS, ECS)' : 'Local (filesystem)') : '—'}</span></div>
          ${Object.keys(names).map((k) => `<div class="kv"><span>${names[k]}</span><span>${comps[k] === 'UP' ? '<span class="pill pill-COMPLETED">Up</span>' : comps[k] ? '<span class="pill pill-FAILED">Down</span>' : '—'}</span></div>`).join('')}
          <div class="kv"><span>Last checked</span><span>${esc(timeAgo(h.checkedAt))}</span></div>`;
      }
      root.querySelector('#recheck').addEventListener('click', () => VF.refreshHealth());
      root.querySelector('#name-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = root.querySelector('#display-name').value.trim() || 'there';
        VF.config.userName = name;
        try { localStorage.setItem('vf-name', name); } catch { /* ignore */ }
        document.getElementById('user-name').textContent = name;
        document.getElementById('avatar').textContent = name.charAt(0).toUpperCase();
        toast('Display name saved', 'success', 2500);
      });

      renderHealth();
      const unsub = store.subscribe((t) => { if (t.has('health')) renderHealth(); });
      return unsub;
    },
  };

  // ═════════════════════════════════════════════════════════
  // Watch
  // ═════════════════════════════════════════════════════════
  VF.views.watch = {
    dark: true,
    nav: 'videos',
    title: (route) => (store.videos[route.param] ? store.videos[route.param].originalName : 'Watch'),
    mount(root, route) {
      const id = route.param;
      let video = store.videos[id] || null;
      let built = false;
      let teardownPlayer = null;
      let destroyed = false;
      let notFound = false;

      function message({ iconName, title, text, progress, error }) {
        root.innerHTML = `
          <a class="back-link" href="#/videos">${icon('back', 16)} Back to My Videos</a>
          <div class="waiting-card ${error ? 'is-error' : ''}" role="status">
            <div class="wait-ico">${icon(iconName, 36)}</div>
            <h2>${esc(title)}</h2><p>${esc(text)}</p>
            ${progress ? `<div class="prog-labels"><span>${esc(progress.label)}</span>${progress.pct != null ? `<span>${progress.pct}%</span>` : ''}</div>
              <div class="progress ${progress.pct == null ? 'indeterminate' : ''}"><div class="progress-bar" style="width:${progress.pct == null ? 35 : progress.pct}%"></div></div>` : ''}
            <a class="btn btn-ghost mt" href="#/videos">Back to My Videos</a>
          </div>`;
      }

      function refresh() {
        if (destroyed || built) return;
        if (!video) {
          if (notFound) message({ iconName: 'alert', error: true, title: 'Video not found', text: 'It may have been deleted.' });
          else root.innerHTML = '<div class="spinner" role="status" aria-label="Loading video"></div>';
          return;
        }
        document.title = `${video.originalName} — VideoStream`;
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
      <a class="back-link" href="#/videos">${icon('back', 16)} Back to My Videos</a>
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

          <div class="watch-title"><h1>${esc(video.originalName)}</h1>${pill(video.status)}</div>
          <div class="meta-row">
            <span>${icon('clock', 15)} ${esc(durationOf(video))}</span>
            <span>${icon('hdd', 15)} ${esc(formatBytes(video.fileSize))}</span>
            <span>${icon('layers', 15)} ${esc(qualityOf(video))}</span>
            <span>Uploaded ${esc(timeAgo(video.createdAt))}</span>
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
            <div class="share"><input class="input" id="share-url" readonly value="${esc(video.hlsPlaylistUrl)}" aria-label="Stream URL" />
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

    $('#copy-url').addEventListener('click', () => copyText(video.hlsPlaylistUrl, 'Stream URL copied'));
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
