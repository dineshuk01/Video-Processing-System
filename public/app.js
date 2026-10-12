/* ============================================================
   VideoFlow — Dashboard logic (library, live updates, uploads)
   Depends on common.js (window.VF)
   ============================================================ */
const { esc, formatBytes, timeAgo, formatDuration, formatEta, toast, confirmDialog, copyText } = window.VF;

// Mirrors the server default (MAX_UPLOAD_SIZE_MB=1000) and ALLOWED_MIME_TYPES
const MAX_UPLOAD_BYTES = 1000 * 1024 * 1024;
const MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska' };
const ACTIVE_STATUSES = ['PENDING', 'UPLOADING', 'UPLOADED', 'PROCESSING'];

// ─── State ──────────────────────────────────────────────────
const state = {
  videos: {},          // videoId -> VideoRecord
  cards: {},           // videoId -> card element
  deleted: new Set(),  // ids deleted locally, so a late SSE event can't resurrect the card
  loaded: false,
  uploads: new Set(),  // in-flight upload items
  view: { search: '', filter: 'all', sort: 'newest' },
};
let uploadSeq = 0;

// ─── DOM refs ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const uploadZone = $('upload-zone');
const fileInput  = $('file-input');
const uploadList = $('upload-list');
const videoGrid  = $('video-grid');
const emptyState = $('empty-state');
const searchEl   = $('search');
const filterEl   = $('filter');
const sortEl     = $('sort');
const connEl     = $('conn');
const connLabel  = $('conn-label');

// ─── Persisted view preferences (best effort) ───────────────
try {
  const saved = JSON.parse(localStorage.getItem('vf-view') || '{}');
  if (saved.filter) state.view.filter = saved.filter;
  if (saved.sort) state.view.sort = saved.sort;
} catch { /* storage unavailable */ }
filterEl.value = state.view.filter;
sortEl.value = state.view.sort;
if (filterEl.value !== state.view.filter) filterEl.value = state.view.filter = 'all';
if (sortEl.value !== state.view.sort) sortEl.value = state.view.sort = 'newest';

function savePrefs() {
  try {
    localStorage.setItem('vf-view', JSON.stringify({ filter: state.view.filter, sort: state.view.sort }));
  } catch { /* ignore */ }
}

// ─── Video cards ────────────────────────────────────────────
const STATUS_LABEL = {
  PENDING: 'Pending', UPLOADING: 'Uploading', UPLOADED: 'Queued',
  PROCESSING: 'Processing', COMPLETED: 'Ready', FAILED: 'Failed',
};

// Progress milestones come from transcoderTask.ts
function phaseText(progress) {
  if (progress < 10) return 'Preparing video';
  if (progress <= 80) return 'Encoding resolutions';
  if (progress < 91) return 'Creating thumbnail & captions';
  return 'Publishing files';
}

function progressHtml(v) {
  const progress = Math.round(v.progress || 0);
  switch (v.status) {
    case 'PENDING':
    case 'UPLOADING':
      return `<div class="card-progress"><div class="card-progress-label"><span>Waiting for the upload to finish…</span></div>
        <div class="card-progress-track indeterminate"><div class="card-progress-fill fill-idle"></div></div></div>`;
    case 'UPLOADED':
      return `<div class="card-progress"><div class="card-progress-label"><span>In queue — waiting for a transcoder</span></div>
        <div class="card-progress-track indeterminate"><div class="card-progress-fill fill-idle"></div></div></div>`;
    case 'PROCESSING':
      return `<div class="card-progress"><div class="card-progress-label"><span>${phaseText(progress)}…</span><span>${progress}%</span></div>
        <div class="card-progress-track"><div class="card-progress-fill fill-processing" style="width:${progress}%"></div></div></div>`;
    case 'FAILED':
      return v.error ? `<div class="error-text" title="${esc(v.error)}">${esc(v.error)}</div>` : '';
    default:
      return '';
  }
}

function posterHtml(v) {
  const ready = v.status === 'COMPLETED';
  const dur = v.metadata && v.metadata.duration ? formatDuration(v.metadata.duration) : '';
  const res = v.metadata && v.metadata.height ? `${v.metadata.height}p` : '';
  const inner = `
    ${v.thumbnailUrl
      ? `<img src="${esc(v.thumbnailUrl)}" alt="" loading="lazy" />`
      : `<span class="poster-placeholder" aria-hidden="true">🎬</span>`}
    ${ready ? '<span class="play-overlay" aria-hidden="true"><span>▶</span></span>' : ''}
    ${res ? `<span class="badge-res">${esc(res)}</span>` : ''}
    ${dur ? `<span class="badge-dur">${esc(dur)}</span>` : ''}`;
  return ready
    ? `<a class="card-poster" href="player.html?id=${encodeURIComponent(v.id)}" aria-label="Watch ${esc(v.originalName)}">${inner}</a>`
    : `<div class="card-poster">${inner}</div>`;
}

