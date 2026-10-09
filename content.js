// KL University ERP – Subject Code Replacer v3.1
// Timetable cards + live ERP attendance overlay.

(async () => {

  // ── 1. Subject codes ───────────────────────────────────────────────────────
  let subjectMap = {};
  try {
    const res = await fetch(chrome.runtime.getURL('subject_codes.json'));
    subjectMap = await res.json();
  } catch (err) {
    console.error('[KL] Could not load subject_codes.json:', err);
  }
  
  // Load dynamically learned subjects
  let customSubjects = {};
  await new Promise(r => {
    try {
      chrome.storage.local.get(['kl_custom_subjects'], d => {
        if (d.kl_custom_subjects) customSubjects = d.kl_custom_subjects;
        r();
      });
    } catch { r(); }
  });
  
  Object.assign(subjectMap, customSubjects);

  const lookup = {};
  for (const [code, name] of Object.entries(subjectMap || {})) {
    if (code) lookup[code.trim().toUpperCase()] = { name, originalCode: code.trim() };
  }
  let allCodes = Object.keys(lookup).sort((a, b) => b.length - a.length);

  // ── 2. State ───────────────────────────────────────────────────────────────
  const state = { enabled: true, mode: 'name-only', threshold: 75 };
  let isProcessing = false;
  await new Promise(resolve => {
    try {
      chrome.storage.local.get({ enabled: true, mode: 'name-only', threshold: 75 }, r => {
        if (r) {
          if (r.enabled   !== undefined) state.enabled   = Boolean(r.enabled);
          if (r.mode      !== undefined) state.mode      = String(r.mode);
          if (r.threshold !== undefined) state.threshold = Number(r.threshold) || 75;
        }
        resolve();
      });
    } catch { resolve(); }
  });

  // ── 3. Attendance storage ──────────────────────────────────────────────────
  const ATT_KEY = 'kl_erp_attendance';

  async function loadAttendance() {
    return new Promise(resolve => {
      try { chrome.storage.local.get({ [ATT_KEY]: [] }, d => resolve(d[ATT_KEY] || [])); }
      catch { resolve([]); }
    });
  }
  async function saveAttendance(rows) {
    return new Promise(resolve => {
      try { chrome.storage.local.set({ [ATT_KEY]: rows }, resolve); }
      catch { resolve(); }
    });
  }

  let attendanceData = await loadAttendance();
  console.log(`[KL] Loaded ${attendanceData.length} stored attendance rows.`);

  // ── 4. Robust ERP Attendance scraper ──────────────────────────────────────
  function isAttendancePage() {
    const url = location.href.toLowerCase();
    if (url.includes('attendance') || url.includes('attendence')) return true;
    const h = document.querySelector('h1,h2,h3,.page-title,.panel-title,.portlet-title');
    return !!(h && /attendance/i.test(h.textContent));
  }

  /**
   * Finds the header row of a table regardless of whether it uses <th> or <td>.
   * Returns { headerRow: TR, cellTag: 'th'|'td' }
   */
  function findHeaderRow(table) {
    // Prefer explicit <thead> <th> row
    const theadRow = table.querySelector('thead tr');
    if (theadRow && theadRow.querySelectorAll('th').length > 2) return { headerRow: theadRow, cellTag: 'th' };
    // Try first row that is all <th>
    for (const tr of table.querySelectorAll('tr')) {
      const ths = tr.querySelectorAll('th');
      if (ths.length > 2) return { headerRow: tr, cellTag: 'th' };
    }
    // Fall back to first row of <td> (some ERP tables use td everywhere)
    const firstTr = table.querySelector('tr');
    if (firstTr && firstTr.querySelectorAll('td').length > 2) return { headerRow: firstTr, cellTag: 'td' };
    return null;
  }

  function scrapeAttendancePage(isSilent = true) {
    const tables = document.querySelectorAll('table');
    let newSubjectsFound = false;

    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti];
      const hInfo = findHeaderRow(table);
      if (!hInfo) continue;

      const { headerRow, cellTag } = hInfo;
      const rawHeaders = [...headerRow.querySelectorAll(cellTag)].map(c => c.textContent?.trim() || '');
      const headers    = rawHeaders.map(h => h.toLowerCase().replace(/\s+/g, ' '));

      // Subject Mapping Extraction (Self-Learning)
      const cCodeIdx = headers.findIndex(h => h.includes('coursecode') || h.includes('course code') || h.includes('subject code'));
      const cDescIdx = headers.findIndex(h => h.includes('coursedesc') || h.includes('course desc') || h.includes('course name') || h === 'subject');
      
      const allTrs = [...table.querySelectorAll('tbody tr')];
      const dataTrs = allTrs.length > 0 ? allTrs : [...table.querySelectorAll('tr')].filter(tr => tr !== headerRow);

      if (cCodeIdx !== -1 && cDescIdx !== -1) {
        for (const tr of dataTrs) {
          const cells = [...tr.querySelectorAll('td')];
          const code = cells[cCodeIdx]?.textContent?.trim();
          const desc = cells[cDescIdx]?.textContent?.trim();
          if (code && desc && code.length > 3 && desc.length > 3) {
            const upperCode = code.toUpperCase();
            if (!subjectMap[upperCode] || subjectMap[upperCode] !== desc) {
              subjectMap[upperCode] = desc;
              customSubjects[upperCode] = desc;
              lookup[upperCode] = { name: desc, originalCode: code };
              newSubjectsFound = true;
            }
          }
        }
      }

      // Must have at least coursedesc/coursecode and one of conducted/attended/percentage
      const hasCourse = cDescIdx !== -1 || cCodeIdx !== -1;
      const hasData   = headers.some(h => h.includes('conducted') || h.includes('attended') || h.includes('percentage') || h.includes('percent') || h === '%');
      
      if (!hasCourse || !hasData) continue;

      // Map column indices
      const idx = {};
      headers.forEach((h, i) => {
        if      (h.includes('coursedesc') || h.includes('course desc') || h.includes('course name')) idx.coursedesc = i;
        else if (h.includes('coursecode') || h.includes('course code') || h.includes('subject code')) idx.coursecode = i;
        else if (h === 'ltps' || h === 'type' || h === 'l/t/p/s')  idx.ltps      = i;
        else if (h.includes('total conducted') || (h.includes('conducted') && !h.includes('before'))) idx.conducted = i;
        else if (h.includes('total attended')  || h === 'attended' || h === 'total attended')         idx.attended  = i;
        else if (h.includes('total absent')    || h === 'absent'   || h === 'total absent')           idx.absent    = i;
        else if (h.includes('percentage') || h === 'percent' || h === '%')                            idx.pct       = i;
      });

      const rows = [];
      for (const tr of dataTrs) {
        const cells = [...tr.querySelectorAll('td')];
        if (cells.length < 3) continue;

        const get = k => {
          if (idx[k] === undefined || !cells[idx[k]]) return '';
          return cells[idx[k]].textContent?.trim() || '';
        };

        const coursedesc = get('coursedesc') || get('coursecode');
        const coursecode = get('coursecode');
        if (!coursedesc) continue;

        let ltps = get('ltps').toUpperCase().replace(/[^LTPS]/g, '').charAt(0) || '';
        if (!ltps) {
          for (const cell of cells) {
            const ct = (cell.textContent || '').trim().toUpperCase();
            if (ct === 'L' || ct === 'T' || ct === 'P' || ct === 'S') { ltps = ct; break; }
          }
        }

        const conducted = parseInt(get('conducted').replace(/[^0-9]/g, '')) || 0;
        const attended  = parseInt(get('attended').replace(/[^0-9]/g, ''))  || 0;
        const absent    = parseInt(get('absent').replace(/[^0-9]/g, ''))    || 0;
        const pctRaw    = get('pct').replace(/[^0-9.]/g, '');
        const pct       = parseFloat(pctRaw) || (conducted > 0 ? attended / conducted * 100 : 0);

        const row = { coursedesc: coursedesc.trim(), coursecode: (coursecode || '').trim(), ltps, conducted, attended, absent, pct };
        rows.push(row);
      }

      if (rows.length > 0) {
        console.log(`[KL] SUCCESS: scraped ${rows.length} rows from table.`);
        saveAttendance(rows);
        attendanceData = rows;
        showToast(`✅ Attendance data saved: ${rows.length} subjects`);
        
        if (newSubjectsFound) {
          allCodes = Object.keys(lookup).sort((a, b) => b.length - a.length);
          try { chrome.storage.local.set({ kl_custom_subjects: customSubjects }); } catch {}
          processTables(); // Re-process immediately with new codes
        }
        return rows;
      }
    }

    if (newSubjectsFound) {
      allCodes = Object.keys(lookup).sort((a, b) => b.length - a.length);
      try { chrome.storage.local.set({ kl_custom_subjects: customSubjects }); } catch {}
      console.log('[KL] Learned new subject mappings from page.');
      processTables();
    }

    if (!isSilent) {
      console.log('[KL] No attendance table found on this view yet.');
      showToast('⚠️ No attendance table found on this page.');
    }
    return [];
  }

  // Small on-page toast for feedback
  function showToast(msg) {
    try {
      const t = document.createElement('div');
      t.textContent = msg;
      Object.assign(t.style, {
        position:'fixed', bottom:'20px', right:'20px', zIndex:'999999',
        background:'#1e293b', color:'#f8fafc', padding:'10px 16px',
        borderRadius:'8px', fontSize:'13px', fontFamily:'system-ui,sans-serif',
        boxShadow:'0 4px 16px rgba(0,0,0,0.3)', transition:'opacity 0.4s',
        opacity:'1'
      });
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 500); }, 3500);
    } catch {}
  }

  // Debug helpers exposed globally
  window.klDebugAtt = function() {
    console.group('[KL] Stored attendance data');
    console.log('Row count:', attendanceData.length);
    console.table(attendanceData);
    console.groupEnd();
    return attendanceData;
  };
  window.klScrapeNow = function() {
    console.log('[KL] Manual scrape triggered.');
    return scrapeAttendancePage(false);
  };
  window.klRerender = function() {
    for (const [td, d] of processedCells) {
      if (td && d && d.parsedData) td.innerHTML = renderHTML(d.parsedData, state.mode);
    }
    console.log('[KL] Re-rendered', processedCells.size, 'cells.');
  };

  // ── 5. Lookup & calculation ────────────────────────────────────────────────
  const TYPE_TO_LTPS = { Lecture: 'L', Tutorial: 'T', Practical: 'P', Skilling: 'S' };

  /**
   * Match timetable block (courseName, typeName) to attendance row.
   * Strategy 1: exact coursedesc + ltps
   * Strategy 2: coursedesc contains or is contained by courseName + ltps
   * Strategy 3: word-overlap ≥ 60% + ltps
   */
  function wordSet(str) {
    return new Set(str.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 2));
  }

  function findAttRow(courseName, typeName) {
    if (!attendanceData || !attendanceData.length) return null;
    const cn = (courseName || '').trim().toLowerCase();
    const lt = TYPE_TO_LTPS[typeName] || null;

    const matchCandidate = (str, ltpsVal) => {
      if (ltpsVal !== lt) return false;
      const s = (str || '').trim().toLowerCase();
      return s === cn || s.includes(cn) || cn.includes(s);
    };

    // Strategy 1 — exact or substring on coursedesc or coursecode
    for (const row of attendanceData) {
      if ((row.coursedesc || '').trim().toLowerCase() === cn && row.ltps === lt) return row;
      if (row.coursecode && row.coursecode.trim().toLowerCase() === cn && row.ltps === lt) return row;
    }
    for (const row of attendanceData) {
      if (matchCandidate(row.coursedesc, row.ltps) || matchCandidate(row.coursecode, row.ltps)) return row;
    }

    // Strategy 2 — word overlap ≥ 60%
    const cnWords = wordSet(cn);
    let bestOverlap = 0, bestRow = null;
    for (const row of attendanceData) {
      if (row.ltps !== lt) continue;
      const descWords = wordSet(row.coursedesc || '');
      const codeWords = wordSet(row.coursecode || '');
      const combinedWords = new Set([...descWords, ...codeWords]);
      let common = 0;
      for (const w of cnWords) { if (combinedWords.has(w)) common++; }
      const overlap = common / Math.max(cnWords.size, combinedWords.size, 1);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestRow = row; }
    }
    if (bestOverlap >= 0.5) return bestRow;
    return null;
  }

  /**
   * Pure bunk calculations.
   * a=14, c=16, T=75 → pct=87.5, safeBunks=2  ✅
   * safeBunks        = floor(a/T − c)
   * classesToRecover = ceil((T*c − a) / (1 − T))
   */
  function calcAttStats(attended, conducted, thresholdPct) {
    if (!conducted) return { pct: 0, safeBunks: 0, classesToRecover: 0, colorClass: 'kl-att-no-data' };
    const T   = (thresholdPct || 75) / 100;
    const pct = (attended / conducted) * 100;
    let safeBunks = 0, classesToRecover = 0;
    if (pct >= (thresholdPct || 75)) safeBunks    = Math.max(0, Math.floor(attended / T - conducted));
    else                             classesToRecover = Math.ceil((T * conducted - attended) / (1 - T));
    let colorClass;
    if      (pct < (thresholdPct || 75)) colorClass = 'kl-att-red';
    else if (safeBunks === 0)            colorClass = 'kl-att-orange';
    else if (safeBunks <= 2)             colorClass = 'kl-att-yellow';
    else                                 colorClass = 'kl-att-green';
    return { pct, safeBunks, classesToRecover, colorClass };
  }
  window.calcAttStats = calcAttStats;

  // ── 6. Styles ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('kl-replacer-style')) return;
    const style = document.createElement('style');
    style.id = 'kl-replacer-style';
    style.textContent = `
      @keyframes kl-fade-in { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
      .kl-cell-card {
        display:flex!important; flex-direction:column!important;
        gap:5px!important; padding:12px 10px!important;
        font-family:system-ui,-apple-system,sans-serif!important;
        font-size:11.5px!important; line-height:1.35!important;
        text-align:center!important; box-sizing:border-box!important;
        min-width:190px!important; position:relative!important;
        background:#ffffff!important; border-radius:10px!important;
        box-shadow:0 2px 8px rgba(0,0,0,0.04)!important;
        border:1px solid #e2e8f0!important;
        transition:all 0.25s cubic-bezier(0.4, 0, 0.2, 1)!important;
      }
      .kl-cell-card:hover {
        transform:translateY(-3px)!important;
        box-shadow:0 8px 20px rgba(0,0,0,0.08)!important;
        border-color:#cbd5e1!important;
        z-index:10!important;
      }
      .kl-subject-name { font-weight:800!important; color:#0f172a!important; font-size:12.5px!important; word-break:normal!important; overflow-wrap:break-word!important; line-height:1.3!important; }
      .kl-subject-code { font-size:10px!important; color:#64748b!important; font-weight:700!important; letter-spacing:0.04em!important; margin-top:-3px!important; }
      .kl-badges-container { display:flex!important; flex-wrap:wrap!important; gap:5px!important; justify-content:center!important; align-items:center!important; margin-top:3px!important; }
      .kl-badge { display:inline-flex!important; align-items:center!important; padding:3px 8px!important; border-radius:6px!important; font-size:9.5px!important; font-weight:800!important; line-height:1.2!important; white-space:nowrap!important; letter-spacing:0.03em!important; text-transform:uppercase!important; }
      .kl-badge-lecture   { background:#eef2ff!important; color:#4338ca!important; border:1px solid #c7d2fe!important; }
      .kl-badge-tutorial  { background:#fffbeb!important; color:#b45309!important; border:1px solid #fde68a!important; }
      .kl-badge-practical { background:#f0fdf4!important; color:#15803d!important; border:1px solid #bbf7d0!important; }
      .kl-badge-skilling  { background:#faf5ff!important; color:#7e22ce!important; border:1px solid #e9d5ff!important; }
      .kl-badge-room      { background:#fef2f2!important; color:#b91c1c!important; border:1px solid #fecaca!important; }
      .kl-badge-section   { background:#f8fafc!important; color:#475569!important; border:1px solid #e2e8f0!important; }
      
      /* Attendance block */
      .kl-att-block { margin-top:8px!important; border-top:1px dashed #cbd5e1!important; padding-top:8px!important; display:flex!important; flex-direction:column!important; gap:5px!important; }
      .kl-att-count { font-size:10.5px!important; color:#475569!important; font-weight:700!important; }
      .kl-att-bar-wrap { background:#e2e8f0!important; border-radius:99px!important; height:7px!important; overflow:hidden!important; position:relative!important; box-shadow:inset 0 1px 2px rgba(0,0,0,0.1)!important; }
      .kl-att-bar-fill { height:100%!important; border-radius:99px!important; transition:width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)!important; }
      .kl-att-bar-fill.kl-att-green  { background:linear-gradient(90deg, #22c55e, #16a34a)!important; }
      .kl-att-bar-fill.kl-att-yellow { background:linear-gradient(90deg, #eab308, #ca8a04)!important; }
      .kl-att-bar-fill.kl-att-orange { background:linear-gradient(90deg, #f97316, #ea580c)!important; }
      .kl-att-bar-fill.kl-att-red    { background:linear-gradient(90deg, #ef4444, #dc2626)!important; }
      .kl-att-bar-tick { position:absolute!important; top:0!important; bottom:0!important; width:2px!important; background:rgba(15,23,42,0.8)!important; border-radius:1px!important; z-index:2!important; box-shadow:0 0 2px rgba(255,255,255,0.8)!important; }
      
      .kl-bunk-badge { display:inline-block!important; padding:3px 8px!important; border-radius:6px!important; font-size:10px!important; font-weight:800!important; margin-top:2px!important; letter-spacing:0.02em!important; transition:transform 0.2s!important; }
      .kl-bunk-badge:hover { transform:scale(1.03)!important; }
      .kl-bunk-badge.kl-att-green  { background:#dcfce7!important; color:#15803d!important; border:1px solid #bbf7d0!important; box-shadow:0 2px 5px rgba(22,163,74,0.1)!important; }
      .kl-bunk-badge.kl-att-yellow { background:#fef9c3!important; color:#a16207!important; border:1px solid #fde68a!important; box-shadow:0 2px 5px rgba(202,138,4,0.1)!important; }
      .kl-bunk-badge.kl-att-orange { background:#ffedd5!important; color:#c2410c!important; border:1px solid #fed7aa!important; box-shadow:0 2px 5px rgba(234,88,12,0.1)!important; }
      .kl-bunk-badge.kl-att-red    { background:#fee2e2!important; color:#b91c1c!important; border:1px solid #fca5a5!important; box-shadow:0 2px 5px rgba(220,38,38,0.1)!important; }
      .kl-bunk-badge.kl-att-no-data{ background:#f1f5f9!important; color:#64748b!important; border:1px solid #e2e8f0!important; font-style:italic!important; }
      
      /* Tooltip */
      .kl-cell-card:hover .kl-tooltip { opacity:1!important; transform:translateX(-50%) translateY(0)!important; pointer-events:auto!important; }
      .kl-tooltip {
        opacity:0!important; pointer-events:none!important;
        position:absolute!important; bottom:calc(100% + 10px)!important;
        left:50%!important; transform:translateX(-50%) translateY(5px)!important;
        background:rgba(15, 23, 42, 0.95)!important; color:#f8fafc!important;
        backdrop-filter:blur(4px)!important;
        font-size:11px!important; padding:10px 14px!important;
        border-radius:8px!important; white-space:nowrap!important;
        z-index:99999!important; box-shadow:0 8px 24px rgba(0,0,0,0.2)!important;
        transition:all 0.25s cubic-bezier(0.4, 0, 0.2, 1)!important;
        text-align:left!important; line-height:1.7!important; font-weight:500!important;
      }
      .kl-tooltip::after { content:''!important; position:absolute!important; top:100%!important; left:50%!important; transform:translateX(-50%)!important; border:6px solid transparent!important; border-top-color:rgba(15, 23, 42, 0.95)!important; }
      
      /* Today */
      tr.kl-today-row { background:rgba(59, 130, 246, 0.04)!important; }
      tr.kl-today-row > td:first-child { font-weight:800!important; color:#2563eb!important; background:rgba(59, 130, 246, 0.1)!important; border-left:4px solid #2563eb!important; }
      td.kl-today-col { background:rgba(59, 130, 246, 0.03)!important; }
      
      /* Summary bar */
      #kl-summary-bar {
        background:linear-gradient(135deg,#0f172a,#1e293b)!important;
        color:#f8fafc!important; padding:12px 20px!important;
        font-family:system-ui,-apple-system,sans-serif!important; font-size:12px!important;
        display:flex!important; align-items:center!important; gap:16px!important;
        flex-wrap:wrap!important; margin-bottom:12px!important; border-radius:10px!important;
        box-shadow:0 4px 12px rgba(0,0,0,0.15)!important; z-index:900!important;
        animation:kl-fade-in 0.4s ease-out!important;
        border:1px solid rgba(255,255,255,0.1)!important;
      }
      #kl-summary-bar .kl-sb-stat  { display:flex; gap:6px; align-items:center; }
      #kl-summary-bar .kl-sb-label { color:#cbd5e1; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }
      #kl-summary-bar .kl-sb-val   { font-weight:800; font-size:13.5px; }
      .kl-sb-green  { color:#4ade80!important; text-shadow:0 0 8px rgba(74,222,128,0.3)!important; }
      .kl-sb-red    { color:#f87171!important; text-shadow:0 0 8px rgba(248,113,113,0.3)!important; }
      .kl-sb-yellow { color:#facc15!important; }
      #kl-summary-bar .kl-sb-sep { color:#475569; }
      #kl-threshold-input {
        width:50px!important; padding:3px 6px!important; border-radius:6px!important;
        border:1px solid #475569!important; background:rgba(15,23,42,0.6)!important;
        color:#f8fafc!important; font-size:12px!important; font-weight:800!important;
        text-align:center!important; outline:none!important; transition:border-color 0.2s!important;
      }
      #kl-threshold-input:focus { border-color:#3b82f6!important; box-shadow:0 0 0 2px rgba(59,130,246,0.3)!important; }
      #kl-goto-att {
        padding:5px 14px!important; border-radius:6px!important;
        background:linear-gradient(135deg, #3b82f6, #2563eb)!important; color:#ffffff!important;
        border:none!important; font-size:11px!important;
        cursor:pointer!important; font-weight:700!important;
        box-shadow:0 2px 6px rgba(59,130,246,0.3)!important; transition:all 0.2s!important;
      }
      #kl-goto-att:hover { transform:translateY(-1px)!important; box-shadow:0 4px 10px rgba(59,130,246,0.4)!important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ── 7. Match & Parse ──────────────────────────────────────────────────────
  function matchCode(cellText) {
    if (!cellText) return null;
    const upper = cellText.toUpperCase();
    for (const code of allCodes) {
      if (upper.startsWith(code)) {
        const next = upper[code.length];
        if (next === undefined || next === '-' || next === ' ' || next === '\t' || next === '\n') return code;
      }
    }
    return null;
  }
  const LTPS = { L: 'Lecture', T: 'Tutorial', P: 'Practical', S: 'Skilling' };
  function parseCellData(originalCode, name, suffix) {
    const typeMatch  = suffix.match(/-([LTPS])(?=[\s\-]|$)/i);
    const typeLetter = typeMatch ? typeMatch[1].toUpperCase() : null;
    const typeName   = typeLetter ? (LTPS[typeLetter] || null) : null;
    const secMatch   = suffix.match(/(?:Section|Sec|S)[-\s]*(\d+)/i);
    const section    = secMatch ? `S-${secMatch[1]}` : null;
    const roomMatch  = suffix.match(/Room(?:\s*No)?[\s:\-]*([A-Za-z0-9_-]+)/i);
    const room       = roomMatch ? roomMatch[1] : null;
    return { originalCode, name, typeName, section, room };
  }

  // ── 8. Render HTML ────────────────────────────────────────────────────────
  function renderHTML(data, displayMode) {
    const { originalCode, name, typeName, section, room } = data;
    const T = state.threshold;
    const attRow = findAttRow(name, typeName);
    let attBlock = '', tooltip = '';

    if (attRow) {
      const { pct, safeBunks, classesToRecover, colorClass } = calcAttStats(attRow.attended, attRow.conducted, T);
      const pctStr   = pct.toFixed(1);
      const barWidth = Math.min(pct, 100).toFixed(1);
      const tickPos  = Math.min(T, 100).toFixed(1);
      let bunkText;
      if (pct >= T) {
        if      (safeBunks >= 3) bunkText = `\u2705 Safe bunks: ${safeBunks}`;
        else if (safeBunks >= 1) bunkText = `\uD83D\uDFE1 Safe bunks: ${safeBunks}`;
        else                     bunkText = `\u26A0\uFE0F On the edge`;
      } else {
        bunkText = `\uD83D\uDD34 Attend next ${classesToRecover} class${classesToRecover !== 1 ? 'es' : ''}`;
      }
      attBlock = `<div class="kl-att-block"><div class="kl-att-count">Attended ${attRow.attended} / ${attRow.conducted} (${pctStr}%)</div><div class="kl-att-bar-wrap"><div class="kl-att-bar-fill ${colorClass}" style="width:${barWidth}%"></div><div class="kl-att-bar-tick" style="left:${tickPos}%"></div></div><div class="kl-bunk-badge ${colorClass}">${bunkText}</div></div>`;
      tooltip  = `<div class="kl-tooltip">Conducted: ${attRow.conducted}<br>Attended: ${attRow.attended}<br>Absent: ${attRow.absent}<br>${attRow.attended}/${attRow.conducted}\u00D7100 = ${pctStr}%</div>`;
    } else {
      const hint = attendanceData.length === 0
        ? 'Visit the Attendance page first'
        : `No match for "${name}" (${typeName || '?'})`;
      attBlock = `<div class="kl-att-block"><div class="kl-bunk-badge kl-att-no-data">No attendance data</div></div>`;
      tooltip  = `<div class="kl-tooltip">${hint}</div>`;
    }

    let badgesHtml = '';
    if (typeName) badgesHtml += `<span class="kl-badge kl-badge-${typeName.toLowerCase()}">${typeName}</span>`;
    if (room)     badgesHtml += `<span class="kl-badge kl-badge-room">\uD83D\uDCCD Room ${room}</span>`;
    if (section)  badgesHtml += `<span class="kl-badge kl-badge-section">${section}</span>`;
    const codeHtml = (displayMode === 'code+name' && originalCode)
      ? `<div class="kl-subject-code">${originalCode}</div>` : '';

    return `<div class="kl-cell-card">${tooltip}<div class="kl-subject-name">${name}</div>${codeHtml}${badgesHtml ? `<div class="kl-badges-container">${badgesHtml}</div>` : ''}${attBlock}</div>`;
  }

  // ── 9. Cell tracking ──────────────────────────────────────────────────────
  const processedCells = new Map();
  function processCell(td) {
    if (!td || processedCells.has(td)) return false;
    const text = (td.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (!text || text === '-') return false;
    const codeKey = matchCode(text);
    if (!codeKey || !lookup[codeKey]) return false;
    const { name, originalCode } = lookup[codeKey];
    const suffix = text.slice(originalCode ? originalCode.length : codeKey.length) || '';
    const parsedData = parseCellData(originalCode, name, suffix);
    processedCells.set(td, { originalHTML: td.innerHTML, originalText: text, parsedData });
    td.innerHTML = renderHTML(parsedData, state.mode);
    return true;
  }

  // ── 10. Today highlight ───────────────────────────────────────────────────
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function highlightToday() {
    try {
      const todayFull = DAY_NAMES[new Date().getDay()].toLowerCase();
      const todayShort = todayFull.slice(0, 3);
      document.querySelectorAll('table tr').forEach(tr => {
        const fc = tr.querySelector('td:first-child, th:first-child');
        if (!fc) return;
        const t = fc.textContent.trim().toLowerCase();
        if (t === todayFull || t === todayShort) tr.classList.add('kl-today-row');
      });
    } catch {}
  }

  // ── 11. Back-to-back merge ────────────────────────────────────────────────
  function mergeBackToBack() {
    try {
      document.querySelectorAll('table tbody tr, table tr:not(:first-child)').forEach(tr => {
        const cells = [...tr.querySelectorAll('td')];
        let i = 0;
        while (i < cells.length - 1) {
          const cur = cells[i], nxt = cells[i + 1];
          const cc = cur?.querySelector('.kl-cell-card');
          const nc = nxt?.querySelector('.kl-cell-card');
          if (!cc || !nc) { i++; continue; }
          const cn = cc.querySelector('.kl-subject-name')?.textContent?.trim();
          const nn = nc.querySelector('.kl-subject-name')?.textContent?.trim();
          const ct = cc.querySelector('.kl-badge')?.textContent?.trim();
          const nt = nc.querySelector('.kl-badge')?.textContent?.trim();
          if (cn && cn === nn && ct === nt) {
            cur.colSpan = (Number(cur.colSpan) || 1) + (Number(nxt.colSpan) || 1);
            try { nxt.remove(); } catch {}
            cells.splice(i + 1, 1);
          } else { i++; }
        }
      });
    } catch {}
  }

  // ── 12. Summary bar ──────────────────────────────────────────────────────
  function buildSummaryBar() {
    if (document.getElementById('kl-summary-bar')) return;
    const T = state.threshold;
    const bar = document.createElement('div');
    bar.id = 'kl-summary-bar';

    if (!attendanceData || !attendanceData.length) {
      bar.innerHTML = `
        <div class="kl-sb-stat"><span style="color:#facc15;font-size:14px">⚠️</span><span class="kl-sb-label" style="color:#f8fafc">No attendance data scraped yet.</span></div>
        <button id="kl-goto-att" onclick="window.open(location.origin+'/Student/StudentAttendance','_blank')">Open Attendance Page →</button>
        <div class="kl-sb-stat"><label for="kl-threshold-input" class="kl-sb-label">Threshold</label><input id="kl-threshold-input" type="number" min="1" max="100" value="${T}"><span style="color:#94a3b8;font-size:10px;margin-left:-3px">%</span></div>
      `;
    } else {
      let totalAtt = 0, totalCon = 0, danger = 0, bestSafe = -1, bestRow = null;
      for (const row of attendanceData) {
        totalAtt += row.attended; totalCon += row.conducted;
        const { pct, safeBunks } = calcAttStats(row.attended, row.conducted, T);
        if (pct < T) danger++;
        if (safeBunks > bestSafe) { bestSafe = safeBunks; bestRow = row; }
      }
      const ovPct  = totalCon > 0 ? (totalAtt / totalCon * 100).toFixed(1) : '--';
      const pctCls = parseFloat(ovPct) >= T ? 'kl-sb-green' : 'kl-sb-red';
      const bestLbl = bestRow
        ? (bestRow.coursedesc.length > 28 ? bestRow.coursedesc.slice(0,28)+'…' : bestRow.coursedesc) + ` (${bestSafe} bunks)`
        : 'N/A';
      bar.innerHTML = `
        <div class="kl-sb-stat"><span class="kl-sb-label">Overall</span><span class="kl-sb-val ${pctCls}">${ovPct}%</span></div>
        <span class="kl-sb-sep">|</span>
        <div class="kl-sb-stat"><span class="kl-sb-label">In danger</span><span class="kl-sb-val kl-sb-red">${danger}</span></div>
        <span class="kl-sb-sep">|</span>
        <div class="kl-sb-stat"><span class="kl-sb-label">Best to bunk</span><span class="kl-sb-val kl-sb-green" title="${bestRow ? bestRow.coursedesc : ''}">${bestLbl}</span></div>
        <span class="kl-sb-sep">|</span>
        <div class="kl-sb-stat"><label for="kl-threshold-input" class="kl-sb-label">Threshold</label><input id="kl-threshold-input" type="number" min="1" max="100" value="${T}"><span style="color:#94a3b8;font-size:10px;margin-left:-3px">%</span></div>
      `;
    }

    try {
      const firstTable = document.querySelector('table');
      if (firstTable?.parentElement) firstTable.parentElement.insertBefore(bar, firstTable);
      else document.body?.prepend(bar);
    } catch {}

    const thresholdInput = document.getElementById('kl-threshold-input');
    if (thresholdInput) {
      thresholdInput.addEventListener('change', async e => {
        const v = parseInt(e.target.value);
        if (isNaN(v) || v < 1 || v > 100) return;
        state.threshold = v;
        try { await new Promise(r => chrome.storage.local.set({ threshold: v }, r)); } catch {}
        for (const [td, d] of processedCells) {
          if (td && d?.parsedData) td.innerHTML = renderHTML(d.parsedData, state.mode);
        }
        document.getElementById('kl-summary-bar')?.remove();
        buildSummaryBar();
      });
    }
  }

  // ── 13. Process tables ────────────────────────────────────────────────────
  function processTables() {
    if (!state.enabled || isProcessing) return 0;
    if (!document.querySelector('table')) return 0;
    injectStyles();
    isProcessing = true;
    let n = 0;
    try { for (const td of document.querySelectorAll('table td')) { if (processCell(td)) n++; } }
    finally { isProcessing = false; }
    if (n > 0) setTimeout(() => { mergeBackToBack(); highlightToday(); buildSummaryBar(); }, 150);
    return n;
  }

  function restoreAll() {
    isProcessing = true;
    try {
      for (const [td, d] of processedCells) { if (td && d) td.innerHTML = d.originalHTML || d.originalText; }
      processedCells.clear();
      document.getElementById('kl-summary-bar')?.remove();
    } finally { isProcessing = false; }
  }

  function reapplyAll() {
    isProcessing = true;
    try {
      injectStyles();
      for (const [td, d] of processedCells) { if (td && d?.parsedData) td.innerHTML = renderHTML(d.parsedData, state.mode); }
    } finally { isProcessing = false; }
    setTimeout(() => { mergeBackToBack(); highlightToday(); }, 150);
    document.getElementById('kl-summary-bar')?.remove();
    buildSummaryBar();
  }

  // ── 14. Observer ──────────────────────────────────────────────────────────
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    if (!state.enabled || isProcessing) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processTables, 200);
  });
  function startObserver() {
    stopObserver();
    const t = document.body || document.documentElement;
    if (t) { try { observer.observe(t, { childList: true, subtree: true }); } catch {} }
  }
  function stopObserver() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    try { observer.disconnect(); } catch {}
  }

  // ── 15. Storage listener ──────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (changes.enabled?.newValue   !== undefined) state.enabled   = Boolean(changes.enabled.newValue);
    if (changes.mode?.newValue      !== undefined) state.mode      = String(changes.mode.newValue);
    if (changes.threshold?.newValue !== undefined) state.threshold = Number(changes.threshold.newValue);
    if (changes[ATT_KEY]) {
      attendanceData = changes[ATT_KEY].newValue || [];
      console.log(`[KL] Attendance updated via storage: ${attendanceData.length} rows.`);
      // Re-render timetable blocks if we just got fresh data
      if (attendanceData.length > 0 && processedCells.size > 0) {
        reapplyAll();
      } else if (attendanceData.length > 0) {
        processTables();
      }
    }
    if (!state.enabled) { restoreAll(); stopObserver(); }
    else { reapplyAll(); processTables(); startObserver(); }
  });

  // ── 16. Bootstrap ─────────────────────────────────────────────────────────
  // Attendance page: scrape quietly and observe for dynamic table renders
  if (isAttendancePage()) {
    let scraped = false;
    const tryScrape = () => {
      if (scraped) return;
      const rows = scrapeAttendancePage(true);
      if (rows && rows.length > 0) scraped = true;
    };

    setTimeout(tryScrape, 500);
    setTimeout(tryScrape, 1500);
    setTimeout(tryScrape, 3000);

    const attObserver = new MutationObserver(() => {
      if (!scraped) tryScrape();
    });
    try {
      const root = document.body || document.documentElement;
      if (root) attObserver.observe(root, { childList: true, subtree: true });
    } catch {}
  }

  if (!state.enabled) return;

  let attempts = 0;
  function tryReplace() {
    if (!state.enabled) return;
    const n = processTables();
    if (n > 0) console.log(`[KL] v3.1 - ${n} cell(s) formatted (attempt ${attempts + 1}). Att rows: ${attendanceData.length}`);
    if (++attempts < 20) setTimeout(tryReplace, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { tryReplace(); startObserver(); }, { once: true });
  } else {
    tryReplace();
    startObserver();
  }

})();
