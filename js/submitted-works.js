/* ══════════════════════════════════════════════════════════════
   SUBMITTED WORKS — everything the students sent in, grouped by
   program, then by section.

   Three levels of drill-down, one source of truth:
     • PROGRAMS  — Multimedia Arts / Data Analytics. A reviewer is
       often asked to look at works outside their own program, so
       this page is not limited to one program: the tabs sit side by
       side and each one opens the sections underneath it.
     • SECTIONS — the classes inside the picked program.
     • WORKS    — what those students sent in, filterable by status.

   The sidebar entry expands into the same list (sections grouped
   under their program), so the professor can jump straight to a
   section from anywhere. The page repeats both rows as filter tabs,
   because on a phone the sidebar is a horizontal strip that cannot
   hold the tree.

   Only works that were actually sent for review show up: drafts
   (withdrawn submissions and the student's personal gallery) stay
   private to their owner, exactly like everywhere else in the app.

   Data source: portfolio_items joined to portfolios (status,
   grading period, grade) and to user_profiles (student name,
   section and program) — the same loadAllItemsForProfessor() feed
   the "Artworks for Review" queue uses, so both pages always agree.
   ══════════════════════════════════════════════════════════════ */

// Bucket for works whose student has no section (or whose section is not
// on the roster). Kept separate from "no filter" (null).
const SW_NO_SECTION = '@none';

let _swSections      = [];   // every section on the roster
let _swItems         = [];   // every work sent in (drafts removed)
let _swRows          = [];   // section rows of the current render — the tabs and the sidebar share the index
let _swProgRows      = [];   // program rows of the current render
let _swProgramFilter = null; // null = every program · otherwise a program (department)
let _swSectionFilter = null; // null = every section · otherwise a section key
let _swSectionByProgram = {}; // program key → the section last opened in it
let _swStatusFilter  = 'all';
let _swNavOpen       = false;

// ── SECTION LIST ──
// Every section on the roster, not just the professor's own program:
// this page is a cross-program review surface (a reviewer is asked
// to look at other programs' works too), and the works list itself is
// never program-limited. Cached after the first load.
async function loadSubmittedWorksSections(force){
  if(_swSections.length && !force) return _swSections;
  try{
    const { data, error } = await sb
      .from('sections')
      .select('id,name,school_year,semester,department')
      .order('name');
    if(error) throw error;
    _swSections = (data || []).map(s => ({ ...s, department: s.department || PROGRAM_MM }));
  }catch(err){
    // The department column may not be deployed yet — fall back to the
    // original shape and treat every section as Multimedia Arts.
    try{
      const { data } = await sb
        .from('sections')
        .select('id,name,school_year,semester')
        .order('name');
      _swSections = (data || []).map(s => ({ ...s, department: PROGRAM_MM }));
    }catch(e2){
      console.error('loadSubmittedWorksSections error:', err);
      _swSections = [];
    }
  }
  return _swSections;
}

// ── PROGRAMS ──
// The program a work belongs to: the student's own program, falling
// back to the program of their section, then to Multimedia Arts.
function swProgramForItem(p){
  const dept = (p && p.department) || '';
  if(dept) return dept;
  const name = (p && p.section ? p.section : '').trim();
  const sec  = _swSections.find(s => s.name === name);
  return sec ? (sec.department || PROGRAM_MM) : PROGRAM_MM;
}

// The programs to offer, in a fixed order: Multimedia Arts, then Data
// Analytics, then anything else that turns up in the data.
function swProgramList(items){
  const found = new Set();
  (items || []).forEach(p => found.add(swProgramForItem(p)));
  _swSections.forEach(s => found.add(s.department || PROGRAM_MM));
  const list = [];
  STUDENT_PROGRAMS.forEach(pr => { if(found.has(pr.value)) list.push(pr.value); });
  Array.from(found).sort().forEach(d => { if(!list.includes(d)) list.push(d); });
  return list;
}

// ── GROUPING ──
// The bucket a work belongs to: its student's section name, or the
// "no section" bucket when the student isn't enrolled anywhere.
function swKeyFor(p){
  const key = (p && p.section ? p.section : '').trim();
  return key || SW_NO_SECTION;
}

