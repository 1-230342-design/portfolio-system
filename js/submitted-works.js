/* ══════════════════════════════════════════════════════════════
   SUBMITTED WORKS — everything the students sent in, grouped by
   section.

   Two ways in, one source of truth:
     • the sidebar gets a "Submitted Works" entry that expands into
       one row per section (with a live count), and
     • the page itself repeats the sections as filter tabs, so the
       same drill-down still works on a phone, where the sidebar is
       a horizontal strip.

   Only works that were actually sent for review show up: drafts
   (withdrawn submissions and the student's personal gallery) stay
   private to their owner, exactly like everywhere else in the app.

   Data source: portfolio_items joined to portfolios (status,
   grading period, grade) and to user_profiles (student name and
   section) — the same loadAllItemsForProfessor() feed the
   "Artworks for Review" queue uses, so both pages always agree.
   ══════════════════════════════════════════════════════════════ */

// Bucket for works whose student has no section (or whose section is not
// on the roster). Kept separate from "no filter" (null).
const SW_NO_SECTION = '@none';

let _swSections      = [];   // sections in this professor's scope
let _swItems         = [];   // every work sent in (drafts removed)
let _swRows          = [];   // section rows of the current render — the tabs and the sidebar share the index
let _swSectionFilter = null; // null = every section · otherwise a section key
let _swStatusFilter  = 'all';
let _swNavOpen       = false;

// ── SECTION LIST ──
// Only the sections of the professor's own program (super admins see all).
// Cached after the first load; pass force=true to re-read.
async function loadSubmittedWorksSections(force){
  if(_swSections.length && !force) return _swSections;
  try{
    const { data, error } = await sb
      .from('sections')
      .select('id,name,school_year,semester,department')
      .order('name');
    if(error) throw error;
    _swSections = (data || [])
      .filter(sectionInScope)
      .map(s => ({ ...s, department: s.department || PROGRAM_MM }));
  }catch(err){
    // The department column may not be deployed yet — fall back to the
    // original shape and treat every section as Multimedia Arts.
    try{
      const { data } = await sb
        .from('sections')
        .select('id,name,school_year,semester')
        .order('name');
      _swSections = (data || [])
        .map(s => ({ ...s, department: PROGRAM_MM }))
        .filter(sectionInScope);
    }catch(e2){
      console.error('loadSubmittedWorksSections error:', err);
      _swSections = [];
    }
  }
  return _swSections;
}

// ── GROUPING ──
// The bucket a work belongs to: its student's section name, or the
// "no section" bucket when the student isn't enrolled anywhere.
function swKeyFor(p){
  const key = (p && p.section ? p.section : '').trim();
  return key || SW_NO_SECTION;
}

