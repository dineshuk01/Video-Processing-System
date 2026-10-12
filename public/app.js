/* ============================================================
   VideoStream — app core: store, live updates (SSE), router,
   notifications, system status. Depends on common.js.
   Pages live in upload.js and views.js.
   ============================================================ */
(function () {
  const VF = window.VF;
  const { esc, toast, timeAgo } = VF;

  // There is no auth in the backend, so the greeting name is a plain setting.
  VF.config = {
    userName: 'Dinesh',
    maxUploadBytes: 1000 * 1024 * 1024, // mirrors MAX_UPLOAD_SIZE_MB=1000
    maxUploadLabel: '1 GB',
    pageSize: 10,
  };
  try {
    const savedName = localStorage.getItem('vf-name');
    if (savedName) VF.config.userName = savedName;
  } catch { /* storage unavailable */ }
  VF.ACTIVE_STATUSES =['PENDING', 'UPLOADING', 'UPLOADED', 'PROCESSING'];

  // ─── Icons (inline SVG, stroke = currentColor) ─────────────
  const ICONS = {
    home: '<path d="M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10"/>',
    upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v16M16 4v16"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 010 8.4M7.8 16.2a6 6 0 010-8.4M19 5a10 10 0 010 14M5 19A10 10 0 015 5"/>',
    jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 13h18"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 004 0"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    database: '<path d="M3 7c0-1.7 4-3 9-3s9 1.3 9 3-4 3-9 3-9-1.3-9-3zM3 7v10c0 1.7 4 3 9 3s9-1.3 9-3V7"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
    dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    cloud: '<path d="M16 16l-4-4-4 4M12 12v9"/><path d="M20.4 18.4A5 5 0 0018 9h-1.3A8 8 0 104 16.3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    alert: '<path d="M12 3l10 18H2L12 3zM12 10v5M12 18h0"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    hdd: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M3 14l3-9h12l3 9M7 17h0"/>',
  };
  VF.icon = (name, size = 18) =>
    `<svg class="svg-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ─── Store ─────────────────────────────────────────────────
  const store = {
    videos: {},
    loaded: false,
    health: null,
    connection: 'connecting',
    notifications: [],
    ui: { search: '', status: 'all' },
    _subs: new Set(),
    _pending: new Set(),
    _scheduled: false,

    list() {
      return Object.values(this.videos).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    activeCount() {
      return Object.values(this.videos).filter((v) => VF.ACTIVE_STATUSES.includes(v.status)).length;
    },
    subscribe(fn) {
      this._subs.add(fn);
      return () => this._subs.delete(fn);
    },
    // Coalesce bursts of events into one notification per animation frame
    emit(type) {
      this._pending.add(type);
      if (this._scheduled) return;
      this._scheduled = true;
      requestAnimationFrame(() => {
        const types = new Set(this._pending);
        this._pending.clear();
        this._scheduled = false;
        this._subs.forEach((fn) => { try { fn(types); } catch (err) { console.error(err); } });
      });
    },
  };
  VF.store = store;

  // ─── Notifications ─────────────────────────────────────────
  function notify(type, title, videoId) {
    store.notifications.unshift({ id: Date.now() + Math.random(), type, title, videoId, at: new Date().toISOString(), read: false });
    store.notifications.length = Math.min(store.notifications.length, 30);
    store.emit('notifications');
  }

  function applyVideos(list, { replace = false } = {}) {
    const previous = store.videos;
    const next = replace ? {} : { ...previous };
    for (const video of list) {
      const before = previous[video.id];
      next[video.id] = video;
      if (store.loaded && before && before.status !== video.status) {
        if (video.status === 'COMPLETED') {
          notify('success', `"${video.originalName}" is ready to watch`, video.id);
          toast(`"${video.originalName}" is ready to watch`, 'success');
        } else if (video.status === 'FAILED') {
          notify('error', `"${video.originalName}" failed to process`, video.id);
          toast(`"${video.originalName}" failed to process`, 'error');
        }
      }
    }
    store.videos = next;
    store.loaded = true;
    store.emit('videos');
  }

  VF.removeVideo = (id) => {
    const { [id]: _removed, ...rest } = store.videos;
    store.videos = rest;
    store.emit('videos');
  };

  // Used by the watch page when it is opened before the first SSE snapshot arrives
  VF.fetchVideo = async (id) => {
    const res = await fetch(`/api/videos/${encodeURIComponent(id)}`);
    const json = await res.json();
    if (!json.success || !json.data) {
      const err = new Error(json.error?.message || 'Video not found');
      err.status = res.status;
      throw err;
    }
    return json.data;
  };

  // ─── Live updates (SSE) with a fetch fallback ──────────────
  let fallbackTimer;
  async function loadViaFetch() {
    if (store.loaded) return;
    try {
      const res = await fetch('/api/videos?page=1&limit=100');
      const json = await res.json();
      if (json.success) applyVideos(json.data.videos, { replace: true });
    } catch { /* the stream will retry */ }
  }

  function initSSE() {
    const source = new EventSource('/api/events');
    source.addEventListener('initial-load', (e) => applyVideos(JSON.parse(e.data), { replace: true }));
    source.addEventListener('video-update', (e) => applyVideos([JSON.parse(e.data)]));
    source.onopen = () => { store.connection = 'live'; store.emit('connection'); };
    source.onerror = () => {
      store.connection = 'offline';
      store.emit('connection');
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(loadViaFetch, 3000);
    };
  }

  // ─── System health (shown on the Settings page) ────────────
  VF.refreshHealth = async function refreshHealth() {
    try {
      const [basic, detailed] = await Promise.all([
        fetch('/health').then((r) => r.json()),
        fetch('/health/detailed').then((r) => r.json()),
      ]);
      store.health = { ok: detailed.status === 'HEALTHY', provider: basic.provider, components: detailed.components, checkedAt: new Date().toISOString() };
    } catch {
      store.health = { ok: false, provider: null, components: null, checkedAt: new Date().toISOString() };
    }
    store.emit('health');
  };

  function renderConnection() {
    const el = document.getElementById('conn');
    const map = { live: ['live', 'Live'], offline: ['offline', 'Reconnecting…'], connecting: ['connecting', 'Connecting…'] };
    const [kind, label] = map[store.connection];
    el.className = `conn conn-${kind}`;
    document.getElementById('conn-label').textContent = label;
  }

  // ─── Floating menu (row actions) ───────────────────────────
  let openMenuEl = null;
  function closeMenu() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
  }
  VF.menu = function menu(anchor, items) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items.map((item, i) =>
      `<button role="menuitem" class="menu-item ${item.danger ? 'danger' : ''}" data-i="${i}">${VF.icon(item.icon, 16)}${esc(item.label)}</button>`).join('');
    document.body.appendChild(el);
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    el.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - el.offsetHeight - 8) + window.scrollY}px`;
    el.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + window.scrollX}px`;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      closeMenu();
      items[btn.dataset.i].onClick();
    });
    openMenuEl = el;
    el.querySelector('button').focus();
  };
  document.addEventListener('mousedown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('[data-menu-anchor]')) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);

  // ─── Bell / notifications popover ──────────────────────────
  const bell = document.getElementById('bell');
  const bellPop = document.getElementById('bell-pop');

  function renderBell() {
    const unread = store.notifications.filter((n) => !n.read).length;
    const badge = document.getElementById('bell-badge');
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.classList.toggle('hidden', unread === 0);

    if (bellPop.classList.contains('hidden')) return;
    bellPop.innerHTML = `
      <div class="pop-head"><strong>Notifications</strong>
        ${store.notifications.length ? '<button class="link-btn" id="mark-read">Mark all read</button>' : ''}</div>
      ${store.notifications.length ? `<ul class="notif-list">${store.notifications.map((n) => `
        <li><a class="notif ${n.read ? '' : 'unread'}" href="${n.videoId ? `#/watch/${encodeURIComponent(n.videoId)}` : '#/jobs'}">
          <span class="notif-dot notif-${esc(n.type)}"></span>
          <span><span class="notif-title">${esc(n.title)}</span><span class="notif-time">${esc(timeAgo(n.at))}</span></span>
        </a></li>`).join('')}</ul>`
        : '<div class="pop-empty">You are all caught up.<br /><span>Updates about your videos will appear here.</span></div>'}`;
  }

  function toggleBell(force) {
    const open = force !== undefined ? force : bellPop.classList.contains('hidden');
    bellPop.classList.toggle('hidden', !open);
    bell.setAttribute('aria-expanded', String(open));
    if (open) renderBell();
  }
  bell.addEventListener('click', () => toggleBell());
  bellPop.addEventListener('click', (e) => {
    if (e.target.id === 'mark-read') { store.notifications.forEach((n) => { n.read = true; }); renderBell(); }
    else if (e.target.closest('a')) { toggleBell(false); store.notifications.forEach((n) => { n.read = true; }); renderBell(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!bellPop.classList.contains('hidden') && !e.target.closest('.bell-wrap')) toggleBell(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleBell(false); });

  // ─── Router ────────────────────────────────────────────────
  VF.views = {};
  let current = null; // { name, cleanup }
  const view = document.getElementById('view');

  function parseRoute() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [name = '', param = ''] = path.split('/');
    return { name: name || 'dashboard', param: decodeURIComponent(param), query: new URLSearchParams(query) };
  }

  function navigate() {
    const route = parseRoute();
    const def = VF.views[route.name];
    if (!def) { location.replace('#/dashboard'); return; }

    if (current && current.cleanup) current.cleanup();
    closeMenu();
    document.body.classList.remove('nav-open');

    view.innerHTML = '';
    view.className = `content${def.dark ? ' theme-dark' : ''}`;
    document.body.classList.toggle('dark-page', !!def.dark);
    document.title = `${def.title(route)} — VideoStream`;
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const active = a.dataset.nav === (def.nav || route.name);
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });

    const cleanup = def.mount(view, route);
    current = { name: route.name, cleanup };
    window.scrollTo(0, 0);
  }

  // ─── Boot ──────────────────────────────────────────────────
  function renderBadges() {
    const jobs = store.activeCount();
    const jobsBadge = document.getElementById('nav-jobs-badge');
    jobsBadge.textContent = jobs;
    jobsBadge.classList.toggle('hidden', jobs === 0);

    const uploads = VF.uploads ? VF.uploads.activeCount() : 0;
    const upBadge = document.getElementById('nav-upload-badge');
    upBadge.textContent = uploads;
    upBadge.classList.toggle('hidden', uploads === 0);

    document.title = document.title.replace(/^\(\d+\) /, '');
    if (jobs > 0) document.title = `(${jobs}) ${document.title}`;
  }

  VF.start = function start() {
    document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = VF.icon(el.dataset.icon, 18); });
    document.getElementById('user-name').textContent = VF.config.userName;
    document.getElementById('avatar').textContent = VF.config.userName.charAt(0).toUpperCase();

    // Topbar search always searches the library
    const search = document.getElementById('global-search');
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        store.ui.search = search.value.trim();
        if (parseRoute().name !== 'videos') location.hash = '#/videos';
        else store.emit('ui');
      }, 200);
    });
    store.subscribe((types) => {
      if (types.has('ui') && search.value.trim() !== store.ui.search) search.value = store.ui.search;
    });

    // Mobile navigation drawer
    document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
    document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));

    store.subscribe((types) => {
      if (types.has('connection')) renderConnection();
      if (types.has('notifications')) renderBell();
      if (types.has('videos') || types.has('uploads')) renderBadges();
    });

    window.addEventListener('hashchange', navigate);
    renderConnection();
    renderBell();
    initSSE();
    VF.refreshHealth();
    setInterval(VF.refreshHealth, 30000);
    setInterval(() => { if (!bellPop.classList.contains('hidden')) renderBell(); }, 30000);
    navigate();
  };
})();
