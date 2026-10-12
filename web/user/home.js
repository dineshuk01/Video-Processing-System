/* ============================================================
   VideoStream — public streaming site (browse, search, watch), Netflix-style.
   Talks only to /api/public, which returns published videos and nothing else.
   It has no upload, job, queue or log features: those live in the separate admin app.
   Depends on /shared/common.js.
   ============================================================ */
(function () {
  const { esc, timeAgo, formatDuration, toast, copyText, dialog } = window.VF;

  const app = document.getElementById('app');
  const hdr = document.getElementById('hdr');
  const searchInput = document.getElementById('q');
  const searchForm = document.getElementById('search-form');

  const state = { videos: {}, loaded: false, error: '' };
  let currentView = null; // { update?, teardown? }

  // ─── Helpers ───────────────────────────────────────────────
  const ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h0"/>',
    share: '<path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v14"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v16M16 4v16"/>',
    alert: '<path d="M12 3l10 18H2L12 3zM12 10v5M12 18h0"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
  };
  const svg = (name, size = 18) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const storage = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // The API already returns display-ready fields (title, duration, height, publishedAt)
  const titleOf = (v) => v.title;
  const height = (v) => v.height || 0;
  const seconds = (v) => v.duration || 0;
  const qualityOf = (v) => (height(v) ? `${height(v)}p` : '');
  const ageMs = (v) => Date.now() - new Date(v.publishedAt).getTime();
  const watchHref = (v) => `#/watch/${encodeURIComponent(v.id)}`;

  function library() {
    return Object.values(state.videos).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }

  // Saved on this device only
  const readList = () => { try { return JSON.parse(storage.get('vs-list') || '[]'); } catch { return []; } };
  const inList = (id) => readList().includes(id);
  function toggleList(id) {
    const list = readList();
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.unshift(id);
    storage.set('vs-list', JSON.stringify(list));
    const v = state.videos[id];
    toast(i >= 0 ? 'Removed from My List' : `Added to My List${v ? `: ${titleOf(v)}` : ''}`, 'info', 2200);
  }

  // Watch history, saved on this device only: [{ id, at }], newest first
  const readHistory = () => { try { return JSON.parse(storage.get('vs-history') || '[]'); } catch { return []; } };
  function recordHistory(id) {
    const history = readHistory().filter((h) => h.id !== id);
    history.unshift({ id, at: Date.now() });
    storage.set('vs-history', JSON.stringify(history.slice(0, 100)));
  }
  function removeHistory(id) {
    storage.set('vs-history', JSON.stringify(readHistory().filter((h) => h.id !== id)));
  }

  // Videos the viewer started but did not finish, most recently watched first
  function continueWatching() {
    return library().map((v) => {
      const pos = parseFloat(storage.get(`vs-pos-${v.id}`));
      return { v, pos, seen: parseFloat(storage.get(`vs-seen-${v.id}`)) || 0 };
    }).filter(({ v, pos }) => pos > 5 && seconds(v) && pos < seconds(v) - 5).sort((a, b) => b.seen - a.seen);
  }

  const FILTERS = {
    new: { title: 'New this week', test: (v) => ageMs(v) < 7 * 864e5 },
    hd: { title: 'Watch in HD', test: (v) => height(v) >= 720 },
    short: { title: 'Quick watches · under 5 minutes', test: (v) => seconds(v) > 0 && seconds(v) < 300 },
    long: { title: 'Long watches · 5 minutes and more', test: (v) => seconds(v) >= 300 },
  };

  // ─── Data ──────────────────────────────────────────────────
  async function load() {
    try {
      // 'no-cache' = always ask the server whether the list changed (cheap 304 if not), so a rename shows at once
      const res = await fetch('/api/public/videos', { cache: 'no-cache' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Could not load videos');
      const next = {};
      json.data.videos.forEach((v) => { next[v.id] = v; });

      // Anything that was not there before the last refresh is a newly published video
      const fresh = state.loaded ? json.data.videos.filter((v) => !state.videos[v.id]) : [];
      state.videos = next;
      state.error = '';
      if (fresh.length) toast(fresh.length === 1 ? `New on VideoStream: ${titleOf(fresh[0])}` : `${fresh.length} new videos on VideoStream`, 'info');
    } catch (err) {
      if (!state.loaded) state.error = err.message;
    }
    state.loaded = true;
    refreshView();
  }

  // Newly published (or removed) videos show up without a reload
  function startPolling() {
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    // Coming back to the tab refreshes straight away, so renames and new videos show up promptly
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  }

  // ─── Router ────────────────────────────────────────────────
  function parseRoute() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [name = '', param = ''] = path.split('/');
    return { name: name || 'home', param: decodeURIComponent(param), q: (new URLSearchParams(query).get('q') || '').trim() };
  }

  let refreshQueued = false;
  function refreshView() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      if (parseRoute().name === 'watch' && currentView && currentView.update) currentView.update();
      else render();
    });
  }

  function setNav(key) {
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  }

  function render() {
    if (currentView && currentView.teardown) currentView.teardown();
    currentView = null;
    const route = parseRoute();
    hdr.classList.toggle('solid', route.name !== 'home');
    if (route.name !== 'search' && document.activeElement !== searchInput) searchInput.value = '';
    if (route.name === 'search' && document.activeElement !== searchInput) searchInput.value = route.q;

    switch (route.name) {
      case 'watch': setNav(''); currentView = watchView(route.param); break;
      case 'search': setNav(''); currentView = gridView(`Results for “${route.q}”`, 'search', route.q); break;
      case 'browse': setNav(route.param); currentView = gridView(FILTERS[route.param] ? FILTERS[route.param].title : 'Browse', route.param); break;
      case 'mylist': setNav('mylist'); currentView = gridView('My List', 'mylist'); break;
      case 'history': setNav('history'); currentView = gridView('Watch history', 'history'); break;
      default: setNav('home'); currentView = homeView();
    }
  }

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  window.addEventListener('scroll', () => hdr.classList.toggle('scrolled', window.scrollY > 10), { passive: true });

  // ─── Search ────────────────────────────────────────────────
  function goSearch(q) {
    const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/';
    if (parseRoute().name === 'watch') { location.hash = target; return; }
    history.replaceState(null, '', target); // typing shouldn't flood the history
    render();
  }
  let searchTimer;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => goSearch(searchInput.value.trim()), 250); });
  searchForm.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); goSearch(searchInput.value.trim()); });
  document.getElementById('search-toggle').addEventListener('click', () => { searchForm.classList.add('open'); searchInput.focus(); });
  searchInput.addEventListener('blur', () => { if (!searchInput.value) searchForm.classList.remove('open'); });

  // ─── Shared markup ─────────────────────────────────────────
  const thumbHtml = (v) => (v.thumbnailUrl
    ? `<img src="${esc(v.thumbnailUrl)}" alt="" loading="lazy" />`
    : `<span class="thumb-empty">${svg('film', 28)}</span>`);

  const metaLine = (v) => [height(v) >= 720 ? '<span class="hdtag">HD</span>' : '', seconds(v) ? esc(formatDuration(seconds(v))) : '', esc(timeAgo(v.publishedAt))]
    .filter(Boolean).join(' <span class="dot">·</span> ');

  function tileHtml(v, pos) {
    const listed = inList(v.id);
    const progress = pos && seconds(v) ? `<span class="tile-prog"><i style="width:${Math.min(100, (pos / seconds(v)) * 100).toFixed(1)}%"></i></span>` : '';
    return `
      <article class="tile">
        <a class="tile-thumb" href="${watchHref(v)}" aria-label="Play ${esc(titleOf(v))}">${thumbHtml(v)}${progress}</a>
        <div class="tile-info">
          <div class="tile-btns">
            <a class="round round-play" href="${watchHref(v)}" aria-label="Play">${svg('play', 16)}</a>
            <button class="round" data-act="list" data-id="${esc(v.id)}" aria-pressed="${listed}" aria-label="${listed ? 'Remove from' : 'Add to'} My List">${svg(listed ? 'check' : 'plus', 16)}</button>
            <button class="round round-end" data-act="info" data-id="${esc(v.id)}" aria-label="More info">${svg('chevron', 16)}</button>
          </div>
          <h3 class="tile-title">${esc(titleOf(v))}</h3>
          <p class="tile-meta">${metaLine(v)}</p>
        </div>
      </article>`;
  }

  function gridCardHtml(v) {
    return `
      <a class="gcard" href="${watchHref(v)}">
        <div class="gthumb">${thumbHtml(v)}${seconds(v) ? `<span class="gdur">${esc(formatDuration(seconds(v)))}</span>` : ''}</div>
        <h3 class="tile-title">${esc(titleOf(v))}</h3>
        <p class="tile-meta">${metaLine(v)}</p>
      </a>`;
  }

  // A history card: progress bar for unfinished videos, plus a button to remove it
  function historyCardHtml(v) {
    const pos = parseFloat(storage.get(`vs-pos-${v.id}`));
    const progress = pos > 5 && seconds(v) ? `<span class="tile-prog"><i style="width:${Math.min(100, (pos / seconds(v)) * 100).toFixed(1)}%"></i></span>` : '';
    return `
      <div class="gcard hcard">
        <a href="${watchHref(v)}"><div class="gthumb">${thumbHtml(v)}${seconds(v) ? `<span class="gdur">${esc(formatDuration(seconds(v)))}</span>` : ''}${progress}</div>
          <h3 class="tile-title">${esc(titleOf(v))}</h3></a>
        <p class="tile-meta">${metaLine(v)}</p>
        <button class="link-small" data-act="remove-history" data-id="${esc(v.id)}">Remove from history</button>
      </div>`;
  }

  function rowHtml(title, tiles) {
    return `
      <section class="row" aria-label="${esc(title)}">
        <h2 class="row-title">${esc(title)}</h2>
        <div class="row-wrap">
          <button class="row-arrow left hide" aria-label="Scroll left">${svg('left', 28)}</button>
          <div class="row-scroll">${tiles}</div>
          <button class="row-arrow right hide" aria-label="Scroll right">${svg('right', 28)}</button>
        </div>
      </section>`;
  }

  function wireRows(root) {
    root.querySelectorAll('.row-wrap').forEach((wrap) => {
      const scroller = wrap.querySelector('.row-scroll');
      const left = wrap.querySelector('.left');
      const right = wrap.querySelector('.right');
      const update = () => {
        left.classList.toggle('hide', scroller.scrollLeft < 8);
        right.classList.toggle('hide', scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 8);
      };
      left.addEventListener('click', () => scroller.scrollBy({ left: -scroller.clientWidth * 0.85, behavior: 'smooth' }));
      right.addEventListener('click', () => scroller.scrollBy({ left: scroller.clientWidth * 0.85, behavior: 'smooth' }));
      scroller.addEventListener('scroll', update, { passive: true });
      update();
    });
  }

  function openInfo(id) {
    const v = state.videos[id];
    if (!v) return;
    const row = (k, val) => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`;
    const modal = dialog({
      title: titleOf(v),
      wide: true,
      html: `
        <div class="info-hero">${v.thumbnailUrl ? `<img src="${esc(v.thumbnailUrl)}" alt="" />` : ''}<div class="info-shade"></div>
          <div class="info-hero-body"><h2>${esc(titleOf(v))}</h2>
            <div class="info-actions"><a class="btn btn-light" href="${watchHref(v)}" data-close>${svg('play', 16)} Play</a>
              <button class="round" data-act="list" data-id="${esc(v.id)}" aria-pressed="${inList(v.id)}" aria-label="Toggle My List">${svg(inList(v.id) ? 'check' : 'plus', 16)}</button></div></div></div>
        <div class="info-body"><p class="tile-meta">${metaLine(v)}</p>
          <dl class="info-dl">
            ${row('Resolution', v.width ? `${esc(v.width)} × ${esc(v.height)}` : '—')}
            ${row('Frame rate', v.fps ? `${esc(v.fps)} fps` : '—')}
            ${row('Duration', seconds(v) ? esc(formatDuration(seconds(v))) : '—')}
            ${row('Published', esc(new Date(v.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })))}
          </dl></div>`,
    });
    // The My List button inside the dialog updates itself and the page behind it
    modal.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="list"]');
      if (!btn) return;
      toggleList(id);
      btn.setAttribute('aria-pressed', String(inList(id)));
      btn.innerHTML = svg(inList(id) ? 'check' : 'plus', 16);
      refreshView();
    });
  }

  // One delegated handler for tile / banner buttons
  app.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'list') { toggleList(btn.dataset.id); refreshView(); }
    else if (btn.dataset.act === 'info') openInfo(btn.dataset.id);
    else if (btn.dataset.act === 'remove-history') { removeHistory(btn.dataset.id); toast('Removed from history', 'info', 1800); render(); }
    else if (btn.dataset.act === 'clear-history') {
      if (window.confirm('Clear your whole watch history on this device?')) { storage.del('vs-history'); render(); }
    }
    else if (btn.dataset.act === 'retry') { state.loaded = false; state.error = ''; render(); load(); }
  });

  function notice(icon, title, text, action = '') {
    return `<div class="notice">${svg(icon, 40)}<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
  }

  // Common states shared by every list page; returns true when it handled the render
  function renderGate() {
    if (!state.loaded) {
      app.innerHTML = '<div class="page-pad"><div class="spinner" role="status" aria-label="Loading"></div></div>';
      return true;
    }
    if (state.error) {
      app.innerHTML = `<div class="page-pad">${notice('alert', 'Couldn\'t load videos', state.error, '<button class="btn btn-light" data-act="retry">Try again</button>')}</div>`;
      return true;
    }
    return false;
  }

  // ═════════════════════════════════════════════════════════
  // Home: banner + rows
  // ═════════════════════════════════════════════════════════
  function homeView() {
    document.title = 'VideoStream — Watch';
    if (renderGate()) return {};

    const all = library();
    if (all.length === 0) {
      app.innerHTML = `<div class="page-pad">${notice('film', 'Nothing to watch yet', 'New videos will appear here as soon as they are published. Check back soon.')}</div>`;
      return {};
    }

    // Keep each row's horizontal scroll position across re-renders (e.g. after toggling My List)
    const scrolled = {};
    app.querySelectorAll('.row').forEach((r) => { scrolled[r.getAttribute('aria-label')] = r.querySelector('.row-scroll').scrollLeft; });

    const featured = all[0];
    const listed = readList().map((id) => state.videos[id]).filter(Boolean);
    const resume = continueWatching();
    const rows = [
      resume.length ? rowHtml('Continue Watching', resume.map(({ v, pos }) => tileHtml(v, pos)).join('')) : '',
      rowHtml('Latest videos', all.map((v) => tileHtml(v)).join('')),
      listed.length ? rowHtml('My List', listed.map((v) => tileHtml(v)).join('')) : '',
      ...Object.keys(FILTERS).map((key) => {
        const items = all.filter(FILTERS[key].test);
        return items.length ? rowHtml(FILTERS[key].title, items.map((v) => tileHtml(v)).join('')) : '';
      }),
    ].join('');

    app.innerHTML = `
      <section class="billboard" aria-label="Featured video">
        ${featured.thumbnailUrl ? `<img class="bb-img" src="${esc(featured.thumbnailUrl)}" alt="" />` : ''}
        <div class="bb-shade"></div>
        <div class="bb-body">
          <span class="bb-tag">${ageMs(featured) < 864e5 ? 'New' : 'Latest'}</span>
          <h1>${esc(titleOf(featured))}</h1>
          <p class="bb-meta">${metaLine(featured)}</p>
          <div class="bb-actions">
            <a class="btn btn-light btn-lg" href="${watchHref(featured)}">${svg('play', 22)} Play</a>
            <button class="btn btn-gray btn-lg" data-act="info" data-id="${esc(featured.id)}">${svg('info', 22)} More info</button>
          </div>
        </div>
      </section>
      <div class="rows">${rows}</div>`;
    app.querySelectorAll('.row').forEach((r) => { r.querySelector('.row-scroll').scrollLeft = scrolled[r.getAttribute('aria-label')] || 0; });
    wireRows(app);
    return {};
  }

  // ═════════════════════════════════════════════════════════
  // Grid pages: search, browse filters, My List
  // ═════════════════════════════════════════════════════════
  function gridView(title, kind, q = '') {
    document.title = `${title} — VideoStream`;
    if (renderGate()) return {};

    let items = library();
    if (kind === 'search') {
      const needle = q.toLowerCase();
      items = items.filter((v) => !needle || titleOf(v).toLowerCase().includes(needle) || v.id.toLowerCase().includes(needle));
    } else if (kind === 'mylist') {
      items = readList().map((id) => state.videos[id]).filter(Boolean);
    } else if (kind === 'history') {
      items = readHistory().map((h) => state.videos[h.id]).filter(Boolean);
    } else if (FILTERS[kind]) {
      items = items.filter(FILTERS[kind].test);
    }

    const empty = kind === 'mylist'
      ? notice('plus', 'Your list is empty', 'Press + on any video to save it here. Saved on this device only.', '<a class="btn btn-light" href="#/">Browse videos</a>')
      : kind === 'history'
        ? notice('film', 'No watch history yet', 'Videos you watch will appear here. Saved on this device only.', '<a class="btn btn-light" href="#/">Browse videos</a>')
      : kind === 'search'
        ? notice('film', 'No videos found', `Nothing matches “${q}”.`, '<a class="btn btn-light" href="#/">Back to home</a>')
        : notice('film', 'Nothing here yet', 'No videos match this category right now.', '<a class="btn btn-light" href="#/">Back to home</a>');

    const clearBtn = kind === 'history' && items.length ? '<button class="btn btn-gray btn-sm" data-act="clear-history">Clear history</button>' : '';
    app.innerHTML = `<div class="page-pad"><div class="page-head-row"><h1 class="page-title">${esc(title)}</h1>${clearBtn}</div>
      ${items.length ? `<div class="ggrid">${items.map((v) => (kind === 'history' ? historyCardHtml(v) : gridCardHtml(v))).join('')}</div>` : empty}</div>`;
    return {};
  }

  // ═════════════════════════════════════════════════════════
  // Watch
  // ═════════════════════════════════════════════════════════
  function watchView(id) {
    let video = state.videos[id];
    let teardownPlayer = null;
    let destroyed = false;

    const message = (title, text) => {
      document.title = 'VideoStream';
      app.innerHTML = `<div class="page-pad">${notice('alert', title, text, '<a class="btn btn-light" href="#/">Back to home</a>')}</div>`;
    };

    async function resolve() {
      if (!state.loaded) { app.innerHTML = '<div class="page-pad"><div class="spinner" role="status" aria-label="Loading"></div></div>'; return; }
      if (!video) {
        // It may be newer than our list, so ask the server once
        try {
          const res = await fetch(`/api/public/videos/${encodeURIComponent(id)}`, { cache: 'no-cache' });
          const json = await res.json();
          if (json.success) { video = json.data; state.videos[id] = video; }
        } catch { /* fall through to not found */ }
        if (destroyed) return;
      }
      if (!video) return message('Video not found', 'It may have been removed or is not available.');
      mount();
    }

    function nextVideo() {
      const list = library();
      const i = list.findIndex((v) => v.id === id);
      return list[i + 1] || list[i - 1] || null;
    }

    function renderMore() {
      const el = document.getElementById('more-grid');
      if (!el) return;
      const list = library().filter((v) => v.id !== id).slice(0, 12);
      el.innerHTML = list.length ? list.map(gridCardHtml).join('') : '<p class="tile-meta">No other videos yet.</p>';
    }

    function mount() {
      document.title = `${titleOf(video)} — VideoStream`;
      app.innerHTML = `
        <div class="stage">
          <div class="player" id="player">
            <video id="video" controls playsinline preload="metadata" autoplay
                   ${video.subtitleUrl ? 'crossorigin="anonymous"' : ''}
                   ${video.thumbnailUrl ? `poster="${esc(video.thumbnailUrl)}"` : ''}>
              ${video.subtitleUrl ? `<track kind="subtitles" label="English" srclang="en" src="${esc(video.subtitleUrl)}">` : ''}
            </video>
            <div class="overlay" id="buffering" aria-hidden="true"><div class="spinner small"></div></div>
            <div class="overlay interactive" id="error" role="alert">${svg('alert', 30)}<p id="error-text"></p>
              <button class="btn btn-light btn-sm" id="retry">Try again</button></div>
            <div class="overlay interactive" id="next-up" role="status"></div>
          </div>
        </div>

        <div class="watch-body">
          <div class="watch-head">
            <div>
              <h1 class="w-title">${esc(titleOf(video))}</h1>
              <p class="tile-meta">${metaLine(video)}${qualityOf(video) ? ` <span class="dot">·</span> ${esc(qualityOf(video))}` : ''}</p>
            </div>
            <div class="w-actions">
              <button class="btn btn-gray btn-sm" id="list-btn" data-act="list" data-id="${esc(video.id)}" aria-pressed="${inList(video.id)}">${svg(inList(video.id) ? 'check' : 'plus', 15)} My List</button>
              <button class="btn btn-gray btn-sm" id="share">${svg('share', 15)} Share</button>
            </div>
          </div>

          <div class="controls">
            <label class="ctl">Quality <select id="quality" class="select"><option value="-1">Auto</option></select></label>
            <label class="ctl">Speed <select id="speed" class="select">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}×</option>`).join('')}</select></label>
            ${video.subtitleUrl ? '<button class="btn btn-gray btn-sm" id="cc" aria-pressed="false">Captions: Off</button>' : ''}
            <label class="switch-label"><input type="checkbox" id="autonext" class="switch-input" role="switch" /><span>Autoplay next</span></label>
          </div>

          <h2 class="row-title flush">More videos</h2>
          <div class="ggrid" id="more-grid"></div>
        </div>`;
      teardownPlayer = setupPlayer();
      renderMore();
    }

    function setupPlayer() {
      const $ = (sel) => app.querySelector(sel);
      const videoEl = $('#video');
      const qualitySel = $('#quality');
      const speedSel = $('#speed');
      const ccBtn = $('#cc');
      const auto = $('#autonext');
      const posKey = `vs-pos-${video.id}`;
      let hls = null;
      let netRetries = 0;
      let mediaRetries = 0;
      let countdown = null;

      $('#share').addEventListener('click', () => copyText(location.href, 'Link copied'));

      // ── Overlays ──
      const buffering = $('#buffering');
      const errorBox = $('#error');
      const setBuffering = (on) => buffering.classList.toggle('visible', on);
      function showError(text) { setBuffering(false); $('#error-text').textContent = text; errorBox.classList.add('visible'); }
      videoEl.addEventListener('waiting', () => setBuffering(true));
      ['playing', 'canplay', 'pause', 'seeked'].forEach((evt) => videoEl.addEventListener(evt, () => setBuffering(false)));

      // ── Preferences ──
      const savedSpeed = storage.get('vs-speed');
      if (savedSpeed && [...speedSel.options].some((o) => o.value === savedSpeed)) { speedSel.value = savedSpeed; videoEl.playbackRate = parseFloat(savedSpeed); }
      speedSel.addEventListener('change', () => { videoEl.playbackRate = parseFloat(speedSel.value); storage.set('vs-speed', speedSel.value); });
      auto.checked = storage.get('vs-autonext') !== 'off';
      auto.addEventListener('change', () => storage.set('vs-autonext', auto.checked ? 'on' : 'off'));

      // ── History and resume ──
      let recorded = false;
      videoEl.addEventListener('playing', () => { if (!recorded) { recorded = true; recordHistory(video.id); } });
      let lastSaved = 0;
      videoEl.addEventListener('loadedmetadata', () => {
        const pos = parseFloat(storage.get(posKey));
        if (pos > 5 && pos < videoEl.duration - 5) { videoEl.currentTime = pos; toast(`Resumed from ${formatDuration(pos)}`, 'info', 2500); }
        if (videoEl.textTracks[0]) videoEl.textTracks[0].mode = 'disabled';
      }, { once: true });
      videoEl.addEventListener('timeupdate', () => {
        if (Date.now() - lastSaved > 2000) {
          lastSaved = Date.now();
          storage.set(posKey, videoEl.currentTime);
          storage.set(`vs-seen-${video.id}`, Date.now());
        }
      });

      // ── Captions ──
      function setCaptions(on) {
        const track = videoEl.textTracks[0];
        if (!track || !ccBtn) return;
        track.mode = on ? 'showing' : 'disabled';
        ccBtn.setAttribute('aria-pressed', String(on));
        ccBtn.textContent = `Captions: ${on ? 'On' : 'Off'}`;
      }
      if (ccBtn) ccBtn.addEventListener('click', () => setCaptions(ccBtn.getAttribute('aria-pressed') !== 'true'));

      // ── Up next countdown when the video ends ──
      const nextBox = $('#next-up');
      function stopCountdown() { clearInterval(countdown); countdown = null; nextBox.classList.remove('visible'); }
      videoEl.addEventListener('ended', () => {
        storage.del(posKey);
        const next = nextVideo();
        if (!auto.checked || !next) return;
        let left = 5;
        nextBox.innerHTML = `<p class="nu-label">Up next</p><p class="nu-title">${esc(titleOf(next))}</p>
          <p class="nu-count">Playing in <strong id="nu-sec">${left}</strong>s</p>
          <div class="nu-actions"><button class="btn btn-gray btn-sm" id="nu-cancel">Cancel</button>
          <a class="btn btn-light btn-sm" href="${watchHref(next)}">Play now</a></div>`;
        nextBox.classList.add('visible');
        nextBox.querySelector('#nu-cancel').addEventListener('click', stopCountdown);
        countdown = setInterval(() => {
          left -= 1;
          const sec = nextBox.querySelector('#nu-sec');
          if (sec) sec.textContent = left;
          if (left <= 0) { stopCountdown(); location.hash = watchHref(next); }
        }, 1000);
      });
      videoEl.addEventListener('play', stopCountdown);

      // ── Hls.js ──
      function start(resumeAt) {
        errorBox.classList.remove('visible');
        if (window.Hls && Hls.isSupported()) {
          hls = new Hls({ enableWorker: true, capLevelToPlayerSize: true });
          hls.loadSource(video.hlsPlaylistUrl);
          hls.attachMedia(videoEl);
          hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            qualitySel.length = 1;
            data.levels.map((l, idx) => ({ idx, h: l.height })).sort((a, b) => b.h - a.h).forEach(({ idx, h }) => {
              const opt = document.createElement('option');
              opt.value = idx; opt.textContent = `${h}p`;
              qualitySel.appendChild(opt);
            });
            if (resumeAt) videoEl.currentTime = resumeAt;
            videoEl.play().catch(() => { /* autoplay blocked: the viewer presses play */ });
          });
          hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
            const level = hls.levels[data.level];
            if (level && qualitySel.value === '-1') qualitySel.options[0].textContent = `Auto (${level.height}p)`;
          });
          hls.on(Hls.Events.FRAG_LOADED, () => { netRetries = 0; mediaRetries = 0; });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            console.error('Hls.js fatal error:', data.type, data.details);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 3) return hls.startLoad();
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 3) return hls.recoverMediaError();
            hls.destroy(); hls = null;
            showError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'The connection was lost while loading the video.' : 'This video could not be played.');
          });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = video.hlsPlaylistUrl; // Safari: native HLS
          qualitySel.closest('.ctl').hidden = true;
        } else {
          showError('Your browser does not support HLS playback.');
        }
      }
      qualitySel.addEventListener('change', () => {
        if (!hls) return;
        hls.currentLevel = parseInt(qualitySel.value, 10);
        if (qualitySel.value !== '-1') qualitySel.options[0].textContent = 'Auto';
      });
      $('#retry').addEventListener('click', () => {
        const at = videoEl.currentTime;
        if (hls) hls.destroy();
        hls = null; netRetries = mediaRetries = 0;
        start(at);
      });

      // ── Keyboard ──
      function onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest('button, a, select, input, textarea')) return;
        const key = e.key.toLowerCase();
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
          f: () => (document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen()),
          c: () => ccBtn && setCaptions(ccBtn.getAttribute('aria-pressed') !== 'true'),
        };
        if (actions[key]) { e.preventDefault(); actions[key](); }
      }
      document.addEventListener('keydown', onKey);

      start(0);

      return () => {
        document.removeEventListener('keydown', onKey);
        stopCountdown();
        if (hls) hls.destroy();
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      };
    }

    resolve();

    return {
      // Live updates only refresh the video list and My List button; the player is never rebuilt mid-playback
      update() {
        if (!teardownPlayer && state.loaded && !destroyed) { video = state.videos[id] || video; resolve(); return; }
        renderMore();
        // Keep the title in step if an admin renamed the video while it is open
        const latest = state.videos[id];
        if (latest && latest.title !== video.title) {
          video = latest;
          const heading = app.querySelector('.w-title');
          if (heading) heading.textContent = titleOf(latest);
          document.title = `${titleOf(latest)} — VideoStream`;
        }
        const btn = document.getElementById('list-btn');
        if (btn) {
          btn.setAttribute('aria-pressed', String(inList(id)));
          btn.innerHTML = `${svg(inList(id) ? 'check' : 'plus', 15)} My List`;
        }
      },
      teardown() { destroyed = true; if (teardownPlayer) teardownPlayer(); },
    };
  }

  // ─── Boot ──────────────────────────────────────────────────
  render();
  load();
  startPolling();
})();
