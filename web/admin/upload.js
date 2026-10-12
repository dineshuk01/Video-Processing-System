/* ============================================================
   VideoStream — upload manager + Upload Video page
   An upload keeps running while you navigate between pages,
   because its state lives here and not in the page.
   ============================================================ */
(function () {
  const VF = window.VF;
  const { esc, formatBytes, formatEta, toast, reconcile } = VF;
  const QUALITIES = [360, 480, 720, 1080];

  const MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska' };
  const MAX_PARALLEL = 2;
  let seq = 0;

  function resolveType(file) {
    if (Object.values(MIME_BY_EXT).includes(file.type)) return file.type;
    // Browsers often report an empty type for .mkv, so fall back to the extension
    return MIME_BY_EXT[(file.name.split('.').pop() || '').toLowerCase()] || null;
  }

  const emit = () => VF.store.emit('uploads');

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || `Request failed (HTTP ${res.status})`);
    return json.data;
  }

  function putFile(item, uploadUrl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      const started = Date.now();
      let lastEmit = 0;
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', item.type);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const elapsed = (Date.now() - started) / 1000;
        item.loaded = e.loaded;
        item.pct = Math.round((e.loaded / e.total) * 100);
        item.speed = elapsed > 0.5 ? e.loaded / elapsed : 0;
        item.eta = item.speed > 0 ? (e.total - e.loaded) / item.speed : Infinity;
        if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); emit(); }
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('cancelled'));
      xhr.send(item.file);
    });
  }

  function discardRecord(videoId) {
    fetch(`/api/admin/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' }).catch(() => {});
  }

  async function run(item) {
    item.state = 'uploading';
    item.pct = 0;
    emit();
    try {
      const { videoId, uploadUrl } = await post('/api/admin/upload/initiate', {
        filename: item.file.name, contentType: item.type, fileSize: item.file.size,
        qualities: item.options.qualities, autoPublish: item.options.autoPublish, allowUpscale: item.options.allowUpscale,
        seriesId: item.options.seriesId, seasonNumber: item.options.seasonNumber, episodeNumber: item.options.episodeNumber,
      });
      item.videoId = videoId;
      if (item.cancelled) throw new Error('cancelled');

      await putFile(item, uploadUrl);

      item.pct = 100;
      item.state = 'finalizing'; // too late to cancel once the file is up
      emit();
      await post('/api/admin/upload/complete', { videoId });

      item.state = 'done';
      toast(`"${item.file.name}" uploaded. Processing has started.`, 'success');
    } catch (err) {
      if (item.videoId) discardRecord(item.videoId); // don't leave an orphaned PENDING record
      if (item.cancelled || err.message === 'cancelled') {
        uploads.items = uploads.items.filter((i) => i !== item);
      } else {
        item.state = 'error';
        item.error = err.message;
      }
    }
    item.xhr = null;
    emit();
    pump();
  }

  function pump() {
    const running = uploads.items.filter((i) => i.state === 'uploading' || i.state === 'finalizing').length;
    let slots = MAX_PARALLEL - running;
    for (const item of uploads.items) {
      if (slots <= 0) break;
      if (item.state === 'queued') { slots--; run(item); }
    }
  }

  const uploads = {
    items: [],
    activeCount: () => uploads.items.filter((i) => ['queued', 'uploading', 'finalizing'].includes(i.state)).length,
    stagedCount: () => uploads.items.filter((i) => i.state === 'staged').length,

    stage(fileList) {
      for (const file of fileList) {
        const type = resolveType(file);
        if (!type) { toast(`"${file.name}" is not supported. Use MP4, MOV or MKV.`, 'error'); continue; }
        if (file.size === 0) { toast(`"${file.name}" is empty.`, 'error'); continue; }
        if (file.size > VF.config.maxUploadBytes) {
          toast(`"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(VF.config.maxUploadBytes)}.`, 'error');
          continue;
        }
        uploads.items.push({ id: ++seq, file, type, state: 'staged', pct: 0, loaded: 0, speed: 0, eta: Infinity, error: '', videoId: null, xhr: null, cancelled: false, options: { qualities: QUALITIES, autoPublish: false, allowUpscale: false } });
      }
      emit();
    },
    // `options` are the processing settings chosen on the page at the moment Upload is pressed
    startStaged(options) {
      // Episodes are numbered in the order of the upload list, starting at options.firstEpisode
      let n = options.firstEpisode || 1;
      uploads.items.filter((i) => i.state === 'staged').forEach((i) => {
        i.state = 'queued';
        i.options = options.seriesId ? { ...options, episodeNumber: n++ } : options;
      });
      emit();
      pump();
    },
    remove(id) {
      uploads.items = uploads.items.filter((i) => i.id !== id);
      emit();
    },
    cancel(id) {
      const item = uploads.items.find((i) => i.id === id);
      if (!item) return;
      if (item.state === 'queued') return uploads.remove(id);
      item.cancelled = true; // run()'s catch block cleans up and removes the row
      if (item.xhr) item.xhr.abort();
      toast(`Cancelled "${item.file.name}"`, 'info', 2500);
    },
    retry(id) {
      const item = uploads.items.find((i) => i.id === id);
      if (!item) return;
      item.state = 'queued'; item.error = ''; item.cancelled = false; item.videoId = null;
      emit();
      pump();
    },
    clearFinished() {
      uploads.items = uploads.items.filter((i) => i.state !== 'done');
      emit();
    },
  };
  VF.uploads = uploads;

  window.addEventListener('beforeunload', (e) => {
    if (uploads.activeCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // ─── Page ──────────────────────────────────────────────────
  function rowHtml(item) {
    const name = `<div class="up-name" title="${esc(item.file.name)}">${esc(item.file.name)}</div>`;
    const size = `<div class="up-size">${formatBytes(item.file.size)}</div>`;
    const iconBtn = (act, label, icon) =>
      `<button class="icon-btn" data-act="${act}" data-id="${item.id}" aria-label="${label} ${esc(item.file.name)}">${VF.icon(icon, 16)}</button>`;

    switch (item.state) {
      case 'staged':
        return `<li class="up-row">${name}${size}<span class="up-note">Ready to upload</span>${iconBtn('remove', 'Remove', 'x')}</li>`;
      case 'queued':
        return `<li class="up-row">${name}${size}<span class="up-note">Waiting for a free slot…</span>${iconBtn('cancel', 'Cancel', 'x')}</li>`;
      case 'uploading': {
        const detail = `${item.pct}% · ${formatBytes(item.loaded)} of ${formatBytes(item.file.size)}${item.speed ? ` · ${formatBytes(item.speed)}/s` : ''}${isFinite(item.eta) && item.eta > 0 ? ` · ${formatEta(item.eta)}` : ''}`;
        return `<li class="up-row up-row-active"><div class="up-main">${name}${size}${iconBtn('cancel', 'Cancel', 'x')}</div>
          <div class="progress"><div class="progress-bar" style="width:${item.pct}%"></div></div><div class="up-note">${esc(detail)}</div></li>`;
      }
      case 'finalizing':
        return `<li class="up-row up-row-active"><div class="up-main">${name}${size}</div>
          <div class="progress"><div class="progress-bar" style="width:100%"></div></div><div class="up-note">Upload complete — starting processing…</div></li>`;
      case 'done':
        return `<li class="up-row up-row-done">${name}${size}<span class="up-note ok">${VF.icon('check', 14)} Sent to the processing queue</span>
          <a class="btn btn-ghost btn-sm" href="#/jobs">View jobs</a></li>`;
      default:
        return `<li class="up-row up-row-error"><div class="up-main">${name}${size}</div><div class="up-note err">${esc(item.error)}</div>
          <div class="up-actions"><button class="btn btn-ghost btn-sm" data-act="retry" data-id="${item.id}">Retry</button>${iconBtn('remove', 'Dismiss', 'x')}</div></li>`;
    }
  }

  VF.views.upload = {
    title: () => 'Upload Video',
    mount(root, route) {
      root.innerHTML = `
        <div class="page-head">
          <h1>Upload Video</h1>
          <p>Upload your video and it will be processed automatically (transcoding, HLS, thumbnails).</p>
        </div>

        <div class="card">
          <div class="dropzone" id="dropzone">
            <input type="file" id="file-input" multiple hidden
                   accept="video/mp4,video/quicktime,video/x-matroska,.mp4,.mov,.mkv" />
            <div class="dz-icon">${VF.icon('cloud', 40)}</div>
            <h2>Drag and drop your video here</h2>
            <span class="dz-or">or</span>
            <button class="btn btn-primary" id="choose-btn" type="button">Choose File</button>
            <p class="dz-hint">Supported formats: MP4, MOV, MKV &nbsp;|&nbsp; Max size: ${VF.config.maxUploadLabel} per file &nbsp;|&nbsp; You can add several files</p>
          </div>
        </div>

        <div class="card up-card hidden" id="queue-card">
          <div class="card-head"><h2 class="card-title">Uploads</h2><button class="link-btn" id="clear-done">Clear completed</button></div>
          <ul class="up-list" id="queue" aria-live="polite"></ul>
        </div>

        <div class="card">
          <div class="card-head"><h2 class="card-title">Processing Options</h2>
            <span class="chip" title="Applied to the videos in the upload list when you press Upload">Applies to this batch</span></div>
          <div class="opts">
            <fieldset class="opt">
              <legend>Output Qualities</legend>
              ${QUALITIES.map((q) => `<label class="check"><input type="checkbox" name="quality" value="${q}" checked /> ${q}p</label>`).join('')}
              <label class="check"><input type="checkbox" id="allow-upscale" /> Also create sizes larger than the source</label>
              <p class="opt-note" id="quality-note">A size is made when the video is at least that wide or tall, so widescreen 1280-wide films get a native 720p. Larger sizes are skipped unless you tick the box above. They are upscaled, so no extra detail, and take longer and use more storage.</p>
            </fieldset>
            <div class="opt">
              <span class="opt-label">Publishing</span>
              <label class="check"><input type="checkbox" id="auto-publish" /> Publish automatically when ready</label>
              <label for="up-series" class="opt-label-sm">Add to a series</label>
              <select id="up-series" class="select"><option value="">Not part of a series</option></select>
              <div class="series-slot hidden" id="up-series-slot">
                <label for="up-season">Season</label><input type="number" id="up-season" class="input" min="0" max="99" value="1" />
                <label for="up-first">First episode number</label><input type="number" id="up-first" class="input" min="1" max="9999" value="1" />
                <p class="opt-note">Files get consecutive numbers in the order of the list above. Rename episodes later from the series page.</p>
              </div>
              <p class="opt-note">Off by default: finished videos stay as drafts until you publish them from the Videos page.</p>
            </div>
            <div class="opt">
              <label for="fmt">Output Format</label>
              <select id="fmt" class="select" disabled><option>HLS (m3u8)</option></select>
              <p class="opt-note">Adaptive streaming with a poster thumbnail.</p>
            </div>
          </div>
          <div class="card-foot"><button class="btn btn-primary" id="start-btn" disabled>Upload &amp; Process</button></div>
        </div>`;

      const dz = root.querySelector('#dropzone');
      const input = root.querySelector('#file-input');
      const startBtn = root.querySelector('#start-btn');
      const queueCard = root.querySelector('#queue-card');
      const queue = root.querySelector('#queue');

      function render() {
        const items = uploads.items;
        queueCard.classList.toggle('hidden', items.length === 0);
        root.querySelector('#clear-done').classList.toggle('hidden', !items.some((i) => i.state === 'done'));
        reconcile(queue, items, { key: (i) => i.id, html: rowHtml });
        const staged = uploads.stagedCount();
        startBtn.disabled = staged === 0;
        startBtn.textContent = staged > 1 ? `Upload & Process (${staged})` : 'Upload & Process';
      }

      root.querySelector('#choose-btn').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
      dz.addEventListener('click', () => input.click());
      input.addEventListener('change', () => { uploads.stage(input.files); input.value = ''; });
      startBtn.addEventListener('click', () => {
        const qualities = [...root.querySelectorAll('input[name="quality"]:checked')].map((el) => Number(el.value));
        if (qualities.length === 0) {
          const note = root.querySelector('#quality-note');
          note.textContent = 'Choose at least one quality.';
          note.classList.add('err-text');
          return;
        }
        const seriesId = root.querySelector('#up-series').value;
        const seasonNumber = Number(root.querySelector('#up-season').value);
        const firstEpisode = Number(root.querySelector('#up-first').value);
        if (seriesId && (!Number.isInteger(seasonNumber) || seasonNumber < 0 || !Number.isInteger(firstEpisode) || firstEpisode < 1)) {
          toast('Enter a season (0 or more) and a first episode number (1 or more).', 'error');
          return;
        }
        uploads.startStaged({
          qualities, autoPublish: root.querySelector('#auto-publish').checked, allowUpscale: root.querySelector('#allow-upscale').checked,
          ...(seriesId ? { seriesId, seasonNumber, firstEpisode } : {}),
        });
      });
      root.querySelector('.opts').addEventListener('change', () => {
        const note = root.querySelector('#quality-note');
        note.textContent = 'A size is made when the video is at least that wide or tall, so widescreen 1280-wide films get a native 720p. Larger sizes are skipped unless you tick the box above. They are upscaled, so no extra detail, and take longer and use more storage.';
        note.classList.remove('err-text');
      });
      root.querySelector('#clear-done').addEventListener('click', () => uploads.clearFinished());

      // Series selector: fill from the live list, preselect from the link (#/upload?series=ID&season=N)
      const seriesSel = root.querySelector('#up-series');
      const seasonIn = root.querySelector('#up-season');
      const firstIn = root.querySelector('#up-first');
      const nextEpisode = () => 1 + Math.max(0, ...Object.values(VF.store.videos)
        .filter((v) => v.seriesId === seriesSel.value && v.seasonNumber === Number(seasonIn.value)).map((v) => v.episodeNumber || 0));
      const syncSlot = () => {
        root.querySelector('#up-series-slot').classList.toggle('hidden', !seriesSel.value);
        if (seriesSel.value) firstIn.value = nextEpisode();
      };
      VF.store.series.forEach((s) => seriesSel.add(new Option(s.title, s.id)));
      const wanted = route && route.query ? route.query.get('series') : null;
      if (wanted && VF.store.series.some((s) => s.id === wanted)) {
        seriesSel.value = wanted;
        if (route.query.get('season') !== null) seasonIn.value = route.query.get('season');
      }
      seriesSel.addEventListener('change', syncSlot);
      seasonIn.addEventListener('input', syncSlot);
      syncSlot();

      ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
      ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
      dz.addEventListener('drop', (e) => uploads.stage(e.dataTransfer.files));

      queue.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        if (btn.dataset.act === 'remove') uploads.remove(id);
        else if (btn.dataset.act === 'cancel') uploads.cancel(id);
        else if (btn.dataset.act === 'retry') uploads.retry(id);
      });

      // A missed drop would make the browser open the file and leave the app
      const stop = (e) => { if (!e.target.closest('#dropzone')) e.preventDefault(); };
      window.addEventListener('dragover', stop);
      window.addEventListener('drop', stop);

      const unsubscribe = VF.store.subscribe((types) => { if (types.has('uploads')) render(); });
      render();

      return () => {
        unsubscribe();
        window.removeEventListener('dragover', stop);
        window.removeEventListener('drop', stop);
      };
    },
  };
})();
