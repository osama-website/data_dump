// image_bench — single-page client with hash routing.
//
// Routes:
//   #/                       → all albums
//   #/year/<y>               → albums filtered to year <y>
//   #/album/<id>             → album detail
//   #/suggestions            → suggestions panel
//   #/flagged                → review images flagged for deletion
const $ = (s, p=document) => p.querySelector(s);
const $$ = (s, p=document) => Array.from(p.querySelectorAll(s));
const root = $('#root');

// ── shared state ─────────────────────────────────────────────
let albumsCache    = null;
let yearsCache     = null;
let camerasCache   = null;
let selected       = new Set();   // selected album ids in grid view
let lastAlbumClick = null;
let albumDetailCache = null;
let cutoffPath     = null;
let cutoffSide     = 'after';
let selectedPhotos = new Set();   // ctrl-click subset inside an album
let lastPhotoClick = null;
let sugView        = 'merge';
// hinted split candidates from the server (visual only until promoted)
let hintMode   = null;            // 'contiguous' | 'subset' | null
let hintPaths  = new Set();
let hintCutPath = null;           // for contiguous hint
let hintSide    = 'after';        // for contiguous hint
let neighborToken = 0;            // rev counter so out-of-order responses are dropped
// keyboard focus + range anchors for arrow-key navigation
let focusedAlbumIdx     = -1;
let albumRangeAnchorIdx = -1;
let focusedPhotoIdx     = -1;
let photoRangeAnchorIdx = -1;
let hideDeleted         = false;  // hide albums whose every photo is flagged
let viewKind       = 'albums';
let currentAlbumId = '';
let currentYear    = '';
let currentCamera  = '';
let currentSearch  = '';

const fmtDate = s => (s || '').slice(0, 16).replace('T',' ');
const thumbURL = p => '/api/thumb?p=' + encodeURIComponent(p);

function toast(msg, ms=2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts={}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg;
    try { msg = (await r.json()).error || r.statusText; } catch { msg = r.statusText; }
    toast('error: ' + msg, 3500);
    throw new Error(msg);
  }
  return r.json();
}

async function refreshStats() {
  const s = await api('/api/stats');
  const flag = s.n_flagged ? `· <a href="#/flagged">${s.n_flagged} flagged</a>` : '';
  $('#stats').innerHTML =
    `${s.n_images.toLocaleString()} imgs · ${s.n_albums_current} albums (${s.n_albums_orig} orig) · ${s.n_overrides} edits · ${s.n_history} actions ${flag}`;
  // counts in dropdowns are derived from the album set, so invalidate caches
  // when a merge/split/flag happened (any history advance).
  yearsCache = null; camerasCache = null;
}

// ── router ───────────────────────────────────────────────────
function navigate(hash, {replace=false} = {}) {
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route();
}

function route() {
  const raw = location.hash || '#/';
  // strip optional query string for path matching, keep params for filters
  const qIdx = raw.indexOf('?');
  const path = decodeURIComponent(qIdx >= 0 ? raw.slice(0, qIdx) : raw);
  const params = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  currentYear   = params.get('year')   || '';
  currentCamera = params.get('camera') || '';
  if (path.startsWith('#/album/')) {
    currentAlbumId = path.slice('#/album/'.length);
    return openAlbum(currentAlbumId);
  }
  // legacy support — convert old #/year/X to query form
  if (path.startsWith('#/year/')) {
    const y = path.slice('#/year/'.length);
    return navigate(`#/?year=${encodeURIComponent(y)}`, {replace: true});
  }
  if (path === '#/suggestions') return renderSuggestions();
  if (path === '#/flagged')     return renderFlagged();
  return renderAlbums();
}

function gridHashFromFilters() {
  const qs = new URLSearchParams();
  if (currentYear)   qs.set('year',   currentYear);
  if (currentCamera) qs.set('camera', currentCamera);
  const s = qs.toString();
  return s ? '#/?' + s : '#/';
}

window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);

// ── Albums grid view ─────────────────────────────────────────
async function renderAlbums() {
  viewKind = 'albums';
  // reset keyboard focus/anchor for the new render
  focusedAlbumIdx = -1; albumRangeAnchorIdx = -1;
  const crumbBits = [];
  if (currentYear)   crumbBits.push(`year=${escapeHtml(currentYear)}`);
  if (currentCamera) crumbBits.push(`camera=${escapeHtml(currentCamera)}`);
  if (currentSearch) crumbBits.push(`q="${escapeHtml(currentSearch)}"`);
  $('#crumbs').innerHTML = crumbBits.length ? '· ' + crumbBits.join(' · ') : '· all albums';
  $('#btn-split').disabled = true;
  $('#btn-flag').disabled = selected.size === 0;
  $('#search').value = currentSearch;

  // years + cameras are reused across renders, refresh only if needed
  if (!yearsCache)   yearsCache   = (await api('/api/years')).years;
  if (!camerasCache) camerasCache = (await api('/api/cameras')).cameras;

  const qs = new URLSearchParams();
  if (currentSearch) qs.set('q',      currentSearch);
  if (currentYear)   qs.set('year',   currentYear);
  if (currentCamera) qs.set('camera', currentCamera);
  const data = await api('/api/albums?' + qs.toString());
  // Hide-deleted filter: an album is "deleted" when every one of its photos
  // is flagged. We only need to skip those tiles in the grid; their data
  // is still on the server, and toggling the button brings them back.
  const totalFetched = data.albums.length;
  const totalHidden = data.albums.filter(a => a.n_flagged >= a.n && a.n > 0).length;
  albumsCache = hideDeleted
    ? data.albums.filter(a => !(a.n_flagged >= a.n && a.n > 0))
    : data.albums;

  root.innerHTML = '';

  // filter row: two <select>s + reset link
  const totalAlbumsAll  = yearsCache.reduce((s,y) => s + y.albums, 0);
  const filters = document.createElement('div');
  filters.className = 'filters';
  filters.innerHTML = `
    <label class="filter">
      <span>year</span>
      <select id="f-year">
        <option value="">all (${totalAlbumsAll})</option>
        ${yearsCache.map(y =>
          `<option value="${escapeHtml(y.year)}" ${currentYear === y.year ? 'selected' : ''}>${escapeHtml(y.year)} — ${y.albums} albums${y.flagged ? ` · ${y.flagged}✕` : ''}</option>`
        ).join('')}
      </select>
    </label>
    <label class="filter">
      <span>camera</span>
      <select id="f-cam">
        <option value="">all cameras (${camerasCache.length})</option>
        ${camerasCache.map(c =>
          `<option value="${escapeHtml(c.camera)}" ${currentCamera === c.camera ? 'selected' : ''}>${escapeHtml(c.camera)} — ${c.albums} albums${c.flagged ? ` · ${c.flagged}✕` : ''}</option>`
        ).join('')}
      </select>
    </label>
    ${(currentYear || currentCamera || currentSearch)
      ? `<a href="#/" class="filter-reset">clear filters</a>` : ''}
    <span class="filter-count">${albumsCache.length} matching album${albumsCache.length === 1 ? '' : 's'}${(hideDeleted && totalHidden > 0) ? ` <span class="muted">(${totalHidden} hidden as deleted)</span>` : ''}</span>
  `;
  filters.querySelector('#f-year').onchange = (e) => {
    currentYear = e.target.value || '';
    navigate(gridHashFromFilters());
  };
  filters.querySelector('#f-cam').onchange = (e) => {
    currentCamera = e.target.value || '';
    navigate(gridHashFromFilters());
  };
  root.appendChild(filters);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const a of albumsCache) {
    const el = document.createElement('div');
    el.className = 'album' + (selected.has(a.id) ? ' selected' : '');
    el.dataset.id = a.id;
    const nameLine = a.display_name
      ? `<div class="name display-name" title="${escapeHtml(a.id)}">${escapeHtml(a.display_name)}</div>
         <div class="orig-name muted" title="${escapeHtml(a.id)}">${escapeHtml(a.id.split('/').slice(-1)[0])}</div>`
      : `<div class="name" title="${escapeHtml(a.id)}">${escapeHtml(a.id)}</div>`;
    el.innerHTML = `
      <div class="thumb" style="background-image:url('${thumbURL(a.cover)}')"></div>
      ${a.split_part ? '<span class="split-badge">split</span>' : ''}
      ${a.has_meta ? '<span class="meta-badge" title="metadata set">★</span>' : ''}
      ${a.n_flagged ? `<span class="flag-badge" title="${a.n_flagged} flagged for deletion">✕${a.n_flagged}</span>` : ''}
      <div class="meta">
        ${nameLine}
        <div class="sub">
          <span>${a.n} img</span>
          <span>${fmtDate(a.date_min) || '—'}</span>
        </div>
      </div>`;
    el.addEventListener('click', (e) => onAlbumClick(e, a.id));
    el.addEventListener('dblclick', () => navigate('#/album/' + encodeURIComponent(a.id)));
    grid.appendChild(el);
  }
  root.appendChild(grid);
  syncHeaderButtons();
}