// One row per section: the roster sections first (alphabetical), then
// any leftover group — a section that is no longer on the roster, or
// works from students without a section.
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
      key:     s.name,
      label:   s.name,
      meta:    [s.school_year, s.semester].filter(Boolean).join(' · '),
      program: s.department || PROGRAM_MM,
      items:   groups.get(s.name) || []
    });
  });

  Array.from(groups.keys()).sort().forEach(key => {
    if(seen.has(key)) return;
    const isNone = key === SW_NO_SECTION;
    const items  = groups.get(key);
    rows.push({
      key:     key,
      label:   isNone ? 'No Section' : key,
      meta:    isNone ? 'Students without a section' : 'Not on the roster',
      program: items.length ? swProgramForItem(items[0]) : PROGRAM_MM,
      items:   items
    });
  });

  // Flat index — the tabs and the sidebar both address a row by it.
  rows.forEach((r,i) => { r.idx = i; });
  return rows;
}

// The works that pass the program and section filters.
function swVisibleItems(){
  let items = _swItems;
  if(_swProgramFilter) items = items.filter(p => swProgramForItem(p) === _swProgramFilter);
  if(_swSectionFilter !== null) items = items.filter(p => swKeyFor(p) === _swSectionFilter);
  return items;
}

// Pull the sent-in works out of the professor's shared item cache.
// Drafts (withdrawn submissions + the student's personal gallery) are
// private to their owner, so they never show up here.
function swSyncItems(){
  _swItems = (_profItems || []).filter(p => p.status !== 'draft');
  return _swItems;
}

