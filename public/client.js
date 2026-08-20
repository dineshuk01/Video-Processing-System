/* ============================================================
   EternityStream — Client Gallery Logic
   ============================================================ */

const state = {
  videos: {},
  activeFilter: 'ALL',
};

const clientGrid   = document.getElementById('client-grid');
const galleryCount = document.getElementById('gallery-count');
const filterPills  = document.getElementById('filter-pills');

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function renderClientCard(v) {
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
    <div class="video-card" onclick="window.location.href='player.html?id=${v.id}'" style="cursor:pointer;">
      <div class="card-thumb">
        ${thumbHtml}
        <span class="wedding-tag-badge">${categoryTag}</span>
        <span class="card-badge badge-completed">🎬 Stream Ready</span>
      </div>

      <div class="card-body">
        <div class="card-title" title="${v.originalName}">${v.originalName}</div>
        
        <div class="card-meta">
          <span>📹 ${v.metadata ? `${v.metadata.width}x${v.metadata.height}` : 'HD Cinema'}</span>
          <span>💾 ${formatBytes(v.fileSize)}</span>
          <span>📅 ${formatDate(v.completedAt || v.createdAt)}</span>
        </div>

        <div class="card-footer" style="justify-content:flex-end;">
          <a class="btn btn-watch" style="font-size:0.85rem;padding:0.45rem 1.25rem;" href="player.html?id=${v.id}">🎬 Watch Cinema</a>
        </div>
      </div>
    </div>`;
}

function renderGallery() {
  const completedList = Object.values(state.videos).filter(v => v.status === 'COMPLETED');
  
  const filtered = completedList.filter(v => {
    if (state.activeFilter === 'ALL') return true;
    const cat = (v.category || v.originalName).toLowerCase();
    return cat.includes(state.activeFilter.toLowerCase());
  });

  galleryCount.textContent = filtered.length;

  if (filtered.length === 0) {
    clientGrid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:4rem 2rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);">
        <div style="font-size:3rem;margin-bottom:1rem;">🥂</div>
        <h3 style="font-family:'Playfair Display',serif;font-size:1.35rem;margin-bottom:0.5rem;color:var(--text-primary);">No Wedding Films in this Category</h3>
        <p style="color:var(--text-secondary);font-size:0.9rem;">Check back soon as new wedding films are released to the gallery.</p>
      </div>`;
    return;
  }

  filtered.sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));
  clientGrid.innerHTML = filtered.map(renderClientCard).join('');
}

function initSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.addEventListener('initial-load', (e) => {
    const videos = JSON.parse(e.data);
    state.videos = {};
    (videos || []).forEach(v => { state.videos[v.id] = v; });
    renderGallery();
  });

  evtSource.addEventListener('video-update', (e) => {
    const video = JSON.parse(e.data);
    state.videos[video.id] = video;
    renderGallery();
  });
}

// Filter pill click listeners
if (filterPills) {
  filterPills.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    filterPills.querySelectorAll('button').forEach(b => {
      b.style.borderColor = '';
      b.style.color = '';
    });
    
    btn.style.borderColor = 'var(--gold)';
    btn.style.color = 'var(--gold-light)';
    
    state.activeFilter = btn.dataset.filter;
    renderGallery();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initSSE();
});