function onAlbumClick(e, id) {
  if (e.shiftKey && lastAlbumClick && albumsCache) {
    // shift-range: select range without opening drawer
    const ids = albumsCache.map(a => a.id);
    const a = ids.indexOf(lastAlbumClick);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selected.add(ids[i]);
    }
  } else if (e.metaKey || e.ctrlKey) {
    // cmd/ctrl: toggle single without opening drawer
    if (selected.has(id)) selected.delete(id); else selected.add(id);
  } else {
    // plain click: REPLACE selection with just this one album (file-manager
    // semantics). Click an already-selected album to deselect everything.
    if (selected.has(id) && selected.size === 1) {
      selected.clear();
    } else {
      selected.clear();
      selected.add(id);
    }
  }
  lastAlbumClick = id;
  for (const node of $$('.album')) node.classList.toggle('selected', selected.has(node.dataset.id));
  syncHeaderButtons();
  // refresh whichever panels are already open so they track the active album
  if (document.body.classList.contains('tp-open')) loadTaggerForAlbum(id);
  if (drawerAlbumId && drawerAlbumId !== '__group__') openDrawer(id);
}

// ── right-side drawer (merge candidates for one album) ─────
let drawerToken = 0;
let drawerAlbumId = null;

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-scrim').classList.remove('show');
  drawerAlbumId = null;
}

async function openDrawer(id) {
  drawerAlbumId = id;
  const tok = ++drawerToken;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').classList.add('show');
  $('#drawer-body').innerHTML = '<div class="muted" style="padding:8px">loading ...</div>';
  let data;
  try {
    data = await api('/api/album?id=' + encodeURIComponent(id));
  } catch (err) {
    if (tok !== drawerToken) return;
    $('#drawer-body').innerHTML = `<div class="muted">error: ${escapeHtml(String(err))}</div>`;
    return;
  }
  if (tok !== drawerToken) return;
  const merges  = data.merge_suggestions || [];
  const splits  = data.split_suggestions || [];
  const nearest = data.nearest_albums    || [];

  // Build a unified candidate list: pre-computed (ranked) first, then nearest
  // (on-demand cosine) for any not already shown. This guarantees the drawer
  // never shows "no candidates" — every album has at least its top cosine
  // matches across the archive.
  const seen = new Set();
  const rows = [];
  for (const s of merges) {
    const other = s.a === id ? s.b : s.a;
    if (seen.has(other)) continue;
    seen.add(other);
    const otherMeta = s.a === id ? s.b_meta : s.a_meta;
    rows.push({
      src: 'ranked', other, cover: (otherMeta && otherMeta.cover) || '',
      cos: s.cos, score: s.score, gap_days: s.gap_days, same_event: s.same_event,
      n: (otherMeta && otherMeta.n) || 0,
    });
  }
  for (const n of nearest) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    rows.push({
      src: 'cosine', other: n.id, cover: n.cover,
      cos: n.cos, score: null, gap_days: null, same_event: false,
      n: n.n, still_exists: n.still_exists,
    });
  }

  const html = `
    <div class="drawer-hero">
      <div class="cov" style="background-image:url('${thumbURL(data.images[0] && data.images[0].p || '')}')"></div>
      <div>
        <div class="h-name">${escapeHtml(id)}</div>
        <div class="h-sub">${data.n} photos${data.n_flagged ? ` · <span style="color:#f66">✕ ${data.n_flagged} flagged</span>` : ''}</div>
        <div class="h-btns">
          <button class="open-btn" id="drawer-open-album">open album</button>
        </div>
      </div>
    </div>
    <div class="section-h">merge candidates · ranked by mean(photo-CLIP) cosine</div>
    <div class="muted" style="font-size:10px;margin-bottom:6px">${merges.length} pre-ranked · ${nearest.length} on-demand nearest fallbacks</div>
    <div id="drawer-merges">${
      rows.length === 0
        ? '<div class="muted" style="padding:6px 4px;font-size:11px">no comparable albums (embedding missing for this id)</div>'
        : rows.slice(0, 15).map(r => {
            const pillCls = r.cos >= 0.95 ? 'high' : (r.cos >= 0.85 ? '' : 'warn');
            const tag = r.src === 'ranked'
              ? `<span class="score-pill ${pillCls}">cos ${r.cos.toFixed(2)} · score ${r.score.toFixed(2)}</span>`
              : `<span class="score-pill ${pillCls}">cos ${r.cos.toFixed(2)}</span> <span class="muted" style="font-size:9px">(fallback)</span>`;
            const meta = r.src === 'ranked'
              ? `gap ${r.gap_days.toFixed(1)} d${r.same_event ? ' · same event' : ''}`
              : `${r.n} photos`;
            return `<div class="cand" data-other="${escapeHtml(r.other)}">
              <div class="cov" style="background-image:url('${thumbURL(r.cover)}')"></div>
              <div class="info">
                <div class="name" title="${escapeHtml(r.other)}">${escapeHtml(r.other.split('/').slice(-1)[0])}</div>
                <div class="sub muted">${escapeHtml(r.other.split('/').slice(0, -1).join('/'))}</div>
                <div class="sub">${tag} <span class="muted">· ${meta}</span></div>
                <div class="row-btns">
                  <button class="apply">merge</button>
                  <button class="open">open</button>
                </div>
              </div>
            </div>`;
          }).join('')
    }</div>
    ${splits.length ? `<div class="section-h" style="margin-top:14px">split hints for this album (${splits.length})</div>
       <div id="drawer-splits">${splits.slice(0,3).map(s => {
         const mode = s.mode || 'contiguous';
         return `<div class="cand-split mode-${mode}">
           <div class="sub"><span class="score-pill ${s.score >= 0.55 ? 'high' : 'warn'}">${mode} ${s.score.toFixed(2)}</span>
             <span class="muted">${s.n_highlight} photos</span></div>
           <div class="cand-split-btns"><button class="open-detail">open in detail view</button></div>
         </div>`;
       }).join('')}</div>` : ''}
  `;
  $('#drawer-body').innerHTML = html;
  $('#drawer-open-album').onclick = () => { closeDrawer(); navigate('#/album/' + encodeURIComponent(id)); };
  $$('#drawer-merges .cand').forEach(c => {
    c.querySelector('.open').onclick = () => { closeDrawer(); navigate('#/album/' + encodeURIComponent(c.dataset.other)); };
    c.querySelector('.apply').onclick = async () => {
      const r = await api('/api/merge', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({album_ids: [id, c.dataset.other]})});
      toast(mergeToastMsg(r));
      selected.clear();
      await refreshStats();
      await renderAlbums();
      openDrawer(id);     // re-pull so consumed candidate disappears
    };
  });
  $$('#drawer-splits .open-detail').forEach(b => {
    b.onclick = () => { closeDrawer(); navigate('#/album/' + encodeURIComponent(id)); };
  });
  // if the tagger panel is already open, mirror the album into it so the
  // metadata stays in sync. Don't force-open it.
  if (document.body.classList.contains('tp-open')) loadTaggerForAlbum(id, data);
}

function renderMetaEditor(id, meta) {
  const tags = Array.isArray(meta.tags) ? meta.tags.join(', ') : (meta.tags || '');
  return `
    <div class="meta-editor">
      <div class="section-h" style="margin-top:14px">album metadata${meta.updated_at ? ` <span class="muted" style="font-weight:400">· saved ${escapeHtml(meta.updated_at)}</span>` : ''}</div>
      <div class="me-row">
        <label>name</label>
        <input id="me-name" type="text" placeholder="(no display name set)" value="${escapeHtml(meta.name || '')}">
      </div>
      <div class="me-row">
        <label>year</label>
        <input id="me-year" type="text" placeholder="YYYY" maxlength="4" value="${escapeHtml(meta.year || '')}">
      </div>
      <div class="me-row">
        <label>location</label>
        <input id="me-location" type="text" placeholder="City, Country" value="${escapeHtml(meta.location || '')}">
      </div>
      <div class="me-row">
        <label>tags</label>
        <input id="me-tags" type="text" placeholder="Comma, Separated" value="${escapeHtml(tags)}">
      </div>
      <div class="me-row">
        <label>notes</label>
        <textarea id="me-notes" rows="2" placeholder="(no notes)">${escapeHtml(meta.notes || '')}</textarea>
      </div>
      <div class="me-buttons">
        <button id="me-suggest" class="primary">🤖 suggest with Gemini</button>
        <button id="me-save">save</button>
        <button id="me-reset">reset</button>
      </div>
      <div id="me-status" class="muted" style="font-size:11px; margin-top:4px"></div>
    </div>
  `;
}