// The section rows that actually have something to show. The roster holds
// every section in the school, but a section with nothing in it is not
// actionable — listing them all turns the tabs and the sidebar into a
// wall of empty rows, so they are skipped (the page says how many were
// left out).
function swRowsWithWorks(){
  return _swRows.filter(r => r.items.length > 0);
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

  // ── program tabs (All Sections · Multimedia Arts · Data Analytics) ──
  _swProgRows = swProgramList(_swItems).map(prog => ({
    key:   prog,
    label: departmentLabel(prog),
    items: _swItems.filter(p => swProgramForItem(p) === prog)
  }));
  const progTabsEl = document.getElementById('sw-program-tabs');
  if(progTabsEl){
    let html = `<button class="filter-tab${_swProgramFilter===null?' active':''}" onclick="swFilterProgram(-1, this)">All Sections (${_swItems.length})</button>`;
    html += _swProgRows.map((r,i) =>
      `<button class="filter-tab${_swProgramFilter===r.key?' active':''}" onclick="swFilterProgram(${i}, this)" title="${esc(r.label)}">${esc(r.label)} (${r.items.length})</button>`
    ).join('');
    progTabsEl.innerHTML = html;
  }

  // ── section tabs — the sections of the program that is open ──
  const programRows  = _swRows.filter(r => !_swProgramFilter || r.program === _swProgramFilter);
  const sectionRows  = programRows.filter(r => r.items.length > 0);
  const hiddenRows   = programRows.length - sectionRows.length;
  const secTabsEl = document.getElementById('sw-section-tabs');
  if(secTabsEl){
    secTabsEl.innerHTML = sectionRows.length
      ? sectionRows.map(r =>
          `<button class="filter-tab${_swSectionFilter===r.key?' active':''}" onclick="swFilterSection(${r.idx}, this)" title="${esc(r.meta || r.label)}">${esc(r.label)} (${r.items.length})</button>`
        ).join('')
      : `<div style="font-size:12px;color:var(--text3);padding:6px 0;">${_swProgramFilter ? 'No works in this program yet.' : 'No works have been sent in yet.'}</div>`;
  }

  // Sections left out because nothing was sent in — a one-line note so the
  // professor still knows they exist.
  const secNoteEl = document.getElementById('sw-section-note');
  if(secNoteEl){
    secNoteEl.textContent = hiddenRows
      ? `${hiddenRows} section${hiddenRows===1?'':'s'} with nothing sent in yet — ask them to submit.`
      : '';
    secNoteEl.style.display = hiddenRows ? 'block' : 'none';
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
    const prog = _swProgramFilter ? departmentLabel(_swProgramFilter) : null;
    const row  = _swRows.find(r => r.key === _swSectionFilter);
    if(row){
      const meta = row.meta ? ` · ${row.meta}` : '';
      subEl.textContent = `${prog ? prog + ' · ' : ''}${row.label}${meta} — ${row.items.length} work${row.items.length===1?'':'s'}`;
    }else if(prog){
      const n = _swProgRows.find(r => r.key === _swProgramFilter);
      subEl.textContent = `${prog} — ${n ? n.items.length : 0} work${n && n.items.length===1?'':'s'} · pick a section below`;
    }else{
      const withWorks = swRowsWithWorks().length;
      subEl.textContent = _swItems.length
        ? `Every work your students sent in — ${_swItems.length} work${_swItems.length===1?'':'s'} across ${withWorks} section${withWorks===1?'':'s'}.`
        : 'Every work your students sent in, program by program and section by section.';
    }
  }

  // ── the list ──
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
// The same sections as the page, grouped under their program. Only the
// sections that actually have works are listed — the sidebar is narrow,
// and a long list of empty sections would overflow it.
async function renderSubmittedWorksNav(){
  await loadSubmittedWorksSections();
  swSyncItems();

  const el = document.getElementById('nav-p-submitted-works-list');
  if(!el) return;
  _swRows = swSectionRows(_swItems);

  const withWorks = swRowsWithWorks();
  if(!withWorks.length){
    el.innerHTML = `<div class="snav-sub-empty">Nothing sent in yet</div>`;
    return;
  }

  // Group the rows by program, keeping the program's own order.
  const byProgram = new Map();
  withWorks.forEach(r => {
    if(!byProgram.has(r.program)) byProgram.set(r.program, []);
    byProgram.get(r.program).push(r);
  });

  let html = '';
  swProgramList(_swItems).forEach(prog => {
    const rows = byProgram.get(prog) || [];
    if(!rows.length) return;
    html += `<div class="snav-sub-group">${esc(departmentLabel(prog))}</div>`;
    html += rows.map(r =>
      `<div class="snav-sub-item${_swSectionFilter===r.key?' active':''}" onclick="openSubmittedWorksSection(${r.idx})" title="${esc(r.label)} — ${r.items.length} work${r.items.length===1?'':'s'}">
        <span class="snav-sub-name">${esc(r.label)}</span>
        <span class="snav-sub-count">${r.items.length}</span>
      </div>`
    ).join('');
  });

  el.innerHTML = html || `<div class="snav-sub-empty">Nothing sent in yet</div>`;
}

// ── NAV / FILTER ACTIONS ──
// Section picked in the sidebar: jump to the page with that section open.
function openSubmittedWorksSection(i){
  const row = _swRows[i];
  if(!row) return;
  // Open the program that owns the section, so both tab rows agree.
  _swProgramFilter = row.program;
  _swSectionFilter = row.key;
  _swNavOpen = true;
  applySubmittedWorksNavState();
  pPage('p-submitted-works');
}

// Program picked in the first tab row (-1 = every program).
function swFilterProgram(i, btn){
  const prev = _swProgramFilter;
  const next = (i === -1 || !_swProgRows[i]) ? null : _swProgRows[i].key;

  // Remember the section that was open in the program we are leaving, and
  // restore the one that was last opened in the program we are entering.
  if(prev !== null && _swSectionFilter !== null) _swSectionByProgram[prev] = _swSectionFilter;

  _swProgramFilter = next;
  if(next === null){
    // "All Sections" means every program and every section — nothing narrows it.
    _swSectionFilter = null;
  }else{
    const remembered = _swSectionByProgram[next];
    const row = remembered ? _swRows.find(r => r.key === remembered) : null;
    _swSectionFilter = (row && row.program === next) ? remembered : null;
  }

  renderSubmittedWorksBody();
  renderSubmittedWorksNav();
}

// Section picked in the second tab row.
function swFilterSection(i, btn){
  _swSectionFilter = (i < 0 || !_swRows[i]) ? null : _swRows[i].key;
  renderSubmittedWorksBody();
  renderSubmittedWorksNav();
}

// Status picked in the third tab row.
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

// The tree is only useful while the professor is on the Submitted Works
// page — close it when they go somewhere else, so it never pushes the
// sidebar around.
function closeSubmittedWorksNav(){
  if(!_swNavOpen) return;
  _swNavOpen = false;
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
