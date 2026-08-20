/* ============================================================
   EternityStream — Wedding Cinema Suite Admin Application Logic
   ============================================================ */

// ─── State ──────────────────────────────────────────────────
const state = {
  videos: {},       // videoId -> VideoRecord
  uploading: false,
  selectedFile: null,
};

// ─── DOM Refs ────────────────────────────────────────────────
const uploadZone     = document.getElementById('upload-zone');
const fileInput      = document.getElementById('file-input');
const uploadSelected = document.getElementById('upload-selected');
const uploadBtn      = document.getElementById('upload-btn');
const progressWrap   = document.getElementById('progress-wrap');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const videoGrid      = document.getElementById('video-grid');
const totalCount     = document.getElementById('total-count');
const liveBadge      = document.getElementById('live-badge');
const categorySelect = document.getElementById('category-select');

const loginModal     = document.getElementById('login-modal');
const loginForm      = document.getElementById('login-form');
const adminPassInput = document.getElementById('admin-pass-input');
const loginError     = document.getElementById('login-error');
const logoutBtn      = document.getElementById('logout-btn');

// ─── Auth Token Helper ───────────────────────────────────────
function getAdminToken() {
  return sessionStorage.getItem('adminToken') || '';
}

function checkAuth() {
  const token = getAdminToken();
  if (token) {
    if (loginModal) loginModal.style.display = 'none';
    if (logoutBtn) logoutBtn.classList.remove('hidden');
  } else {
    if (loginModal) loginModal.style.display = 'flex';
    if (logoutBtn) logoutBtn.classList.add('hidden');
  }
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.style.display = 'none';
    const password = adminPassInput.value;

    try {
      const res = await fetch('/api/upload/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const json = await res.json();

      if (!json.success) {
        throw new Error(json.error?.message || 'Invalid admin password');
      }

      sessionStorage.setItem('adminToken', json.data.token);
      checkAuth();
      adminPassInput.value = '';
    } catch (err) {
      loginError.textContent = `❌ ${err.message}`;
      loginError.style.display = 'block';
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('adminToken');
    checkAuth();
  });
}

// ─── Format Helpers ──────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusBadgeHtml(status) {
  const map = {
    PENDING: '<span class="card-badge badge-pending">⏳ Pending</span>',
    UPLOADING: '<span class="card-badge badge-pending">⬆ Uploading</span>',
    UPLOADED: '<span class="card-badge badge-pending">☁ Uploaded</span>',
    PROCESSING: '<span class="card-badge badge-processing">⚙ Transcoding</span>',
    COMPLETED: '<span class="card-badge badge-completed">✅ Ready for Couples</span>',
    FAILED: '<span class="card-badge badge-failed">❌ Processing Error</span>',
  };
  return map[status] || `<span class="card-badge badge-pending">${status}</span>`;
}

// ─── Render Video Card HTML ───────────────────────────────────
function renderCard(v) {
  const isProcessing = v.status === 'PROCESSING';
  const isCompleted  = v.status === 'COMPLETED';
  const isFailed     = v.status === 'FAILED';

  const progress = v.progress || 0;
  const showProgress = ['PROCESSING', 'COMPLETED', 'FAILED'].includes(v.status);
  
  const categoryTag = v.category || (
    v.originalName.toLowerCase().includes('teaser') ? '✨ Teaser Reel' :
    v.originalName.toLowerCase().includes('ceremony') ? '🥂 Full Ceremony' :
    v.originalName.toLowerCase().includes('reception') ? '🎉 Reception' :
    '💍 Highlight Reel'
  );

  const thumbHtml = v.thumbnailUrl ? 
    `<img src="${v.thumbnailUrl}" alt="${v.originalName}" loading="lazy" />` : 
    `<div class="card-thumb-placeholder">🥂<span>Wedding Cinema</span></div>`;

  return `
    <div class="video-card" id="card-${v.id}">
      <div class="card-thumb">
        ${thumbHtml}
        <span class="wedding-tag-badge">${categoryTag}</span>
        ${statusBadgeHtml(v.status)}
      </div>

      <div class="card-body">
        <div class="card-title" title="${v.originalName}">${v.originalName}</div>
        
        <div class="card-meta">
          <span>📹 ${v.metadata ? `${v.metadata.width}x${v.metadata.height}` : 'HD Cinema'}</span>
          <span>💾 ${formatBytes(v.fileSize)}</span>
          <span>🕐 ${formatDate(v.createdAt)}</span>
        </div>

        ${showProgress ? `
          <div style="margin-bottom:1rem;">
            <div class="progress-label" style="font-size:0.75rem;">
              <span>${isCompleted ? 'HLS Stream Ready' : isProcessing ? 'Processing Multi-Bitrate HLS…' : 'Failed'}</span>
              <span>${progress}%</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width: ${progress}%;"></div>
            </div>
          </div>
        ` : ''}

        ${isFailed && v.error ? `<div style="color:var(--red);font-size:0.8rem;margin-bottom:0.75rem;">⚠ ${v.error}</div>` : ''}

        <div class="card-footer">
          <button class="btn btn-danger" style="font-size:0.75rem;padding:0.4rem 0.75rem;" onclick="deleteVideo('${v.id}')">🗑 Delete</button>
          ${isCompleted ? `
            <a class="btn btn-watch" style="font-size:0.85rem;padding:0.4rem 1rem;" href="player.html?id=${v.id}">🎬 Watch Cinema</a>
          ` : '<div></div>'}
        </div>
      </div>
    </div>`;
}