// ── Left tagger panel ────────────────────────────────────────
let taggerCurrentId = null;
let janusPollTimer  = null;

function toggleTagger(force) {
  const panel = $('#tagger-panel');
  const open  = force === true ? true : force === false ? false : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  document.body.classList.toggle('tp-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  if (open) {
    pollJanusStatusOnce();
    if (!janusPollTimer) janusPollTimer = setInterval(pollJanusStatusOnce, 8000);
  } else if (janusPollTimer) {
    clearInterval(janusPollTimer); janusPollTimer = null;
  }
}

async function loadTaggerForAlbum(id, prefetched=null) {
  taggerCurrentId = id;
  const body = $('#tp-body');
  body.innerHTML = '<div class="muted" style="padding:14px;font-size:11px">loading metadata...</div>';
  let d = prefetched;
  if (!d) {
    try { d = await api('/api/album?id=' + encodeURIComponent(id)); }
    catch (err) { body.innerHTML = `<div class="muted">error: ${escapeHtml(String(err))}</div>`; return; }
  }
  const cover = (d.images && d.images[0] && d.images[0].p) || '';
  const meta  = d.meta || {};
  body.innerHTML = `
    <div class="tp-hero">
      <div class="cov" style="background-image:url('${thumbURL(cover)}')"></div>
      <div>
        <div class="h-name" title="${escapeHtml(id)}">${escapeHtml(meta.name || id)}</div>
        <div class="h-sub">${d.n} photos${d.n_flagged ? ` · ✕ ${d.n_flagged} flagged` : ''}</div>
        <div class="h-sub muted">${escapeHtml(id)}</div>
      </div>
    </div>
    ${renderMetaEditor(id, meta)}
    <div class="tp-section">
      <div class="label">ai engines</div>
      <div class="tp-engine-row">
        <button id="me-suggest" class="gemini">🤖 Gemini</button>
        <button id="me-suggest-janus" class="janus">🧠 Janus</button>
      </div>
      <div id="janus-status-bar" class="janus-status" style="margin-top:8px">
        <span class="janus-dot off"></span>
        <span class="muted">checking janus...</span>
      </div>
      <div class="tp-engine-row" style="margin-top:4px">
        <button id="janus-start">start Janus GPU</button>
        <button id="janus-stop">stop Janus</button>
      </div>
    </div>
  `;
  wireMetaEditor(id);
  $('#me-suggest-janus').onclick = () => doSuggestJanus(id);
  $('#janus-start').onclick = () => doJanusStart();
  $('#janus-stop').onclick  = () => doJanusStop();
  pollJanusStatusOnce();
}

async function pollJanusStatusOnce() {
  const bar = $('#janus-status-bar');
  const startBtn = $('#janus-start'); const stopBtn = $('#janus-stop');
  const janBtn = $('#me-suggest-janus');
  if (!bar) return;
  let s;
  try { s = await (await fetch('/api/janus_status')).json(); }
  catch (err) { bar.innerHTML = '<span class="janus-dot off"></span> <span class="muted">status check failed</span>'; return; }
  let dot = 'off', label = 'janus offline', canSuggest = false, canStart = true, canStop = false;
  if (s.endpoint_ready) {
    dot = 'ready'; label = `janus ready @ ${s.endpoint.replace(/^https?:\/\//,'')}`;
    canSuggest = true; canStart = false; canStop = true;
  } else if (s.job_state === 'r') {
    dot = 'starting'; label = 'janus job running, model still loading...';
    canStart = false; canStop = true;
  } else if (s.job_state === 'qw') {
    dot = 'starting'; label = 'janus queued, waiting for GPU...';
    canStart = false; canStop = true;
  }
  bar.innerHTML = `<span class="janus-dot ${dot}"></span> <span class="muted">${label}</span>`;
  if (janBtn) { janBtn.disabled = !canSuggest; janBtn.title = canSuggest ? '' : 'janus endpoint not ready'; }
  if (startBtn) { startBtn.disabled = !canStart; }
  if (stopBtn)  { stopBtn.disabled  = !canStop; }
}

async function doJanusStart() {
  const me = $('#janus-status-bar');
  me.innerHTML = '<span class="janus-dot starting"></span> <span class="muted">submitting qsub ...</span>';
  try {
    const r = await api('/api/janus_start', {method:'POST'});
    toast(r.note || 'janus job submitted — cold start ~2-3 min');
  } catch (e) {}
  pollJanusStatusOnce();
}

async function doJanusStop() {
  if (!confirm('Stop the Janus GPU job?')) return;
  try {
    const r = await api('/api/janus_stop', {method:'POST'});
    toast(r.note || `killed: ${(r.killed||[]).join(',')}`);
  } catch (e) {}
  pollJanusStatusOnce();
}

async function doSuggestJanus(id) {
  const me = $('#me-status');
  me.textContent = 'asking janus (collage → vision model, ~10-30s) ...';
  let r;
  try {
    r = await fetch('/api/suggest_album_meta_janus', {method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({id})});
    const j = await r.json();
    if (!r.ok || j.error) { me.textContent = 'janus: ' + (j.error || r.statusText); return; }
    const s = j.suggestion;
    // Janus output: only notes + tags are populated; name/year/location need user input
    if (s.notes) $('#me-notes').value = s.notes;
    if (s.tags && s.tags.length) {
      const existing = $('#me-tags').value.split(',').map(t => t.trim()).filter(Boolean);
      const merged = [...new Set([...existing, ...s.tags])];
      $('#me-tags').value = merged.join(', ');
    }
    me.innerHTML = `janus filled <b>notes</b> + <b>tags</b>. Fill name/year/location yourself, then save. <span class="muted">(${j._engine})</span>`;
  } catch (err) {
    me.textContent = 'janus error: ' + err;
  }
}