function renderCardHtml(v) {
  const ready = v.status === 'COMPLETED';
  return `
    ${posterHtml(v)}
    <div class="card-body">
      <div class="card-header">
        <div class="card-title">
          <div class="card-filename" title="${esc(v.originalName)}">${esc(v.originalName)}</div>
          <div class="card-id">${esc(v.id)}</div>
        </div>
        <span class="status-badge status-${esc(v.status)}">${esc(STATUS_LABEL[v.status] || v.status)}</span>
      </div>
      ${progressHtml(v)}
      <div class="card-meta">
        <span>${formatBytes(v.fileSize)}</span>
        <span aria-hidden="true">·</span>
        <span data-ago="${esc(v.createdAt)}" title="${esc(new Date(v.createdAt).toLocaleString())}">${timeAgo(v.createdAt)}</span>
      </div>
      <div class="card-footer">
        <button class="btn btn-ghost btn-sm btn-danger-text" data-action="delete" data-id="${esc(v.id)}">Delete</button>
        <div class="card-footer-right">
          ${ready && v.hlsPlaylistUrl ? `<button class="btn btn-ghost btn-sm" data-action="copy" data-url="${esc(v.hlsPlaylistUrl)}">Copy stream URL</button>` : ''}
          ${ready ? `<a class="btn btn-watch btn-sm" href="player.html?id=${encodeURIComponent(v.id)}">▶ Watch</a>` : ''}
        </div>
      </div>
    </div>`;
}

function upsertCard(video, { defer = false } = {}) {
  if (state.deleted.has(video.id)) return;
  state.videos[video.id] = video;

  const existing = state.cards[video.id];
  const el = document.createElement('article');
  el.className = `video-card${existing ? ' no-anim' : ''}`; // only animate on first appearance
  el.id = `card-${video.id}`;
  el.dataset.status = video.status;
  el.innerHTML = renderCardHtml(video);

  if (existing) existing.replaceWith(el);
  else videoGrid.appendChild(el);
  state.cards[video.id] = el;

  if (!defer) applyView();
}

function removeCard(id) {
  delete state.videos[id];
  const el = state.cards[id];
  if (el) {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }
  delete state.cards[id];
  applyView();
}

// ─── Filtering, sorting, stats ──────────────────────────────
function matches(v) {
  const { search, filter } = state.view;
  if (filter === 'active' && !ACTIVE_STATUSES.includes(v.status)) return false;
  if ((filter === 'COMPLETED' || filter === 'FAILED') && v.status !== filter) return false;
  if (search) {
    const q = search.toLowerCase();
    if (!v.originalName.toLowerCase().includes(q) && !v.id.toLowerCase().includes(q)) return false;
  }
  return true;
}

const SORTERS = {
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  name:   (a, b) => a.originalName.localeCompare(b.originalName),
  size:   (a, b) => (b.fileSize || 0) - (a.fileSize || 0),
};

function applyView() {
  const all = Object.values(state.videos);
  const sorted = all.slice().sort(SORTERS[state.view.sort] || SORTERS.newest);

  let visible = 0;
  for (const v of sorted) {
    const el = state.cards[v.id];
    if (!el) continue;
    const show = matches(v);
    el.hidden = !show;
    if (show) visible++;
    videoGrid.appendChild(el); // appending an existing node moves it, giving us the sort order
  }

  // Stats
  const count = (fn) => all.filter(fn).length;
  const processing = count((v) => ACTIVE_STATUSES.includes(v.status));
  $('stat-total').textContent = all.length;
  $('stat-processing').textContent = processing;
  $('stat-completed').textContent = count((v) => v.status === 'COMPLETED');
  $('stat-failed').textContent = count((v) => v.status === 'FAILED');
  document.title = processing > 0 ? `(${processing}) VideoFlow — Dashboard` : 'VideoFlow — Video Processing Dashboard';

  renderEmptyState(all.length, visible);
}

function renderEmptyState(total, visible) {
  if (!state.loaded || visible > 0) {
    emptyState.classList.add('hidden');
    return;
  }
  emptyState.classList.remove('hidden');
  if (total === 0) {
    emptyState.innerHTML = `
      <div class="empty-icon" aria-hidden="true">🎥</div>
      <h3>No videos yet</h3>
      <p>Drop your first video above and it will show up here with live progress.</p>`;
  } else {
    emptyState.innerHTML = `
      <div class="empty-icon" aria-hidden="true">🔍</div>
      <h3>No matching videos</h3>
      <p>Try a different search or filter.</p>
      <button class="btn btn-ghost" id="clear-filters">Clear filters</button>`;
  }
}