// ─── Delete Video Logic ───────────────────────────────────────
async function deleteVideo(id) {
  if (!confirm('Are you sure you want to delete this wedding video and all processed HLS files?')) return;
  
  try {
    const res = await fetch(`/api/videos/${id}`, {
      method: 'DELETE',
      headers: {
        'X-Admin-Password': getAdminToken(),
      },
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    
    // Remove from UI
    delete state.videos[id];
    const card = document.getElementById(`card-${id}`);
    if (card) card.remove();
    totalCount.textContent = Object.keys(state.videos).length;
    
    if (Object.keys(state.videos).length === 0) {
      renderEmptyState();
    }
  } catch (err) {
    alert(`Failed to delete video: ${err.message}`);
  }
}

// ─── Update or Insert Card ────────────────────────────────────
function upsertCard(video) {
  state.videos[video.id] = video;

  const existing = document.getElementById(`card-${video.id}`);
  const html = renderCard(video);

  if (existing) {
    existing.outerHTML = html;
  } else {
    videoGrid.insertAdjacentHTML('afterbegin', html);
    const empty = document.getElementById('empty-state');
    if (empty) empty.remove();
  }

  totalCount.textContent = Object.keys(state.videos).length;
}

// ─── Render Empty State ───────────────────────────────────────
function renderEmptyState() {
  videoGrid.innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:4rem 2rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);" id="empty-state">
      <div style="font-size:3rem;margin-bottom:1rem;">🥂</div>
      <h3 style="font-family:'Playfair Display',serif;font-size:1.35rem;margin-bottom:0.5rem;color:var(--text-primary);">No Wedding Films Transcoded Yet</h3>
      <p style="color:var(--text-secondary);font-size:0.9rem;">Upload your first wedding highlight reel, ceremony vows, or teaser above to start the adaptive HLS pipeline.</p>
    </div>`;
}

// ─── SSE Connection ───────────────────────────────────────────
function initSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.addEventListener('initial-load', (e) => {
    const videos = JSON.parse(e.data);
    if (!videos || videos.length === 0) {
      renderEmptyState();
    } else {
      videoGrid.innerHTML = '';
      videos.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      videos.forEach(upsertCard);
    }
    totalCount.textContent = videos.length;
  });

  evtSource.addEventListener('video-update', (e) => {
    const video = JSON.parse(e.data);
    upsertCard(video);
  });

  evtSource.onopen = () => {
    liveBadge.classList.remove('hidden');
  };

  evtSource.onerror = () => {
    liveBadge.classList.add('hidden');
  };
}

// ─── File Selection ───────────────────────────────────────────
function handleFileSelect(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    alert('Please select a valid video file (MP4, MOV, MKV).');
    return;
  }

  state.selectedFile = file;
  uploadSelected.classList.remove('hidden');
  document.getElementById('file-name-display').textContent = file.name;
  document.getElementById('file-meta-display').textContent =
    `${formatBytes(file.size)} • ${file.type} • ${categorySelect.value}`;
  uploadBtn.disabled = false;
}

if (uploadZone) {
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  });
}
if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
  });
}

// ─── Upload Pipeline ──────────────────────────────────────────
if (uploadBtn) {
  uploadBtn.addEventListener('click', async () => {
    const file = state.selectedFile;
    if (!file || state.uploading) return;

    state.uploading = true;
    uploadBtn.disabled = true;
    uploadBtn.textContent = '✨ Processing...';
    progressWrap.classList.add('active');
    progressFill.style.width = '0%';

    try {
      // 1. Initiate upload (With Admin Auth Header)
      const initRes = await fetch('/api/upload/initiate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Password': getAdminToken(),
        },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          fileSize: file.size,
        }),
      });
      const initJson = await initRes.json();
      if (!initJson.success) throw new Error(initJson.error?.message || 'Initiate failed');

      const { videoId, uploadUrl } = initJson.data;

      // 2. XHR PUT with progress tracking
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressFill.style.width = `${pct}%`;
            progressLabel.textContent = `Uploading Footage… ${pct}% (${formatBytes(e.loaded)} / ${formatBytes(e.total)})`;
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed with status ${xhr.status}: ${xhr.responseText}`));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(file);
      });

      progressFill.style.width = '100%';
      progressLabel.textContent = 'Upload complete. Queuing HLS transcoding task…';

      // 3. Complete upload (With Admin Auth Header)
      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Password': getAdminToken(),
        },
        body: JSON.stringify({ videoId }),
      });
      const completeJson = await completeRes.json();
      if (!completeJson.success) throw new Error(completeJson.error?.message || 'Complete failed');

      progressLabel.textContent = '✨ Sent to HLS Transcoding Pipeline!';
      uploadBtn.textContent = 'Upload Another Film';
      state.selectedFile = null;
      uploadSelected.classList.add('hidden');
      fileInput.value = '';

      setTimeout(() => {
        progressWrap.classList.remove('active');
        progressFill.style.width = '0%';
      }, 4000);

    } catch (err) {
      progressLabel.textContent = `❌ Error: ${err.message}`;
      progressFill.style.background = 'var(--red)';
      uploadBtn.textContent = 'Retry Processing';
    } finally {
      state.uploading = false;
      uploadBtn.disabled = false;
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  renderEmptyState();
  initSSE();
});