function wireMetaEditor(id) {
  const me = $('#me-status');
  $('#me-suggest').onclick = async () => {
    me.textContent = 'asking gemini (collage → gemini-3.5-flash, may take ~10s) ...';
    let r;
    try {
      r = await fetch('/api/suggest_album_meta', {method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({id})});
      const j = await r.json();
      if (!r.ok || j.error) { me.textContent = 'gemini: ' + (j.error || r.statusText); return; }
      const s = j.suggestion;
      if (s.name)     $('#me-name').value     = s.name;
      if (s.year)     $('#me-year').value     = s.year;
      if (s.location) $('#me-location').value = s.location;
      if (s.tags)     $('#me-tags').value     = Array.isArray(s.tags) ? s.tags.join(', ') : s.tags;
      if (s.notes)    $('#me-notes').value    = s.notes;
      me.innerHTML = `gemini filled the fields. Review then click <b>save</b>. <span class="muted">(${j._engine || 'gemini'})</span>`;
    } catch (err) {
      me.textContent = 'gemini error: ' + err;
    }
  };
  $('#me-save').onclick = async () => {
    const body = {
      id,
      name:     $('#me-name').value.trim(),
      year:     $('#me-year').value.trim(),
      location: $('#me-location').value.trim(),
      tags:     $('#me-tags').value.trim(),
      notes:    $('#me-notes').value.trim(),
    };
    try {
      const r = await api('/api/album_meta', {method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
      me.textContent = `saved ✓  (history ${r.history_len})`;
      toast('metadata saved');
      await refreshStats();
      // refresh grid view so the new display_name shows on the tile, but
      // keep the drawer open
      if (viewKind === 'albums') await renderAlbums();
    } catch (err) {
      me.textContent = 'save error: ' + err;
    }
  };
  $('#me-reset').onclick = () => {
    if (!confirm('Clear all metadata for this album?')) return;
    $('#me-name').value = ''; $('#me-year').value = '';
    $('#me-location').value = ''; $('#me-tags').value = '';
    $('#me-notes').value = '';
    $('#me-save').click();
  };
}

async function openDrawerGroup(ids) {
  drawerAlbumId = '__group__';
  const tok = ++drawerToken;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').classList.add('show');
  $('#drawer-body').innerHTML = '<div class="muted" style="padding:8px">loading group candidates ...</div>';
  let data;
  try {
    const qs = ids.map(id => 'id=' + encodeURIComponent(id)).join('&') + '&k=15';
    const r = await fetch('/api/group_candidates?' + qs);
    if (!r.ok) throw new Error('http ' + r.status);
    data = await r.json();
  } catch (err) {
    if (tok === drawerToken) $('#drawer-body').innerHTML = `<div class="muted">error: ${escapeHtml(String(err))}</div>`;
    return;
  }
  if (tok !== drawerToken) return;
  // need covers for each selected album — use the cached albumsCache (grid view)
  const idToCover = {};
  for (const a of (albumsCache || [])) idToCover[a.id] = a.cover;
  const heroCovers = ids.slice(0, 6).map(id =>
    `<div class="cov-mini" style="background-image:url('${thumbURL(idToCover[id] || '')}')" title="${escapeHtml(id)}"></div>`).join('');
  const cands = data.candidates || [];
  const html = `
    <div class="drawer-hero group-hero">
      <div class="group-covers">${heroCovers}${ids.length > 6 ? `<div class="cov-mini more">+${ids.length-6}</div>` : ''}</div>
      <div>
        <div class="h-name">${ids.length} albums selected</div>
        <div class="h-sub">candidates ranked by cosine to <b>mean(of all ${ids.length} albums' means)</b></div>
        <div class="h-btns">
          <button class="merge-all" id="grp-merge-all">merge these ${ids.length} into one</button>
          <button class="open-btn" id="grp-clear">clear selection</button>
        </div>
      </div>
    </div>
    <div class="section-h">most similar albums to the aggregate (${cands.length})</div>
    <div id="drawer-merges">${
      cands.length === 0
        ? '<div class="muted" style="padding:6px 4px;font-size:11px">none found</div>'
        : cands.map(r => {
            const pillCls = r.cos >= 0.95 ? 'high' : (r.cos >= 0.85 ? '' : 'warn');
            return `<div class="cand" data-other="${escapeHtml(r.id)}">
              <div class="cov" style="background-image:url('${thumbURL(r.cover)}')"></div>
              <div class="info">
                <div class="name" title="${escapeHtml(r.id)}">${escapeHtml(r.id.split('/').slice(-1)[0])}</div>
                <div class="sub muted">${escapeHtml(r.id.split('/').slice(0, -1).join('/'))}</div>
                <div class="sub"><span class="score-pill ${pillCls}">cosine</span> cos ${r.cos.toFixed(3)} · ${r.n} photos</div>
                <div class="row-btns">
                  <button class="apply" title="merge into the ${ids.length}-album batch">add to batch</button>
                  <button class="apply primary" title="merge this + all ${ids.length} into one now">merge all now</button>
                  <button class="open">open</button>
                </div>
              </div>
            </div>`;
          }).join('')
    }</div>`;
  $('#drawer-body').innerHTML = html;
  $('#grp-merge-all').onclick = async () => {
    const targetEvent = ids[0].split('/').slice(0, -1).join('/');
    if (!confirm(`Merge ${ids.length} albums into event:\n  ${targetEvent}\n\nPhotos go to <target_event>/<their_camera>. Cameras stay as separate sub-albums.`)) return;
    const r = await api('/api/merge', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({album_ids: ids})});
    toast(mergeToastMsg(r));
    selected.clear(); closeDrawer();
    await refreshStats(); await renderAlbums();
  };
  $('#grp-clear').onclick = () => {
    selected.clear(); closeDrawer();
    for (const node of $$('.album')) node.classList.remove('selected');
    syncHeaderButtons();
  };
  $$('#drawer-merges .cand').forEach(c => {
    const otherId = c.dataset.other;
    c.querySelector('.open').onclick = () => { closeDrawer(); navigate('#/album/' + encodeURIComponent(otherId)); };
    c.querySelectorAll('.apply')[0].onclick = () => {
      // "add to batch": include this in the selection, refresh drawer against new aggregate
      selected.add(otherId);
      for (const node of $$('.album')) node.classList.toggle('selected', selected.has(node.dataset.id));
      syncHeaderButtons();
      openDrawerGroup(Array.from(selected));
    };
    c.querySelectorAll('.apply')[1].onclick = async () => {
      const full = ids.concat([otherId]);
      const r = await api('/api/merge', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({album_ids: full})});
      toast(mergeToastMsg(r));
      selected.clear(); closeDrawer();
      await refreshStats(); await renderAlbums();
    };
  });
}

function syncHeaderButtons() {
  const n = selected.size;
  $('#btn-merge').textContent = `merge (${n})`;
  $('#btn-merge').disabled = viewKind !== 'albums' || n < 2;
  if (viewKind === 'albums') {
    $('#btn-flag').textContent = n > 0 ? `flag (${n} albums)` : 'flag';
    $('#btn-flag').disabled = n === 0;
  } else if (viewKind === 'album') {
    const m = selectedPhotos.size;
    $('#btn-flag').textContent = m > 0 ? `flag (${m})` : 'flag';
    $('#btn-flag').disabled = m === 0;
  } else {
    $('#btn-flag').disabled = true;
    $('#btn-flag').textContent = 'flag';
  }
}

// ── Album detail view ────────────────────────────────────────
async function openAlbum(id) {
  viewKind = 'album';
  currentAlbumId = id;
  cutoffPath = null;             // legacy field, unused in the new layout
  selectedPhotos.clear();
  lastPhotoClick = null;
  focusedPhotoIdx = -1; photoRangeAnchorIdx = -1;
  hintMode = null; hintPaths.clear(); hintCutPath = null;
  const titleBits = [];
  const meta = albumDetailCache?.meta || {};
  $('#crumbs').innerHTML = `· <a href="#/">all albums</a> · ${escapeHtml(id)}`;
  $('#btn-merge').disabled = true;
  syncHeaderButtons();
  root.innerHTML = '<div class="muted" style="padding:20px">loading...</div>';
  const data = await api('/api/album?id=' + encodeURIComponent(id));
  albumDetailCache = data;
  render_album_detail();
}