emptyState.addEventListener('click', (e) => {
  if (e.target.id !== 'clear-filters') return;
  searchEl.value = '';
  filterEl.value = 'all';
  state.view.search = '';
  state.view.filter = 'all';
  savePrefs();
  applyView();
});

let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.view.search = searchEl.value.trim(); applyView(); }, 150);
});
filterEl.addEventListener('change', () => { state.view.filter = filterEl.value; savePrefs(); applyView(); });
sortEl.addEventListener('change', () => { state.view.sort = sortEl.value; savePrefs(); applyView(); });

// Keep "5 min ago" labels fresh
setInterval(() => {
  document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = timeAgo(el.dataset.ago); });
}, 30000);

// ─── Card actions (event delegation) ────────────────────────
videoGrid.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'copy') return copyText(btn.dataset.url, 'Stream URL copied');
  if (btn.dataset.action === 'delete') return deleteVideo(btn.dataset.id);
});

// A broken thumbnail should fall back to the placeholder instead of showing a broken image
videoGrid.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') {
    const placeholder = document.createElement('span');
    placeholder.className = 'poster-placeholder';
    placeholder.textContent = '🎬';
    e.target.replaceWith(placeholder);
  }
}, true);

async function deleteVideo(id) {
  const video = state.videos[id];
  const ok = await confirmDialog({
    title: 'Delete this video?',
    message: `"${video ? video.originalName : id}" and all of its transcoded files will be permanently removed.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;

  try {
    const res = await fetch(`/api/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    state.deleted.add(id);
    removeCard(id);
    toast('Video deleted', 'success');
  } catch (err) {
    toast(`Failed to delete video: ${err.message}`, 'error');
  }
}

// ─── Live updates (SSE) with polling fallback ───────────────
function setConn(kind, label) {
  connEl.className = `conn conn-${kind}`;
  connLabel.textContent = label;
}

function showSkeletons() {
  videoGrid.innerHTML = Array.from({ length: 3 }, () => `
    <div class="video-card skeleton" aria-hidden="true">
      <div class="card-poster"></div>
      <div class="card-body"><div class="sk-line w60"></div><div class="sk-line w40"></div><div class="sk-line w80"></div></div>
    </div>`).join('');
}

function loadAll(videos) {
  videoGrid.innerHTML = '';
  state.cards = {};
  state.videos = {};
  videos.forEach((v) => upsertCard(v, { defer: true }));
  state.loaded = true;
  applyView();
}

let fallbackStarted = false;
async function loadViaFetch() {
  if (state.loaded || fallbackStarted) return;
  fallbackStarted = true;
  try {
    const res = await fetch('/api/videos?page=1&limit=100');
    const json = await res.json();
    if (json.success) loadAll(json.data.videos);
  } catch { /* SSE reconnect will retry */ }
  fallbackStarted = false;
}

function initSSE() {
  showSkeletons();
  const source = new EventSource('/api/events');

  source.addEventListener('initial-load', (e) => loadAll(JSON.parse(e.data)));
  source.addEventListener('video-update', (e) => {
    if (!state.loaded) return;
    upsertCard(JSON.parse(e.data));
  });

  source.onopen = () => setConn('live', 'Live');
  source.onerror = () => {
    setConn('offline', 'Reconnecting…');
    setTimeout(loadViaFetch, 3000); // show something if the stream can't connect
  };
}

// ─── Uploads ────────────────────────────────────────────────
function resolveType(file) {
  if (Object.values(MIME_BY_EXT).includes(file.type)) return file.type;
  // Browsers often report an empty type for .mkv; fall back to the extension
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function uploadItemHtml(item) {
  return `
    <div class="up-top">
      <div class="up-name" title="${esc(item.file.name)}">${esc(item.file.name)}</div>
      <div class="up-size">${formatBytes(item.file.size)}</div>
      <button class="icon-btn" data-up="cancel" aria-label="Cancel upload of ${esc(item.file.name)}">✕</button>
    </div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="up-status">Starting…</div>`;
}

function setUpStatus(item, text, kind) {
  const status = item.el.querySelector('.up-status');
  status.textContent = text;
  item.el.dataset.state = kind || 'active';
}

function setUpProgress(item, pct) {
  item.el.querySelector('.progress-fill').style.width = `${pct}%`;
}

function finishUploadItem(item, delay) {
  state.uploads.delete(item);
  setTimeout(() => {
    item.el.classList.add('leaving');
    setTimeout(() => item.el.remove(), 250);
  }, delay);
}

function addUpload(file) {
  const type = resolveType(file);
  if (!type) {
    toast(`"${file.name}" is not supported. Use MP4, MOV or MKV.`, 'error');
    return;
  }
  if (file.size === 0) {
    toast(`"${file.name}" is empty.`, 'error');
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(`"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`, 'error');
    return;
  }

  const item = { id: ++uploadSeq, file, type, xhr: null, videoId: null, cancelled: false, el: null };
  item.el = document.createElement('li');
  item.el.className = 'upload-item';
  item.el.innerHTML = uploadItemHtml(item);
  item.el.__file = file; // lets the Retry button restart this upload
  uploadList.appendChild(item.el);
  state.uploads.add(item);
  runUpload(item);
}

function putFile(item, uploadUrl) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const started = Date.now();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', item.type);

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      const elapsed = (Date.now() - started) / 1000;
      const speed = elapsed > 0.5 ? e.loaded / elapsed : 0;
      const eta = speed > 0 ? formatEta((e.total - e.loaded) / speed) : '';
      setUpProgress(item, pct);
      setUpStatus(item, `Uploading ${pct}% · ${formatBytes(e.loaded)} of ${formatBytes(e.total)}${speed ? ` · ${formatBytes(speed)}/s` : ''}${eta ? ` · ${eta}` : ''}`);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(item.file);
  });
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || `Request failed (HTTP ${res.status})`);
  return json.data;
}

