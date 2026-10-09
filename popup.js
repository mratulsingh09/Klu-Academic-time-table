// popup.js  v2.0

const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : {
      get: (defaults, cb) => cb(defaults),
      set: (obj, cb) => cb && cb()
    };

const toggle       = document.getElementById('toggle');
const statusPill   = document.getElementById('status');
const statusText   = document.getElementById('status-text');
const modeSection  = document.getElementById('mode-section');
const modeButtons  = document.querySelectorAll('.mode-btn');
const previewAfter = document.getElementById('preview-after');

const PREVIEWS = {
  'name-only': `
    <div class="pv-card">
      <div class="pv-title">Front End Development Frameworks for Web Applications</div>
      <div class="pv-badges">
        <span class="pv-badge pv-badge-practical">Practical</span>
        <span class="pv-badge pv-badge-room">📍 Room C307</span>
        <span class="pv-badge pv-badge-sec">S-1</span>
      </div>
    </div>
  `,
  'code+name': `
    <div class="pv-card">
      <div class="pv-title">Front End Development Frameworks for Web Applications</div>
      <div class="pv-code">25CS2101L</div>
      <div class="pv-badges">
        <span class="pv-badge pv-badge-practical">Practical</span>
        <span class="pv-badge pv-badge-room">📍 Room C307</span>
        <span class="pv-badge pv-badge-sec">S-1</span>
      </div>
    </div>
  `
};

function applyUI(enabled, mode) {
  // Toggle switch
  toggle.checked = enabled;

  // Status pill
  if (enabled) {
    statusPill.className = 'status-pill on';
    statusText.textContent = 'Active — timetable formatted';
  } else {
    statusPill.className = 'status-pill off';
    statusText.textContent = 'OFF — original codes shown';
  }

  // Mode section dimmed when disabled
  modeSection.style.opacity        = enabled ? '1' : '0.4';
  modeSection.style.pointerEvents  = enabled ? 'auto' : 'none';

  // Highlight correct mode button
  modeButtons.forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode)
  );

  // Update preview
  previewAfter.innerHTML = PREVIEWS[mode] || PREVIEWS['name-only'];
}

const thresholdInput = document.getElementById('threshold-input');
const attCacheInfo   = document.getElementById('att-cache-info');

// ── Load saved state on popup open ────────────────────────────────────────
storage.get({ enabled: true, mode: 'name-only', threshold: 75, kl_erp_attendance: [] }, res => {
  applyUI(res.enabled, res.mode);
  if (thresholdInput) {
    thresholdInput.value = res.threshold || 75;
  }
  if (attCacheInfo) {
    const rows = res.kl_erp_attendance || [];
    if (rows.length > 0) {
      attCacheInfo.innerHTML = `<span style="color:#4ade80">●</span> <strong>${rows.length}</strong> subjects synced from ERP`;
    } else {
      attCacheInfo.innerHTML = `<span style="color:#facc15">●</span> No ERP attendance yet &mdash; open Attendance page to sync`;
    }
  }
});

// ── ON/OFF toggle ──────────────────────────────────────────────────────────
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  storage.get({ mode: 'name-only' }, ({ mode }) => {
    storage.set({ enabled }, () => applyUI(enabled, mode));
  });
});

// ── Mode buttons ───────────────────────────────────────────────────────────
modeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const newMode = btn.dataset.mode;
    storage.get({ enabled: true }, ({ enabled }) => {
      storage.set({ mode: newMode }, () => applyUI(enabled, newMode));
    });
  });
});

// ── Threshold change ───────────────────────────────────────────────────────
if (thresholdInput) {
  thresholdInput.addEventListener('change', () => {
    const val = parseInt(thresholdInput.value, 10);
    if (!isNaN(val) && val >= 50 && val <= 100) {
      storage.set({ threshold: val });
    }
  });
}