function render_album_detail() {
  const d = albumDetailCache;
  if (!d) return;

  const wrap = document.createElement('div');
  wrap.className = 'album-layout-right';

  const merges = (d.merge_suggestions || []);
  const splits = (d.split_suggestions || []);
  const meta   = d.meta || {};

  // ── seed hint from top split suggestion (visual only) ──
  hintMode = null; hintPaths.clear(); hintCutPath = null;
  const topSplit = splits[0];
  if (topSplit) {
    hintMode = topSplit.mode || 'contiguous';
    for (const p of (topSplit.highlight_paths || [])) hintPaths.add(p);
    if (hintMode === 'contiguous') {
      hintCutPath = topSplit.cut_after_path;
      hintSide    = topSplit.side || 'after';
    }
  }

  // ── main: top action bar + photo grid ──
  const main = document.createElement('div');
  main.className = 'album-main';
  const titleLine = meta.name
    ? `<b>${escapeHtml(meta.name)}</b> <span class="muted" style="font-weight:400">· ${escapeHtml(d.id)}</span>`
    : escapeHtml(d.id);
  const hintLine = hintMode
    ? `<div class="hint-banner hint-${hintMode}">${hintMode === 'subset' ? '◇ ' + hintPaths.size + ' non-contiguous outlier photos hinted' : '▶ contiguous run of ' + hintPaths.size + ' photos hinted'} — press <b>y</b> to accept</div>`
    : '';
  main.innerHTML = `
    <div class="album-actionbar" id="album-actionbar">
      <div class="ab-info">
        <div class="ab-title">${titleLine}</div>
        <div class="ab-sub muted">${d.n} photos${d.n_flagged ? ` · ✕ ${d.n_flagged} flagged` : ''} · click select · shift=range · ctrl=toggle · arrows+space navigate · <b>s</b>=split · <b>Del</b>=flag for deletion</div>
      </div>
      <div class="ab-actions">
        <span id="ab-selcount" class="muted">0 selected</span>
        <button id="ab-split"  class="primary" disabled>split selected</button>
        <button id="ab-delete" class="danger"  disabled>flag for deletion</button>
        <button id="ab-clear"  disabled>clear</button>
      </div>
    </div>
    ${hintLine}
  `;

  const gaps = [];
  for (let i = 1; i < d.images.length; i++) {
    const a = parseDate(d.images[i-1].d), b = parseDate(d.images[i].d);
    gaps.push((a && b) ? (b - a) / 3.6e6 : null);
  }
  const grid = document.createElement('div');
  grid.className = 'photos';
  d.images.forEach((im, i) => {
    const el = document.createElement('div');
    el.className = 'photo' + (im.f ? ' flagged' : '');
    el.dataset.path = im.p;
    el.style.backgroundImage = `url('${thumbURL(im.p)}')`;
    let inner = `<div class="date"><span>${fmtDate(im.d) || '?'}</span></div>`;
    if (i > 0 && gaps[i-1] != null && gaps[i-1] >= 2) {
      inner += `<div class="gap">↑ +${formatGap(gaps[i-1])}</div>`;
    }
    el.innerHTML = inner;
    el.addEventListener('click', (e) => onPhotoClick(e, im.p));
    grid.appendChild(el);
  });
  main.appendChild(grid);

  // ── right sidebar: similar albums + (contextual) similar photos + split hints ──
  const side = document.createElement('aside');
  side.className = 'sidebar-right';
  side.innerHTML = `
    <div class="side-section">
      <div class="section-h">similar albums (for merging)</div>
      <div id="side-merges"></div>
    </div>
    <div class="side-section" id="photo-side">
      <div class="section-h" id="side-photo-h">similar photos</div>
      <div id="side-photo-meta" class="muted" style="font-size:11px; padding:2px 4px">click a photo for cross-archive neighbors; select several for averaged neighbors</div>
      <div id="side-photo-neighbors"></div>
    </div>
    ${splits.length ? `<div class="side-section">
      <div class="section-h">split suggestions (${splits.length})</div>
      <div id="side-splits"></div>
    </div>` : ''}
  `;

  wrap.appendChild(main);
  wrap.appendChild(side);
  root.innerHTML = '';
  root.appendChild(wrap);

  // wire action bar
  $('#ab-split').onclick  = () => doSplitSelected();
  $('#ab-delete').onclick = () => doFlagSelected();
  $('#ab-clear').onclick  = () => { selectedPhotos.clear(); lastPhotoClick = null;
                                    rerender_photos(); fetchSimilarForSelection(); };

  // populate sidebar candidates — same dual-source pattern as the drawer
  const sm = $('#side-merges');
  const nearest = d.nearest_albums || [];
  const sSeen = new Set();
  const sRows = [];
  for (const s of merges) {
    const other = s.a === d.id ? s.b : s.a;
    if (sSeen.has(other)) continue;
    sSeen.add(other);
    sRows.push({ src:'ranked', other,
      cover: (s.a === d.id ? s.b_meta?.cover : s.a_meta?.cover) || '',
      cos: s.cos, gap_days: s.gap_days });
  }
  for (const n of nearest) {
    if (sSeen.has(n.id)) continue;
    sSeen.add(n.id);
    sRows.push({ src:'cosine', other: n.id, cover: n.cover, cos: n.cos });
  }
  if (sRows.length === 0) {
    sm.innerHTML = '<div class="muted" style="padding:6px 4px;font-size:11px">no comparable albums</div>';
  } else {
    sm.innerHTML = sRows.slice(0, 10).map(r => {
      const pillCls = r.cos >= 0.95 ? 'high' : (r.cos >= 0.85 ? '' : 'warn');
      const sub = r.src === 'ranked'
        ? `cos ${r.cos.toFixed(2)} · gap ${r.gap_days.toFixed(1)} d`
        : `cos ${r.cos.toFixed(2)} <span style="font-size:9px;opacity:.7">(fallback)</span>`;
      return `<div class="cand" data-other="${escapeHtml(r.other)}">
        <div class="cov" style="background-image:url('${thumbURL(r.cover)}')"></div>
        <div class="info">
          <div class="name" title="${escapeHtml(r.other)}">${escapeHtml(r.other.split('/').slice(-1)[0])}</div>
          <div class="sub muted"><span class="score-pill ${pillCls}">${r.src}</span> ${sub}</div>
          <div class="row-btns">
            <button class="apply">merge</button>
            <button class="open">open</button>
          </div>
        </div>
      </div>`;
    }).join('');
    sm.querySelectorAll('.cand').forEach(c => {
      c.querySelector('.open').onclick = () => navigate('#/album/' + encodeURIComponent(c.dataset.other));
      c.querySelector('.apply').onclick = async () => {
        const r = await api('/api/merge', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({album_ids: [d.id, c.dataset.other]})
        });
        toast(mergeToastMsg(r));
        await refreshStats();
        await openAlbum(d.id);
      };
    });
  }

  const ss = $('#side-splits');
  if (ss) {
    ss.innerHTML = splits.slice(0, 5).map((s, i) => {
      const mode = s.mode || 'contiguous';
      const sub = (mode === 'subset')
        ? `cohesion ${s.cohesion.toFixed(2)} · sep ${s.separation.toFixed(2)} · ${s.runs} runs`
        : `gap ${s.gap_hours.toFixed(1)}h · halves cos ${s.cross_cos.toFixed(2)}`;
      const detail = (mode === 'subset')
        ? `${s.n_highlight} outlier photos scattered across album`
        : `cut after ${escapeHtml(basename(s.cut_after_path))} (smaller side: ${s.side}, ${s.n_highlight} photos)`;
      return `<div class="cand-split mode-${mode}" data-idx="${i}">
        <div class="sub">
          <span class="score-pill ${s.score >= 0.55 ? 'high' : 'warn'}">${mode} ${s.score.toFixed(2)}</span>
          <span class="muted">${sub}</span>
        </div>
        <div class="sub muted" style="font-size:10px">${detail}</div>
        <div class="cand-split-btns">
          <button class="apply">apply hint</button>
          ${mode === 'contiguous' ? '<button class="jump">scroll to cut</button>' : '<button class="jump">scroll to first</button>'}
        </div>
      </div>`;
    }).join('');
    ss.querySelectorAll('.cand-split').forEach(c => {
      const s = splits[+c.dataset.idx];
      const mode = s.mode || 'contiguous';
      c.querySelector('.apply').onclick = () => {
        selectedPhotos.clear();
        for (const p of (s.highlight_paths || [])) selectedPhotos.add(p);
        rerender_photos();
        fetchSimilarForSelection();
      };
      c.querySelector('.jump').onclick = () => {
        const tgt = (mode === 'subset') ? (s.highlight_paths && s.highlight_paths[0]) : s.cut_after_path;
        if (!tgt) return;
        const node = root.querySelector(`[data-path="${cssEscape(tgt)}"]`);
        if (node) node.scrollIntoView({ block:'center', behavior:'smooth' });
      };
    });
  }

  rerender_photos();
}

function onPhotoClick(e, path) {
  const d = albumDetailCache;
  if (!d) return;
  const paths = d.images.map(im => im.p);
  if (e.shiftKey && lastPhotoClick) {
    // range-select between last clicked and this one (adds to selection)
    const a = paths.indexOf(lastPhotoClick);
    const b = paths.indexOf(path);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selectedPhotos.add(paths[i]);
    }
  } else if (e.metaKey || e.ctrlKey) {
    // toggle individual photo
    if (selectedPhotos.has(path)) selectedPhotos.delete(path);
    else selectedPhotos.add(path);
  } else {
    // plain click: toggle single photo (clicking the highlighted one clears it)
    if (selectedPhotos.has(path) && selectedPhotos.size === 1) {
      selectedPhotos.clear();
    } else {
      selectedPhotos.clear();
      selectedPhotos.add(path);
    }
  }
  lastPhotoClick = path;
  rerender_photos();
  fetchSimilarForSelection();
}

async function fetchSimilarForSelection() {
  const meta = $('#side-photo-meta');
  const list = $('#side-photo-neighbors');
  const head = $('#side-photo-h');
  if (!meta || !list) return;
  const n = selectedPhotos.size;
  if (n === 0) {
    head.textContent = 'similar photos';
    meta.innerHTML = '<span class="muted">click a photo for cross-archive neighbors; select several for averaged neighbors</span>';
    list.innerHTML = '';
    return;
  }
  const tok = ++neighborToken;
  head.textContent = n === 1 ? 'similar photos elsewhere' : `similar to avg of ${n} selected`;
  meta.textContent = 'loading...';
  list.innerHTML = '';
  let r;
  try {
    if (n === 1) {
      const p = [...selectedPhotos][0];
      r = await (await fetch('/api/photo_neighbors?k=12&p=' + encodeURIComponent(p))).json();
    } else {
      r = await (await fetch('/api/photo_group_neighbors', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({paths: [...selectedPhotos], k: 12})
      })).json();
    }
  } catch (err) {
    if (tok === neighborToken) meta.textContent = 'fetch failed';
    return;
  }
  if (tok !== neighborToken) return;
  meta.innerHTML = `<span class="muted">${r.neighbors.length} cross-album matches by mean(CLIP) cosine</span>`;
  list.innerHTML = r.neighbors.map(nb => `
    <div class="cand-photo" data-path="${escapeHtml(nb.p)}" data-album="${escapeHtml(nb.a)}">
      <div class="cov" style="background-image:url('${thumbURL(nb.p)}')"></div>
      <div class="info">
        <div class="name" title="${escapeHtml(nb.a)}">${escapeHtml(nb.a.split('/').slice(-1)[0])}</div>
        <div class="sub muted">cos ${nb.cos.toFixed(3)}${nb.f ? ' · <span style="color:#f66">flagged</span>' : ''}</div>
        <div class="sub muted" style="font-size:10px">${escapeHtml(nb.a.split('/').slice(0, -1).join('/')) || ''}</div>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.cand-photo').forEach(c => {
    c.onclick = () => navigate('#/album/' + encodeURIComponent(c.dataset.album));
  });
}

async function doSplitSelected() {
  if (viewKind !== 'album' || selectedPhotos.size === 0) return;
  if (selectedPhotos.size >= (albumDetailCache?.n || 0)) {
    toast('cannot split — would empty the source album', 3000); return;
  }
  const res = await api('/api/split', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({album_id: currentAlbumId, move_paths: [...selectedPhotos]}),
  });
  toast(`split: ${res.n_moved} → ${res.new_album}`);
  selectedPhotos.clear();
  await refreshStats();
  await openAlbum(currentAlbumId);
}

async function doFlagSelected() {
  if (viewKind !== 'album' || selectedPhotos.size === 0) return;
  const r = await api('/api/flag', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({paths: [...selectedPhotos], flag: true}),
  });
  toast(`flagged ${r.n_changed} for deletion (${r.now_flagged} total)`);
  selectedPhotos.clear();
  await refreshStats();
  await openAlbum(currentAlbumId);
}

async function fetchPhotoNeighbors(path) {
  if (!path) return;
  const tok = ++neighborToken;
  const meta = $('#side-photo-meta');
  const list = $('#side-photo-neighbors');
  if (!meta || !list) return;
  meta.textContent = 'loading neighbors ...';
  list.innerHTML = '';
  let r;
  try {
    r = await fetch('/api/photo_neighbors?k=12&p=' + encodeURIComponent(path));
    if (!r.ok) throw new Error('http ' + r.status);
    r = await r.json();
  } catch (err) {
    if (tok === neighborToken) meta.textContent = 'neighbors fetch failed';
    return;
  }
  if (tok !== neighborToken) return;        // a newer click already fired
  meta.innerHTML = `<span class="muted">queried <code>${escapeHtml(basename(path))}</code> · top ${r.neighbors.length} cross-album matches</span>`;
  list.innerHTML = r.neighbors.map(n => `
    <div class="cand-photo" data-path="${escapeHtml(n.p)}" data-album="${escapeHtml(n.a)}">
      <div class="cov" style="background-image:url('${thumbURL(n.p)}')"></div>
      <div class="info">
        <div class="name" title="${escapeHtml(n.a)}">${escapeHtml(n.a.split('/').slice(-1)[0])}</div>
        <div class="sub muted">cos ${n.cos.toFixed(3)}${n.f ? ' · <span style="color:#f66">flagged</span>' : ''}</div>
        <div class="sub muted" style="font-size:10px">${escapeHtml(n.a.split('/').slice(0, -1).join('/')) || ''}</div>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.cand-photo').forEach(c => {
    c.onclick = () => navigate('#/album/' + encodeURIComponent(c.dataset.album));
  });
}

