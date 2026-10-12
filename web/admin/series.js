/* ============================================================
   VideoStream Admin — series, seasons and episodes.
   Episodes are ordinary videos that carry seriesId / season / episode, so the live video list
   already has them; the series themselves (title, seasons, visibility) come from /api/admin/series.
   Depends on common.js, app.js and views.js (VF.admin).
   ============================================================ */
(function () {
  const VF = window.VF;
  const { esc, formatBytes, timeAgo, toast, confirmDialog, dialog, reconcile, icon } = VF;
  const store = VF.store;
  const A = () => VF.admin; // registered by views.js

  // ─── Data helpers ──────────────────────────────────────────
  const seriesById = (id) => store.series.find((s) => s.id === id) || null;
  const episodesOf = (id) => Object.values(store.videos)
    .filter((v) => v.seriesId === id)
    .sort((a, b) => (a.seasonNumber - b.seasonNumber) || (a.episodeNumber - b.episodeNumber));
  const nextEpisode = (seriesId, season, excludeId) =>
    1 + Math.max(0, ...Object.values(store.videos).filter((v) => v.seriesId === seriesId && v.seasonNumber === season && v.id !== excludeId).map((v) => v.episodeNumber || 0));
  const seasonLabel = (n) => (n === 0 ? 'Specials' : `Season ${n}`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const isLive = (v) => v.status === 'COMPLETED' && v.published; // finished and published
  const snippet = (text, n = 90) => (text && text.length > n ? `${text.slice(0, n).trimEnd()}…` : text || '');

  // Updates one video in the live list from an API response (attribute changes don't arrive by themselves)
  function mergeVideo(video) {
    store.videos = { ...store.videos, [video.id]: video };
    store.emit('videos');
  }

  const field = (label, control, hint = '') => `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;
  const errorBox = '<div class="alert-box hidden" data-error></div>';
  function showError(root, message) {
    const box = root.querySelector('[data-error]');
    box.textContent = message;
    box.classList.remove('hidden');
  }

  // ─── Series: create / edit / publish / delete ──────────────
  function openSeriesForm(series) {
    const editing = !!series;
    const modal = dialog({
      title: editing ? 'Series details' : 'New series',
      html: `<form class="edit-form" id="series-form">
          ${field('Title', `<input class="input" name="title" maxlength="120" required value="${esc(series ? series.title : '')}" placeholder="e.g. Midnight Garden" />`)}
          ${field('Description', `<textarea class="input" name="description" rows="4" maxlength="2000" placeholder="A short summary shown on the series page">${esc(series ? series.description || '' : '')}</textarea>`, 'Shown on the public series page.')}
          ${editing ? `<div class="field thumb-field"><span>Poster</span>
            <div class="thumb-row">
              <div class="thumb-preview" id="poster-preview">${A().previewHtml(series.posterUrl)}</div>
              <div class="thumb-actions">
                <button type="button" class="btn btn-ghost btn-sm" id="poster-upload">${icon('upload', 14)} Upload image</button>
                <button type="button" class="btn btn-ghost btn-sm ${series.posterKey ? '' : 'hidden'}" id="poster-reset">Use the first episode's</button>
                <input type="file" id="poster-file" accept="image/jpeg,image/png,image/webp" hidden />
              </div>
            </div>
            <small>JPEG, PNG or WebP, up to 8 MB. Without one, the first episode's thumbnail is used.</small></div>` : ''}
          ${errorBox}
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Create series'}</button></div></form>`,
    });
    const form = modal.el.querySelector('#series-form');
    form.title.focus();

    // Poster changes apply straight away
    if (editing) {
      const preview = modal.el.querySelector('#poster-preview');
      const fileInput = modal.el.querySelector('#poster-file');
      const resetBtn = modal.el.querySelector('#poster-reset');
      const refresh = async () => {
        await VF.refreshSeries();
        const latest = seriesById(series.id);
        preview.innerHTML = A().previewHtml(latest && latest.posterUrl);
        resetBtn.classList.toggle('hidden', !(latest && latest.posterKey));
      };
      modal.el.querySelector('#poster-upload').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
          await A().sendImage(`/api/admin/series/${encodeURIComponent(series.id)}/poster`, file);
          await refresh();
          toast('Poster updated', 'success', 2200);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      resetBtn.addEventListener('click', async () => {
        try {
          await A().api(`/api/admin/series/${encodeURIComponent(series.id)}/poster`, { method: 'DELETE' });
          await refresh();
          toast('Using the first episode\'s thumbnail', 'success', 2200);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { title: form.title.value, description: form.description.value };
        if (editing) {
          await A().api(`/api/admin/series/${encodeURIComponent(series.id)}`, { method: 'PATCH', body });
          await VF.refreshSeries();
          toast('Series saved', 'success', 2200);
        } else {
          const created = await A().api('/api/admin/series', { method: 'POST', body });
          await VF.refreshSeries();
          location.hash = `#/series/${created.id}`;
          toast('Series created. Add seasons and episodes below.', 'success', 3000);
        }
        modal.close();
      } catch (err) {
        showError(modal.el, err.message);
      }
    });
  }

  async function setSeriesPublished(id, published) {
    try {
      await A().api(`/api/admin/series/${encodeURIComponent(id)}`, { method: 'PATCH', body: { published } });
      await VF.refreshSeries();
      const live = episodesOf(id).filter(isLive).length;
      toast(published
        ? (live ? 'Series published' : 'Series published. It shows on the site once at least one episode is finished and published.')
        : 'Series hidden from the public site', 'success', 3500);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openDeleteSeries(series) {
    const count = episodesOf(series.id).length;
    const modal = dialog({
      title: `Delete "${series.title}"?`,
      html: `<form class="edit-form" id="delete-series-form">
          <p class="muted-text">This removes the series and its seasons. It has ${plural(count, 'episode')}.</p>
          <label class="check"><input type="radio" name="mode" value="keep" checked /> Keep the episode videos (they become standalone drafts)</label>
          <label class="check"><input type="radio" name="mode" value="delete" /> Also delete the episode videos and their files</label>
          ${errorBox}
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="submit" class="btn btn-danger">Delete series</button></div></form>`,
    });
    modal.el.querySelector('#delete-series-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const alsoVideos = e.target.mode.value === 'delete';
      try {
        await A().api(`/api/admin/series/${encodeURIComponent(series.id)}?deleteVideos=${alsoVideos}`, { method: 'DELETE' });
        if (alsoVideos) episodesOf(series.id).forEach((v) => VF.removeVideo(v.id));
        await Promise.all([VF.refreshSeries(), VF.reloadVideos(), VF.refreshOverview()]);
        modal.close();
        location.hash = '#/series';
        toast('Series deleted', 'success', 2500);
      } catch (err) {
        showError(modal.el, err.message);
      }
    });
  }

  // ─── Seasons ───────────────────────────────────────────────
  function openAddSeason(series) {
    const next = Math.max(0, ...series.seasons) + 1;
    const modal = dialog({
      title: 'Add a season',
      html: `<form class="edit-form" id="season-form">
          ${field('Season number', `<input class="input" name="number" type="number" min="0" max="99" value="${next}" required />`, 'Use 0 for specials.')}
          ${errorBox}
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Add season</button></div></form>`,
    });
    modal.el.querySelector('input[name="number"]').select();
    modal.el.querySelector('#season-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await A().api(`/api/admin/series/${encodeURIComponent(series.id)}/seasons`, { method: 'POST', body: { number: Number(e.target.number.value) } });
        await VF.refreshSeries();
        modal.close();
      } catch (err) {
        showError(modal.el, err.message);
      }
    });
  }

  async function removeSeason(series, number) {
    const ok = await confirmDialog({ title: `Remove ${seasonLabel(number)}?`, message: 'The season is empty, so only the heading is removed.', confirmText: 'Remove', danger: true });
    if (!ok) return;
    try {
      await A().api(`/api/admin/series/${encodeURIComponent(series.id)}/seasons/${number}`, { method: 'DELETE' });
      await VF.refreshSeries();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ─── Episodes ──────────────────────────────────────────────
  // Attach an existing video to a season of this series
  function openAddExisting(series, season) {
    const candidates = Object.values(store.videos).filter((v) => !v.seriesId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!candidates.length) {
      toast('Every video is already in a series. Upload new episodes instead.', 'info', 3500);
      return;
    }
    const modal = dialog({
      title: `Add an existing video to ${seasonLabel(season)}`,
      html: `<form class="edit-form" id="existing-form">
          ${field('Video', `<select class="select" name="video">${candidates.map((v) => `<option value="${esc(v.id)}">${esc(A().titleOf(v))} (${esc(v.status.toLowerCase())})</option>`).join('')}</select>`)}
          ${field('Episode number', `<input class="input" name="episode" type="number" min="1" max="9999" value="${nextEpisode(series.id, season)}" required />`)}
          ${errorBox}
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Add episode</button></div></form>`,
    });
    modal.el.querySelector('#existing-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const updated = await A().api(`/api/admin/series/${encodeURIComponent(series.id)}/episodes`, {
          method: 'POST', body: { videoId: e.target.video.value, seasonNumber: season, episodeNumber: Number(e.target.episode.value) },
        });
        mergeVideo(updated);
        await VF.refreshSeries();
        modal.close();
        toast('Episode added', 'success', 2000);
      } catch (err) {
        showError(modal.el, err.message);
      }
    });
  }

  // Add a video to a series, or change its series / season / number / title
  VF.openAssignDialog = function openAssignDialog(videoId) {
    const video = store.videos[videoId];
    if (!video) return;
    if (!store.series.length) {
      toast('Create a series first, then add this video to it.', 'info', 3500);
      location.hash = '#/series';
      return;
    }
    const current = video.seriesId || store.series[0].id;
    const season = video.seasonNumber ?? 1;
    const modal = dialog({
      title: video.seriesId ? 'Episode details' : 'Add to a series',
      html: `<form class="edit-form" id="assign-form">
          ${field('Series', `<select class="select" name="series">${store.series.map((s) => `<option value="${esc(s.id)}" ${s.id === current ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select>`)}
          <div class="two-fields">
            ${field('Season', `<input class="input" name="season" type="number" min="0" max="99" value="${season}" required />`, '0 = specials')}
            ${field('Episode number', `<input class="input" name="episode" type="number" min="1" max="9999" value="${video.episodeNumber ?? nextEpisode(current, season, videoId)}" required />`)}
          </div>
          ${field('Episode title', `<input class="input" name="title" maxlength="120" value="${esc(video.title || '')}" placeholder="${esc(video.originalName)}" />`, 'Shown on the public site. Leave empty to use the file name.')}
          ${errorBox}
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>`,
    });
    const form = modal.el.querySelector('#assign-form');
    // Suggest the next free number when the series or season changes
    const suggest = () => { if (!video.seriesId || form.series.value !== video.seriesId || Number(form.season.value) !== video.seasonNumber) form.episode.value = nextEpisode(form.series.value, Number(form.season.value), videoId); };
    form.series.addEventListener('change', suggest);
    form.season.addEventListener('input', suggest);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        let updated = await A().api(`/api/admin/videos/${encodeURIComponent(videoId)}/series`, {
          method: 'POST', body: { seriesId: form.series.value, seasonNumber: Number(form.season.value), episodeNumber: Number(form.episode.value) },
        });
        if (form.title.value.trim() !== (video.title || '')) {
          updated = await A().api(`/api/admin/videos/${encodeURIComponent(videoId)}`, { method: 'PATCH', body: { title: form.title.value.trim() } });
        }
        mergeVideo(updated);
        await VF.refreshSeries();
        modal.close();
        toast('Episode saved', 'success', 2200);
      } catch (err) {
        showError(modal.el, err.message);
      }
    });
  };

  VF.detachFromSeries = async function detachFromSeries(videoId) {
    const video = store.videos[videoId];
    const ok = await confirmDialog({
      title: 'Remove from the series?',
      message: `"${video ? A().titleOf(video) : videoId}" is kept as a standalone video, set to draft so it can't appear on the site by accident.`,
      confirmText: 'Remove',
    });
    if (!ok) return;
    try {
      mergeVideo(await A().api(`/api/admin/videos/${encodeURIComponent(videoId)}/series`, { method: 'DELETE' }));
      await VF.refreshSeries();
      toast('Removed from the series', 'success', 2200);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // ═════════════════════════════════════════════════════════
  // Series list
  // ═════════════════════════════════════════════════════════
  function mountList(root) {
    VF.refreshSeries(); // opening the page always shows the current list, not the last background refresh
    root.innerHTML = `
      <div class="page-head page-head-actions"><div><h1>Series</h1><p>Organise episodes into seasons and publish whole series.</p></div>
        <button class="btn btn-primary" id="new-series">${icon('tv', 16)} New series</button></div>
      <section class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Series</th><th>Seasons</th><th>Episodes</th><th>Visibility</th><th class="right">Actions</th></tr></thead>
          <tbody id="series-rows"></tbody></table></div>
        <div class="empty hidden" id="series-empty"></div>
      </section>`;
    const tbody = root.querySelector('#series-rows');
    const empty = root.querySelector('#series-empty');

    function render() {
      if (!store.seriesLoaded) return;
      reconcile(tbody, store.series, {
        key: (s) => s.id,
        html: (s) => `<tr class="clickable" data-href="#/series/${esc(s.id)}">
          <td><a class="name-cell" href="#/series/${esc(s.id)}">${A().thumb({ thumbnailUrl: s.posterUrl })}<span><span class="cell-title">${esc(s.title)}</span>
            <span class="cell-sub">${esc(snippet(s.description) || 'No description yet')}</span></span></a></td>
          <td>${plural(s.seasons.length, 'season')}</td>
          <td>${s.liveEpisodes} live <span class="muted">of ${s.episodeCount}</span></td>
          <td><button class="switch-btn ${s.published ? 'on' : ''}" role="switch" aria-checked="${s.published}" data-publish="${esc(s.id)}" data-to="${!s.published}" aria-label="${s.published ? 'Hide' : 'Publish'} ${esc(s.title)}"><span class="knob"></span></button>
            <span class="switch-label">${s.published ? 'Published' : 'Hidden'}</span></td>
          <td class="right nowrap"><a class="btn btn-ghost btn-sm" href="#/series/${esc(s.id)}">Manage</a>
            <button class="btn btn-ghost btn-sm btn-danger-text" data-delete="${esc(s.id)}">${icon('trash', 13)} Delete</button></td></tr>`,
      });
      empty.classList.toggle('hidden', store.series.length > 0);
      empty.innerHTML = store.series.length ? '' : `${icon('tv', 32)}<h3>No series yet</h3><p>Create a series, then upload or attach episodes to its seasons.</p><button class="btn btn-primary" id="empty-new">New series</button>`;
    }

    // The page container outlives this view, so the handler must be removed when the view is left
    const onClick = (e) => {
      if (e.target.closest('#new-series, #empty-new')) return openSeriesForm(null);
      const toggle = e.target.closest('[data-publish]');
      if (toggle) return setSeriesPublished(toggle.dataset.publish, toggle.dataset.to === 'true');
      const del = e.target.closest('[data-delete]');
      if (del) return openDeleteSeries(seriesById(del.dataset.delete));
      if (e.target.closest('button, a')) return;
      const row = e.target.closest('tr[data-href]');
      if (row) location.hash = row.dataset.href;
    };
    root.addEventListener('click', onClick);

    render();
    const unsub = store.subscribe((t) => { if (t.has('series') || t.has('videos')) render(); });
    return () => { unsub(); root.removeEventListener('click', onClick); };
  }

  // ═════════════════════════════════════════════════════════
  // One series: seasons and episodes
  // ═════════════════════════════════════════════════════════
  function mountDetail(root, id) {
    VF.refreshSeries();
    function episodeRow(v) {
      const publishable = v.status === 'COMPLETED';
      return `<tr>
        <td class="ep-col"><strong>${v.episodeNumber}</strong></td>
        <td><span class="name-cell">${A().thumb(v)}<span><span class="cell-title">${esc(A().titleOf(v))}</span>
          <span class="cell-sub">${esc(v.originalName)} • ${formatBytes(v.fileSize)}</span></span></span></td>
        <td>${A().pill(v.status)}${v.status === 'PROCESSING' ? ` <span class="pct">${Math.round(v.progress || 0)}%</span>` : ''}</td>
        <td>${publishable
          ? `<button class="switch-btn ${v.published ? 'on' : ''}" role="switch" aria-checked="${!!v.published}" data-ep-publish="${esc(v.id)}" data-to="${!v.published}" aria-label="${v.published ? 'Unpublish' : 'Publish'} episode ${v.episodeNumber}"><span class="knob"></span></button> <span class="switch-label">${v.published ? 'Published' : 'Draft'}</span>`
          : '<span class="muted">—</span>'}</td>
        <td>${esc(A().durationOf(v))}</td>
        <td class="right nowrap"><button class="btn btn-ghost btn-sm" data-ep-edit="${esc(v.id)}">Edit</button>
          <button class="icon-btn" data-menu-anchor data-id="${esc(v.id)}" aria-label="More actions for episode ${v.episodeNumber}" aria-haspopup="menu">${icon('dots', 18)}</button></td></tr>`;
    }

    function render() {
      const series = seriesById(id);
      if (!store.seriesLoaded || !store.loaded) { root.innerHTML = '<div class="spinner" role="status" aria-label="Loading"></div>'; return; }
      if (!series) {
        root.innerHTML = `<a class="back-link" href="#/series">${icon('back', 16)} All series</a><div class="empty">${icon('tv', 32)}<h3>Series not found</h3><p>It may have been deleted.</p></div>`;
        return;
      }
      document.title = `${series.title} — VideoStream Admin`;
      const episodes = episodesOf(id);
      const live = episodes.filter(isLive).length;
      const seasons = [...new Set([...series.seasons, ...episodes.map((e) => e.seasonNumber)])].sort((a, b) => a - b);

      root.innerHTML = `
        <a class="back-link" href="#/series">${icon('back', 16)} All series</a>
        <section class="card series-head">
          <div class="series-poster">${A().previewHtml(series.posterUrl)}</div>
          <div class="series-head-main">
            <h1>${esc(series.title)}</h1>
            <p class="muted-text">${esc(series.description || 'No description yet. Add one with Edit details.')}</p>
            <div class="series-meta"><span>${plural(seasons.length, 'season')}</span><span>${plural(episodes.length, 'episode')}</span><span>${live} live on the site</span></div>
          </div>
          <div class="series-head-actions">
            <div class="series-visibility"><button class="switch-btn ${series.published ? 'on' : ''}" role="switch" aria-checked="${series.published}" data-series-publish="${!series.published}" aria-label="${series.published ? 'Hide' : 'Publish'} series"><span class="knob"></span></button>
              <span class="switch-label">${series.published ? 'Published' : 'Hidden'}</span></div>
            <button class="btn btn-ghost btn-sm" data-edit-series>${icon('edit', 14)} Edit details</button>
            <button class="btn btn-ghost btn-sm btn-danger-text" data-delete-series>${icon('trash', 13)} Delete series</button>
          </div>
        </section>
        ${series.published && live === 0 ? `<div class="alert-box note">This series is published, but nothing shows on the site yet. It appears once at least one episode is finished <em>and</em> published.</div>` : ''}
        ${!series.published && live > 0 ? `<div class="alert-box note">${plural(live, 'episode')} ${live === 1 ? 'is' : 'are'} published, but the series is hidden, so viewers see nothing yet. Switch the series to Published.</div>` : ''}
        ${seasons.map((n) => {
          const inSeason = episodes.filter((e) => e.seasonNumber === n);
          return `<section class="card season-card">
            <div class="card-head"><h2 class="card-title">${seasonLabel(n)} <span class="muted">· ${plural(inSeason.length, 'episode')}</span></h2>
              <div class="head-actions">
                <a class="btn btn-primary btn-sm" href="#/upload?series=${encodeURIComponent(id)}&season=${n}">${icon('upload', 14)} Upload episodes</a>
                <button class="btn btn-ghost btn-sm" data-add-existing="${n}">Add existing video</button>
                ${inSeason.length === 0 ? `<button class="btn btn-ghost btn-sm btn-danger-text" data-remove-season="${n}">Remove season</button>` : ''}
              </div></div>
            ${inSeason.length ? `<div class="table-wrap"><table class="table">
              <thead><tr><th class="ep-col">#</th><th>Episode</th><th>Status</th><th>Visibility</th><th>Duration</th><th class="right">Actions</th></tr></thead>
              <tbody>${inSeason.map(episodeRow).join('')}</tbody></table></div>`
              : `<p class="muted-text pad-sm">No episodes yet. Upload files straight into this season, or add videos you already have.</p>`}
          </section>`;
        }).join('')}
        <button class="btn btn-ghost" data-add-season>${icon('tv', 15)} Add a season</button>`;
    }

    const onClick = (e) => {
      const series = seriesById(id);
      if (!series) return;
      const get = (sel) => e.target.closest(sel);
      let el;
      if ((el = get('[data-series-publish]'))) return setSeriesPublished(id, el.dataset.seriesPublish === 'true');
      if (get('[data-edit-series]')) return openSeriesForm(series);
      if (get('[data-delete-series]')) return openDeleteSeries(series);
      if (get('[data-add-season]')) return openAddSeason(series);
      if ((el = get('[data-add-existing]'))) return openAddExisting(series, Number(el.dataset.addExisting));
      if ((el = get('[data-remove-season]'))) return removeSeason(series, Number(el.dataset.removeSeason));
      if ((el = get('[data-ep-publish]'))) return A().setPublished(el.dataset.epPublish, el.dataset.to === 'true').then(() => VF.refreshSeries());
      if ((el = get('[data-ep-edit]'))) return VF.openAssignDialog(el.dataset.epEdit);
      if ((el = get('[data-menu-anchor]')) && store.videos[el.dataset.id]) A().rowMenu(el, store.videos[el.dataset.id]);
    };
    root.addEventListener('click', onClick);

    render();
    let queued = false;
    const unsub = store.subscribe((t) => {
      if (!(t.has('series') || t.has('videos'))) return;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; render(); });
    });
    return () => { unsub(); root.removeEventListener('click', onClick); };
  }

  VF.views.series = {
    title: (route) => { const s = route && route.param ? seriesById(route.param) : null; return s ? s.title : 'Series'; },
    mount(root, route) { return route.param ? mountDetail(root, route.param) : mountList(root); },
  };
})();
