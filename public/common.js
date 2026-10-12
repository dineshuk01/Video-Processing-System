/* ============================================================
   VideoFlow — shared UI helpers (used by index.html and player.html)
   ============================================================ */
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Escape anything interpolated into innerHTML (file names, error messages, URLs)
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
    if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} d ago`;
    return formatDate(iso);
  }

  // 83.4 -> "1:23", 3725 -> "1:02:05"
  function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds < 0) return '0:00';
    const s = Math.round(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return `${Math.ceil(seconds)}s left`;
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s left`;
  }

  // ─── Toasts ─────────────────────────────────────────────────
  function toast(message, type = 'info', duration = 4000) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const icons = { success: '✓', error: '!', info: 'i' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'i'}</span><span>${esc(message)}</span>`;
    host.appendChild(el);
    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 250);
    };
    el.addEventListener('click', remove);
    setTimeout(remove, duration);
  }

  // ─── Confirm dialog (replaces window.confirm) ───────────────
  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-msg">
          <h3 id="modal-title">${esc(title)}</h3>
          <p id="modal-msg">${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-act="cancel">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const okBtn = overlay.querySelector('[data-act="ok"]');
      const cancelBtn = overlay.querySelector('[data-act="cancel"]');
      cancelBtn.focus();

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        if (e.key === 'Tab') { // keep focus inside the dialog
          e.preventDefault();
          (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
        }
      };
      document.addEventListener('keydown', onKey, true);
      okBtn.addEventListener('click', () => close(true));
      cancelBtn.addEventListener('click', () => close(false));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    });
  }

  async function copyText(text, successMessage = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage, 'success', 2000);
    } catch {
      toast('Could not copy. Copy it manually instead.', 'error');
    }
  }

  window.VF = {
    esc, formatBytes, formatDate, timeAgo, formatDuration, formatEta,
    toast, confirmDialog, copyText,
  };
})();