function rerender_photos() {
  const d = albumDetailCache;
  if (!d) return;
  const n = selectedPhotos.size;
  const showHint = n === 0 && hintMode;
  $$('.photo', root).forEach((node) => {
    node.classList.remove('subset-pick', 'hint-contiguous', 'hint-subset');
    if (n > 0) {
      if (selectedPhotos.has(node.dataset.path)) node.classList.add('subset-pick');
    } else if (showHint && hintPaths.has(node.dataset.path)) {
      node.classList.add(hintMode === 'subset' ? 'hint-subset' : 'hint-contiguous');
    }
  });

  // action bar
  const cnt = $('#ab-selcount'), sp = $('#ab-split'), dl = $('#ab-delete'), cl = $('#ab-clear');
  if (cnt && sp && dl && cl) {
    cnt.textContent = `${n} selected`;
    const canSplit = n > 0 && n < d.images.length;
    sp.disabled = !canSplit;
    sp.textContent = canSplit ? `split out ${n} → new album` : 'split selected';
    dl.disabled = n === 0;
    dl.textContent = n === 0 ? 'flag for deletion' : `flag ${n} for deletion`;
    cl.disabled = n === 0;
    cnt.classList.toggle('active', n > 0);
  }

  // also keep the global header buttons in sync for the keyboard shortcuts
  const split = $('#btn-split');
  if (split) {
    split.disabled = !(n > 0 && n < d.images.length);
    split.textContent = n > 0 ? `split (${n})` : 'split';
  }
  syncHeaderButtons();
}

// ── Suggestions panel ────────────────────────────────────────
async function renderSuggestions() {
  viewKind = 'suggestions';
  $('#crumbs').innerHTML = `· <a href="#/">all albums</a> · suggestions`;
  $('#btn-merge').disabled = true;
  $('#btn-split').disabled = true;
  $('#btn-flag').disabled = true;
  root.innerHTML = '<div class="muted" style="padding:20px">loading suggestions ...</div>';
  const data = await api('/api/suggestions');

  const tabs = `
    <div class="tabs">
      <div class="tab ${sugView === 'merge' ? 'active' : ''}" data-t="merge">merge<span class="count">${data.merge.length}</span></div>
      <div class="tab ${sugView === 'split' ? 'active' : ''}" data-t="split">split<span class="count">${data.split.length}</span></div>
      <span class="muted" style="margin-left:auto; font-size:11px">built ${data.built_at || '—'}</span>
    </div>`;
  root.innerHTML = tabs;
  root.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => { sugView = t.dataset.t; renderSuggestions(); };
  });

  const container = document.createElement('div');
  if (sugView === 'merge') {
    for (const s of data.merge.slice(0, 100)) {
      const card = document.createElement('div'); card.className = 'sug-card';
      card.innerHTML = `
        <div style="margin-bottom:6px">
          <span class="score-pill ${s.score >= 1.0 ? 'high' : (s.score >= 0.85 ? '' : 'warn')}">score ${s.score.toFixed(2)}</span>
          <span class="muted">cos ${s.cos.toFixed(2)} · gap ${s.gap_days.toFixed(1)} d ${s.same_event ? '· same event' : ''}${s.token_overlap > 0.4 ? ` · tok ${s.token_overlap.toFixed(2)}` : ''}</span>
        </div>
        <div class="row">
          <div class="sug-mini">
            <div class="cov" style="background-image:url('${thumbURL(s.a_meta.cover)}')"></div>
            <div class="name">${escapeHtml(s.a)}</div>
            <div class="sub">${s.a_meta.n} img · ${fmtDate(s.a_meta.date_min)}</div>
          </div>
          <div class="sug-actions">
            <button class="open" data-id="${escapeHtml(s.a)}">open A</button>
            <button class="primary apply">merge →</button>
            <button class="open" data-id="${escapeHtml(s.b)}">open B</button>
          </div>
          <div class="sug-mini">
            <div class="cov" style="background-image:url('${thumbURL(s.b_meta.cover)}')"></div>
            <div class="name">${escapeHtml(s.b)}</div>
            <div class="sub">${s.b_meta.n} img · ${fmtDate(s.b_meta.date_min)}</div>
          </div>
        </div>`;
      card.querySelectorAll('.open').forEach(b => b.onclick = () => navigate('#/album/' + encodeURIComponent(b.dataset.id)));
      card.querySelector('.apply').onclick = async () => {
        const r = await api('/api/merge', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({album_ids: [s.a, s.b]})});
        toast(mergeToastMsg(r));
        await refreshStats();
        renderSuggestions();
      };
      container.appendChild(card);
    }
  } else {
    for (const s of data.split.slice(0, 100)) {
      const card = document.createElement('div'); card.className = 'sug-card';
      card.innerHTML = `
        <div style="margin-bottom:6px">
          <span class="score-pill ${s.score >= 0.55 ? 'high' : 'warn'}">score ${s.score.toFixed(2)}</span>
          <span class="muted">${s.n} img · gap ${s.gap_hours.toFixed(1)} h · halves cos ${s.cross_cos.toFixed(2)} · L=${s.left_n} R=${s.right_n}</span>
        </div>
        <div style="margin-bottom:8px">
          <a href="#/album/${encodeURIComponent(s.album)}" class="open">${escapeHtml(s.album)}</a>
          <div class="muted" style="font-size:11px">cut after <code>${escapeHtml(basename(s.cut_after_path))}</code>
            (${fmtDate(s.cut_after_date)} → ${fmtDate(s.next_date)})</div>
        </div>
        <div class="row">
          <div class="sug-mini" style="flex:0 0 220px;">
            <div class="cov" style="background-image:url('${thumbURL(s.album_meta.cover)}')"></div>
          </div>
          <div class="sug-actions">
            <button class="primary apply">jump &amp; split</button>
          </div>
        </div>`;
      card.querySelector('.apply').onclick = async () => {
        await navigate('#/album/' + encodeURIComponent(s.album));
        // Highlight all paths on the suggested side as the subset selection.
        selectedPhotos.clear();
        for (const p of (s.highlight_paths || [])) selectedPhotos.add(p);
        rerender_photos();
        fetchSimilarForSelection();
        const first = (s.highlight_paths || [])[0];
        if (first) {
          const node = root.querySelector(`[data-path="${cssEscape(first)}"]`);
          if (node) node.scrollIntoView({ block:'center', behavior:'smooth' });
        }
      };
      container.appendChild(card);
    }
  }
  root.appendChild(container);
}