// One row per section, official sections first (alphabetical), then any
// leftover group: a section that is no longer on the roster, or works
// from students without a section.
function swSectionRows(items){
  const groups = new Map();
  (items || []).forEach(p => {
    const key = swKeyFor(p);
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  const rows = [];
  const seen = new Set();
  _swSections.forEach(s => {
    seen.add(s.name);
    rows.push({
      key:   s.name,
      label: s.name,
      meta:  [s.school_year, s.semester].filter(Boolean).join(' · '),
      items: groups.get(s.name) || []
    });
  });

  Array.from(groups.keys()).sort().forEach(key => {
    if(seen.has(key)) return;
    const isNone = key === SW_NO_SECTION;
    rows.push({
      key:   key,
      label: isNone ? 'No Section' : key,
      meta:  isNone ? 'Students without a section' : 'Not on the roster',
      items: groups.get(key)
    });
  });

  return rows;
}

// The works the current section filter allows.
function swVisibleItems(){
  if(_swSectionFilter === null) return _swItems;
  return _swItems.filter(p => swKeyFor(p) === _swSectionFilter);
}

// Pull the sent-in works out of the professor's shared item cache.
// Drafts (withdrawn submissions + the student's personal gallery) are
// private to their owner, so they never show up here.
function swSyncItems(){
  _swItems = (_profItems || []).filter(p => p.status !== 'draft');
  return _swItems;
}

// ── PAGE ──
async function renderSubmittedWorksPage(){
  const listEl = document.getElementById('sw-list');
  if(!listEl) return;
  listEl.innerHTML = loadingHtml('Loading submitted works…');

  await loadSubmittedWorksSections();

  // Reuse the professor's cached item list; only fetch it when it is empty.
  if(!_profItems || !_profItems.length) _profItems = await loadAllItemsForProfessor();

  renderSubmittedWorksBody();
  renderSubmittedWorksNav();
}

function renderSubmittedWorksBody(){
  swSyncItems();
  _swRows = swSectionRows(_swItems);

  // ── section tabs ──
  const tabsEl = document.getElementById('sw-section-tabs');
  if(tabsEl){
    let html = `<button class="filter-tab${_swSectionFilter===null?' active':''}" onclick="swFilterSection(-1, this)">All Sections (${_swItems.length})</button>`;
    html += _swRows.map((r,i) =>
      `<button class="filter-tab${_swSectionFilter===r.key?' active':''}" onclick="swFilterSection(${i}, this)" title="${esc(r.meta || r.label)}">${esc(r.label)} (${r.items.length})</button>`
    ).join('');
    tabsEl.innerHTML = html;
  }

  const inSection = swVisibleItems();

  // ── status counts (for the section currently open) ──
  const countOf = st => inSection.filter(p => p.status === st).length;
  const setCount = (id,n) => { const el = document.getElementById(id); if(el) el.textContent = '('+n+')'; };
  setCount('sw-count-all', inSection.length);
  setCount('sw-count-submitted', countOf('submitted'));
  setCount('sw-count-approved', countOf('approved'));
  setCount('sw-count-rejected', countOf('rejected'));

  // ── the list itself: the open section, narrowed by the status tab ──
  const shown = _swStatusFilter === 'all'
    ? inSection
    : inSection.filter(p => p.status === _swStatusFilter);

  // ── subtitle ──
  const subEl = document.getElementById('sw-page-sub');
  if(subEl){
    const row = _swRows.find(r => r.key === _swSectionFilter);
    if(_swSectionFilter === null){
      subEl.textContent = _swItems.length
        ? `Every work your students sent in — ${_swItems.length} work${_swItems.length===1?'':'s'} across ${_swRows.length} section${_swRows.length===1?'':'s'}.`
        : 'Every work your students sent in, section by section.';
    }else if(row){
      const meta = row.meta ? ` · ${row.meta}` : '';
      subEl.textContent = `${row.label}${meta} — ${row.items.length} work${row.items.length===1?'':'s'}`;
    }else{
      subEl.textContent = 'Every work your students sent in, section by section.';
    }
  }

  // ── the list itself ──
  const listEl = document.getElementById('sw-list');
  if(listEl){
    listEl.innerHTML = shown.length
      ? shown.map(submissionItemHtml).join('')
      : `<div class="empty-state"><p>${_swItems.length
          ? 'No works in this category yet.'
          : 'No works have been sent in yet.'}</p></div>`;
  }
}

// ── SIDEBAR SECTION LIST ──
async function renderSubmittedWorksNav(){
  await loadSubmittedWorksSections();
  swSyncItems();

  const el = document.getElementById('nav-p-submitted-works-list');
  if(!el) return;
  _swRows = swSectionRows(_swItems);

  if(!_swRows.length){
    el.innerHTML = `<div class="snav-sub-empty">No sections yet</div>`;
    return;
  }

  el.innerHTML = _swRows.map((r,i) =>
    `<div class="snav-sub-item${_swSectionFilter===r.key?' active':''}" onclick="openSubmittedWorksSection(${i})" title="${esc(r.label)} — ${r.items.length} work${r.items.length===1?'':'s'}">
      <span class="snav-sub-name">${esc(r.label)}</span>
      <span class="snav-sub-count">${r.items.length}</span>
    </div>`
  ).join('');
}

// ── NAV / FILTER ACTIONS ──
// Section picked in the sidebar: jump to the page with that section open.
function openSubmittedWorksSection(i){
  const row = _swRows[i];
  if(!row) return;
  _swSectionFilter = row.key;
  _swNavOpen = true;
  applySubmittedWorksNavState();
  pPage('p-submitted-works');
}

// Section picked in the page's tab row (-1 = every section).
function swFilterSection(i, btn){
  _swSectionFilter = (i === -1 || !_swRows[i]) ? null : _swRows[i].key;
  renderSubmittedWorksBody();
  renderSubmittedWorksNav();
}

// Status picked in the page's second tab row.
function swFilterStatus(status, btn){
  _swStatusFilter = status;
  document.querySelectorAll('#sw-status-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  renderSubmittedWorksBody();
}

// Caret on the sidebar entry: open/close the per-section list.
function toggleSubmittedWorksNav(){
  _swNavOpen = !_swNavOpen;
  applySubmittedWorksNavState();
}

// Clicking the sidebar entry always shows the list.
function expandSubmittedWorksNav(){
  _swNavOpen = true;
  applySubmittedWorksNavState();
}

function applySubmittedWorksNavState(){
  const el = document.getElementById('nav-p-submitted-works-list');
  if(el) el.classList.toggle('open', _swNavOpen);
  const caret = document.getElementById('nav-p-submitted-works-caret');
  if(caret) caret.classList.toggle('open', _swNavOpen);
}