async function runUpload(item) {
  try {
    setUpStatus(item, 'Preparing upload…');
    const { videoId, uploadUrl } = await api('/api/upload/initiate', {
      filename: item.file.name,
      contentType: item.type,
      fileSize: item.file.size,
    });
    item.videoId = videoId;
    if (item.cancelled) throw new Error('cancelled');

    await putFile(item, uploadUrl);

    item.el.querySelector('[data-up="cancel"]')?.remove(); // too late to cancel once the file is uploaded
    setUpProgress(item, 100);
    setUpStatus(item, 'Upload complete — starting transcoding…');
    await api('/api/upload/complete', { videoId });

    setUpStatus(item, 'Sent to the transcoding queue ✓', 'done');
    toast(`"${item.file.name}" uploaded. Transcoding has started.`, 'success');
    finishUploadItem(item, 4000);
  } catch (err) {
    if (item.videoId) discardRecord(item.videoId); // don't leave an orphaned PENDING record
    if (item.cancelled || err.message === 'cancelled') {
      finishUploadItem(item, 0);
      return;
    }
    setUpStatus(item, err.message, 'error');
    const cancel = item.el.querySelector('[data-up="cancel"]');
    const actions = '<button class="btn btn-ghost btn-sm" data-up="retry">Retry</button><button class="icon-btn" data-up="dismiss" aria-label="Dismiss">✕</button>';
    if (cancel) cancel.outerHTML = actions;
    else item.el.querySelector('.up-top').insertAdjacentHTML('beforeend', actions);
    state.uploads.delete(item);
  }
}

function discardRecord(videoId) {
  fetch(`/api/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' }).catch(() => {});
}

uploadList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-up]');
  if (!btn || !btn.dataset.up) return;
  const li = btn.closest('.upload-item');
  const item = [...state.uploads].find((u) => u.el === li);

  switch (btn.dataset.up) {
    case 'cancel':
      if (!item) return;
      item.cancelled = true; // runUpload's catch block aborts, cleans up and removes the row
      if (item.xhr) item.xhr.abort();
      toast(`Cancelled "${item.file.name}"`, 'info', 2500);
      break;
    case 'dismiss':
      li.remove();
      break;
    case 'retry':
      if (li.__file) { const file = li.__file; li.remove(); addUpload(file); }
      break;
  }
});

function handleFiles(fileList) {
  [...fileList].forEach(addUpload);
}

fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = ''; // allow choosing the same file again
});

['dragenter', 'dragover'].forEach((evt) =>
  uploadZone.addEventListener(evt, (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((evt) =>
  uploadZone.addEventListener(evt, (e) => { e.preventDefault(); uploadZone.classList.remove('dragover'); }));
uploadZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

// A missed drop would make the browser navigate to the file and lose the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

window.addEventListener('beforeunload', (e) => {
  if (state.uploads.size > 0) { e.preventDefault(); e.returnValue = ''; }
});

// ─── Boot ───────────────────────────────────────────────────
initSSE();