// ── Flagged-review view ──────────────────────────────────────
async function renderFlagged() {
  viewKind = 'flagged';
  $('#crumbs').innerHTML = `· <a href="#/">all albums</a> · flagged for deletion`;
  $('#btn-merge').disabled = true;
  $('#btn-split').disabled = true;
  $('#btn-flag').disabled = true;
  root.innerHTML = '<div class="muted" style="padding:20px">loading flagged...</div>';
  const data = await api('/api/flagged');
  root.innerHTML = `<div class="section-h">${data.n} flagged images · click ✕ to unflag</div>`;
  const grid = document.createElement('div');
  grid.className = 'photos';
  for (const im of data.flagged) {
    const el = document.createElement('div');
    el.className = 'photo flagged';
    el.dataset.path = im.p;
    el.style.backgroundImage = `url('${thumbURL(im.p)}')`;
    el.innerHTML = `<div class="date"><span title="${escapeHtml(im.a)}">${escapeHtml(im.a.split('/').slice(-1)[0])}</span></div>
                    <button class="unflag" title="unflag">✕</button>`;
    el.querySelector('.unflag').onclick = async (e) => {
      e.stopPropagation();
      await api('/api/flag', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({paths: [im.p], flag: false})});
      await refreshStats();
      renderFlagged();
    };
    el.addEventListener('click', () => navigate('#/album/' + encodeURIComponent(im.a)));
    grid.appendChild(el);
  }
  root.appendChild(grid);
}

// ── Header actions ───────────────────────────────────────────
$('#search').addEventListener('input', () => {
  currentSearch = $('#search').value;
  if (viewKind === 'albums') renderAlbums();
});

$('#btn-suggestions').onclick = () => {
  // In album view: open the per-album right drawer (or group drawer) for the
  // currently-active selection. Otherwise: go to the global suggestions queue.
  if (viewKind === 'albums') {
    if (selected.size >= 2)      return openDrawerGroup(Array.from(selected));
    if (lastAlbumClick)          return openDrawer(lastAlbumClick);
    if (selected.size === 1)     return openDrawer([...selected][0]);
  }
  navigate('#/suggestions');
};

$('#btn-merge').onclick = async () => {
  if (selected.size < 2) return;
  const ids = Array.from(selected);
  const targetEvent = ids[0].split('/').slice(0, -1).join('/');
  const ok = confirm(`Merge ${ids.length} albums into event:\n  ${targetEvent}\n\nEach photo moves to <target_event>/<its_camera>.\nSame-camera photos collapse; different-camera photos stay as separate camera sub-albums under this event.`);
  if (!ok) return;
  const res = await api('/api/merge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ album_ids: ids }),
  });
  toast(mergeToastMsg(res));
  selected.clear();
  await refreshStats();
  await renderAlbums();
};

function mergeToastMsg(res) {
  // Event-merge with camera preserved.
  const moved = res.n_moved_total ?? 0;
  const results = res.results || [];
  if (moved === 0) return 'nothing to merge (all photos already in the target event)';
  if (results.length === 1) {
    const r = results[0];
    return `merged ${r.n_moved} → "${r.new_album.split('/').slice(-1)[0]}" (under ${res.target_event})`;
  }
  const camCount = new Set(results.map(r => r.new_album.split('/').slice(-1)[0])).size;
  return `merged ${moved} images into event "${res.target_event}" across ${camCount} camera${camCount===1?'':'s'}`;
}

$('#btn-split').onclick = () => doSplitSelected();

$('#btn-flag').onclick = async () => {
  let body;
  if (viewKind === 'albums' && selected.size > 0) {
    body = { album_ids: Array.from(selected), flag: true };
  } else if (viewKind === 'album' && selectedPhotos.size > 0) {
    body = { paths: Array.from(selectedPhotos), flag: true };
  } else return;
  const r = await api('/api/flag', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body) });
  toast(`flagged ${r.n_changed} for deletion (${r.now_flagged} total)`);
  selected.clear(); selectedPhotos.clear();
  await refreshStats();
  if (viewKind === 'album') openAlbum(currentAlbumId);
  else renderAlbums();
};

$('#btn-undo').onclick = async () => {
  const r = await api('/api/undo', { method: 'POST' });
  toast(`undid ${r.undone}`);
  selected.clear(); selectedPhotos.clear(); cutoffPath = null;
  await refreshStats();
  route();
};

$('#btn-export').onclick = () => { window.location = '/api/export'; };

// ── lightbox / modal ──────────────────────────────────────
function showLightbox(html, isHelp=false) {
  $('#lb-body').innerHTML = html;
  $('#lb-body').classList.toggle('help-modal', !!isHelp);
  $('#lightbox').hidden = false;
}
function hideLightbox() { $('#lightbox').hidden = true; }
$('.lb-close').onclick   = hideLightbox;
$('.lb-backdrop').onclick = hideLightbox;

function showAlbumCollage(id) {
  const url = '/api/album_collage?id=' + encodeURIComponent(id);
  showLightbox(
    `<div>
       <img src="${url}" alt="${escapeHtml(id)}">
       <div class="lb-meta">${escapeHtml(id)} — 4×4 representative collage</div>
     </div>`
  );
}

function showPhotoMagnified(path, im) {
  showLightbox(
    `<div>
       <img src="${thumbURL(path)}" alt="">
       <div class="lb-meta">${escapeHtml(basename(path))}${im && im.d ? ' · ' + escapeHtml(im.d) : ''}</div>
     </div>`
  );
}

function showHelp() {
  showLightbox(`
    <h3>image_bench — keyboard shortcuts</h3>
    <h4>Album grid</h4>
    <table>
      <tr><td class="k">↑ ↓ ← →</td><td>move focus (blue ring)</td></tr>
      <tr><td class="k">Shift+arrow</td><td>extend selection from anchor</td></tr>
      <tr><td class="k">Space</td><td>toggle selection of focused album</td></tr>
      <tr><td class="k">Enter</td><td>open focused album</td></tr>
      <tr><td class="k">Click</td><td>toggle selection</td></tr>
      <tr><td class="k">Shift+Click</td><td>range select</td></tr>
      <tr><td class="k">Ctrl/Cmd+Click</td><td>toggle individual</td></tr>
      <tr><td class="k">Double-click</td><td>open album detail</td></tr>
      <tr><td class="k">Q</td><td>show collage of focused album</td></tr>
      <tr><td class="k">M</td><td>merge selected (≥ 2)</td></tr>
      <tr><td class="k">Del · ⌫ · D</td><td>flag selected for deletion</td></tr>
      <tr><td class="k">T</td><td>toggle tagger panel</td></tr>
    </table>
    <h4>Photo grid (inside an album)</h4>
    <table>
      <tr><td class="k">↑ ↓ ← →</td><td>move focus</td></tr>
      <tr><td class="k">Shift+arrow</td><td>extend selection</td></tr>
      <tr><td class="k">Space</td><td>toggle selection of focused photo</td></tr>
      <tr><td class="k">Click</td><td>select single (or clear)</td></tr>
      <tr><td class="k">Shift+Click</td><td>range select</td></tr>
      <tr><td class="k">Ctrl/Cmd+Click</td><td>toggle individual</td></tr>
      <tr><td class="k">Q</td><td>magnify focused photo</td></tr>
      <tr><td class="k">S</td><td>split selected photos into new album</td></tr>
      <tr><td class="k">Del · ⌫ · D</td><td>flag selected for deletion</td></tr>
      <tr><td class="k">Y</td><td>accept split hint as selection</td></tr>
    </table>
    <h4>Global</h4>
    <table>
      <tr><td class="k">⌘/Ctrl + Z</td><td>undo last action</td></tr>
      <tr><td class="k">T</td><td>toggle tagger panel</td></tr>
      <tr><td class="k">?</td><td>show this help</td></tr>
      <tr><td class="k">Esc</td><td>close panel / clear selection / go home</td></tr>
      <tr><td class="k">☢ button</td><td>wipe ALL edits (typed confirm)</td></tr>
    </table>
  `, true);
}

$('#btn-help').onclick = showHelp;

// hide-deleted toggle (filters the album grid for albums where every photo is flagged)
$('#btn-hide-deleted').onclick = () => {
  hideDeleted = !hideDeleted;
  $('#btn-hide-deleted').textContent = hideDeleted ? 'show deleted' : 'hide deleted';
  $('#btn-hide-deleted').classList.toggle('active', hideDeleted);
  if (viewKind === 'albums') renderAlbums();
};

// tagger panel toggle
$('#btn-tagger').onclick = () => {
  const willOpen = !$('#tagger-panel').classList.contains('open');
  // when opening, load the currently-active album so the form is filled in
  if (willOpen) {
    const active = lastAlbumClick
      || (selected.size === 1 ? [...selected][0] : null)
      || currentAlbumId;
    if (active) loadTaggerForAlbum(active);
  }
  toggleTagger(willOpen);
};
$('#tp-close').onclick   = () => toggleTagger(false);

$('#btn-nuke').onclick = async () => {
  const s = await api('/api/stats').catch(() => null);
  const summary = s
    ? `${s.n_overrides} edits · ${s.n_history} history actions · ${s.n_flagged} flagged`
    : '(stats unavailable)';
  const msg = `☢  WIPE ALL EDITS  ☢\n\nThis will permanently clear:\n  • all merge/split overrides\n  • full undo history\n  • all deletion flags\n  • all album metadata you've set\n\nCurrent state: ${summary}\n\nstate.json is auto-backed up to state.backup.<timestamp>.json first.\n\nTo confirm, type exactly:  NUKE`;
  const input = prompt(msg);
  if (input !== 'NUKE') { toast('reset cancelled'); return; }
  const r = await api('/api/reset', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({confirm: 'YES'})});
  toast(`reset done — cleared ${r.cleared.overrides} overrides, ${r.cleared.history} actions, ${r.cleared.flagged} flags`, 4500);
  selected.clear(); selectedPhotos.clear();
  await refreshStats();
  route();
};

// drawer dismissal
$('#drawer-close').onclick = closeDrawer;
$('#drawer-scrim').onclick = closeDrawer;

function colsInGrid(gridEl) {
  if (!gridEl) return 1;
  const cs = window.getComputedStyle(gridEl);
  const tracks = cs.gridTemplateColumns.split(/\s+/).filter(Boolean);
  return Math.max(1, tracks.length);
}

function paintFocus(selector, idx) {
  $$(selector).forEach((el, i) => el.classList.toggle('focused', i === idx));
  if (idx >= 0) {
    const el = $$(selector)[idx];
    if (el) el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }
}

function handleAlbumKeys(e) {
  if (!albumsCache || albumsCache.length === 0) return false;
  const grid = $('.grid');
  if (!grid) return false;
  const n = albumsCache.length;
  const cols = colsInGrid(grid);

  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();
    let next = focusedAlbumIdx < 0 ? 0 : focusedAlbumIdx;
    if      (e.key === 'ArrowLeft')  next = Math.max(0, next - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, next + 1);
    else if (e.key === 'ArrowUp')    next = Math.max(0, next - cols);
    else if (e.key === 'ArrowDown')  next = Math.min(n - 1, next + cols);
    focusedAlbumIdx = next;
    if (e.shiftKey) {
      // extend selection from anchor (anchor defaults to where focus started)
      if (albumRangeAnchorIdx < 0) albumRangeAnchorIdx = next;
      const [lo, hi] = albumRangeAnchorIdx <= next
        ? [albumRangeAnchorIdx, next] : [next, albumRangeAnchorIdx];
      selected.clear();
      for (let i = lo; i <= hi; i++) selected.add(albumsCache[i].id);
      lastAlbumClick = albumsCache[next].id;
      $$('.album').forEach(el => el.classList.toggle('selected', selected.has(el.dataset.id)));
      syncHeaderButtons();
      // refresh open panels for the active album
      if (document.body.classList.contains('tp-open')) loadTaggerForAlbum(lastAlbumClick);
      if (drawerAlbumId && drawerAlbumId !== '__group__') openDrawer(lastAlbumClick);
    } else if (!e.ctrlKey && !e.metaKey) {
      // plain arrow: move focus only (don't touch selection); reset anchor on next Space
      lastAlbumClick = albumsCache[next].id;
    }
    paintFocus('.album', focusedAlbumIdx);
    return true;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (focusedAlbumIdx < 0) focusedAlbumIdx = 0;
    const id = albumsCache[focusedAlbumIdx].id;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    albumRangeAnchorIdx = focusedAlbumIdx;
    lastAlbumClick = id;
    $$('.album').forEach(el => el.classList.toggle('selected', selected.has(el.dataset.id)));
    syncHeaderButtons();
    if (document.body.classList.contains('tp-open')) loadTaggerForAlbum(id);
    if (drawerAlbumId && drawerAlbumId !== '__group__') openDrawer(id);
    paintFocus('.album', focusedAlbumIdx);
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (focusedAlbumIdx >= 0) {
      navigate('#/album/' + encodeURIComponent(albumsCache[focusedAlbumIdx].id));
    }
    return true;
  }
  return false;
}

function handleAlbumDetailKeys(e) {
  const d = albumDetailCache;
  if (!d || !d.images || d.images.length === 0) return false;
  const grid = $('.photos');
  if (!grid) return false;
  const n = d.images.length;
  const cols = colsInGrid(grid);

  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();
    let next = focusedPhotoIdx < 0 ? 0 : focusedPhotoIdx;
    if      (e.key === 'ArrowLeft')  next = Math.max(0, next - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, next + 1);
    else if (e.key === 'ArrowUp')    next = Math.max(0, next - cols);
    else if (e.key === 'ArrowDown')  next = Math.min(n - 1, next + cols);
    focusedPhotoIdx = next;
    if (e.shiftKey) {
      if (photoRangeAnchorIdx < 0) photoRangeAnchorIdx = next;
      const [lo, hi] = photoRangeAnchorIdx <= next
        ? [photoRangeAnchorIdx, next] : [next, photoRangeAnchorIdx];
      selectedPhotos.clear();
      for (let i = lo; i <= hi; i++) selectedPhotos.add(d.images[i].p);
      lastPhotoClick = d.images[next].p;
      rerender_photos();
      fetchSimilarForSelection();
    }
    paintFocus('.photo', focusedPhotoIdx);
    return true;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (focusedPhotoIdx < 0) focusedPhotoIdx = 0;
    const p = d.images[focusedPhotoIdx].p;
    if (selectedPhotos.has(p)) selectedPhotos.delete(p);
    else selectedPhotos.add(p);
    photoRangeAnchorIdx = focusedPhotoIdx;
    lastPhotoClick = p;
    rerender_photos();
    fetchSimilarForSelection();
    paintFocus('.photo', focusedPhotoIdx);
    return true;
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  // grid navigation first — give it the chance to consume arrow/space/Enter
  if (viewKind === 'albums' && handleAlbumKeys(e)) return;
  if (viewKind === 'album'  && handleAlbumDetailKeys(e)) return;

  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#btn-undo').click(); }
  if (e.key === 'm' && !$('#btn-merge').disabled) $('#btn-merge').click();
  if (e.key === 's' && !$('#btn-split').disabled) $('#btn-split').click();
  if (e.key === 't' && !e.metaKey && !e.ctrlKey)  { e.preventDefault(); $('#btn-tagger').click(); }
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); showHelp(); }
  if (e.key === 'q' || e.key === 'Q') {
    e.preventDefault();
    if (viewKind === 'albums' && albumsCache && focusedAlbumIdx >= 0) {
      showAlbumCollage(albumsCache[focusedAlbumIdx].id);
    } else if (viewKind === 'albums' && lastAlbumClick) {
      showAlbumCollage(lastAlbumClick);
    } else if (viewKind === 'album' && albumDetailCache && focusedPhotoIdx >= 0) {
      const im = albumDetailCache.images[focusedPhotoIdx];
      showPhotoMagnified(im.p, im);
    } else if (viewKind === 'album' && lastPhotoClick) {
      const im = albumDetailCache?.images?.find(x => x.p === lastPhotoClick);
      if (im) showPhotoMagnified(im.p, im);
    }
  }
  // Delete / Backspace / d — flag for deletion.
  // In album view: flag the current subset selection, OR the cutoff photo
  // if there is no subset, OR the single album-grid selection — whichever
  // is active. Same effect on album-grid view (flag selected albums).
  if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'd') {
    if (viewKind === 'album') {
      e.preventDefault();
      if (selectedPhotos.size === 0) return;
      doFlagSelected();
      return;
    }
    if (!$('#btn-flag').disabled) $('#btn-flag').click();
  }
  if (e.key === 'y' && viewKind === 'album' && hintMode) {
    // promote hint → real selection (subset of paths); both contiguous and
    // subset hints already publish their highlighted paths.
    selectedPhotos = new Set(hintPaths);
    rerender_photos();
    fetchSimilarForSelection();
  }
  if (e.key === 'Escape') {
    if (!$('#lightbox').hidden) { hideLightbox(); return; }
    if (drawerAlbumId) { closeDrawer(); return; }
    if (viewKind === 'album' && selectedPhotos.size > 0) {
      selectedPhotos.clear(); rerender_photos(); fetchSimilarForSelection();
    } else if (selected.size > 0) {
      selected.clear(); renderAlbums();
    } else {
      navigate('#/');
    }
  }
});

// ── helpers ──────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
function basename(p) { return (p || '').split('/').pop(); }
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
}
function formatGap(h) { return h < 24 ? h.toFixed(1) + 'h' : (h/24).toFixed(1) + 'd'; }

// ── boot ─────────────────────────────────────────────────────
(async function () {
  await refreshStats().catch(() => {});
  route();
})();
