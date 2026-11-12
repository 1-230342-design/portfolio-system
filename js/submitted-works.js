/* ══════════════════════════════════════════════════════════════
   SUBMITTED WORKS — everything the students sent in, drillable
   down to a single student.

   Three levels, one source of truth:
     • PROGRAMS  — Multimedia Arts / Data Analytics side by side.
       A reviewer is often asked to look at works outside their own
       program, so this page is not limited to one program.
     • SECTIONS — every section on the roster, not only the ones
       that happen to have submissions: an empty section is exactly
       what a professor wants to know about.
     • STUDENTS — the roster of the picked section. Clicking a name
       opens that student's works, where the professor can rate and
       grade them (the Review Panel).

   The page also has an "All Works" level: no section picked means
   every work sent in by everyone in the current program scope.

   The sidebar entry expands into the same section list, so a
   professor can jump to a section from anywhere. The page repeats
   both rows as filter tabs, because on a phone the sidebar is a
   horizontal strip that cannot hold the tree.

   Drafts (withdrawn submissions and the student's personal gallery)
   stay private to their owner, exactly like everywhere else in the
   app.

   Data source: portfolio_items joined to portfolios (status, grading
   period, grade) and to user_profiles (student name, section and
   program) — the same loadAllItemsForProfessor() feed the "Artworks
   for Review" queue uses, so both pages always agree.
   ══════════════════════════════════════════════════════════════ */

// Bucket for works whose student has no section (or whose section is not
// on the roster). Kept separate from "no filter" (null).
const SW_NO_SECTION = '@none';

let _swSections      = [];   // every section on the roster
let _swItems         = [];   // every work sent in (drafts removed)
let _swStudents      = [];   // every signed-up student
let _swRows          = [];   // section rows of the current render — the tabs and the sidebar share the index
let _swProgRows      = [];   // program rows of the current render
let _swProgramFilter = null; // null = every program · otherwise a program (department)
let _swSectionFilter = null; // null = all works · otherwise a section key
let _swSelectedStudent = null; // user_id of the student whose works are open
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

// ── STUDENT ROSTER ──
// Every signed-up student, so a section can show its full roster —
// not just the ones who happened to submit something.
async function loadSubmittedWorksStudents(){
  if(_swStudents.length) return _swStudents;
  try{
    _swStudents = await loadAllStudentProfiles();
  }catch(err){
    console.error('loadSubmittedWorksStudents error:', err);
    _swStudents = [];
  }
  return _swStudents;
}

// The students enrolled in a section (the "no section" bucket holds the
// ones who never picked one).
function swStudentsInSection(key){
  const name = key === SW_NO_SECTION ? '' : (key || '');
  return _swStudents.filter(s => (s.section || '') === name);
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

  // Students who never picked a section get a bucket of their own, so the
  // professor can still reach their works.
  const unenrolled = _swStudents.filter(s => !(s.section || ''));
  if(unenrolled.length && !seen.has(SW_NO_SECTION) && !rows.some(r => r.key === SW_NO_SECTION)){
    rows.push({
      key:     SW_NO_SECTION,
      label:   'No Section',
      meta:    'Students without a section',
      program: unenrolled[0].department || PROGRAM_MM,
      items:   groups.get(SW_NO_SECTION) || []
    });
  }

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

// ── PAGE ──
async function renderSubmittedWorksPage(){
  const listEl = document.getElementById('sw-list');
  if(!listEl) return;
  listEl.innerHTML = loadingHtml('Loading submitted works…');

  await Promise.all([ loadSubmittedWorksSections(), loadSubmittedWorksStudents() ]);

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

  // ── section tabs — every section of the program that is open, even the
  //    ones with nothing sent in yet (that is worth knowing too) ──
  const sectionRows = _swRows.filter(r => !_swProgramFilter || r.program === _swProgramFilter);
  const scopeWorks  = _swProgramFilter
    ? _swItems.filter(p => swProgramForItem(p) === _swProgramFilter)
    : _swItems;
  const secTabsEl = document.getElementById('sw-section-tabs');
  if(secTabsEl){
    let html = `<button class="filter-tab${_swSectionFilter===null?' active':''}" onclick="swFilterSection(-1, this)">All Works (${scopeWorks.length})</button>`;
    html += sectionRows.map(r =>
      `<button class="filter-tab${_swSectionFilter===r.key?' active':''}" onclick="swFilterSection(${r.idx}, this)" title="${esc(r.meta || r.label)}">${esc(r.label)} (${r.items.length})</button>`
    ).join('');
    secTabsEl.innerHTML = html;
  }

  // The status breakdown only makes sense where works are listed — it is
  // hidden while the section roster is on screen.
  const listWorks = _swSelectedStudent
    ? _swItems.filter(p => p.userId === _swSelectedStudent)
    : (_swSectionFilter === null ? swVisibleItems() : []);
  const statusEl = document.getElementById('sw-status-tabs');
  if(statusEl) statusEl.style.display = (_swSelectedStudent || _swSectionFilter === null) ? '' : 'none';

  // ── status counts (for the works the list is about to show) ──
  const countOf = st => listWorks.filter(p => p.status === st).length;
  const setCount = (id,n) => { const el = document.getElementById(id); if(el) el.textContent = '('+n+')'; };
  setCount('sw-count-all', listWorks.length);
  setCount('sw-count-submitted', countOf('submitted'));
  setCount('sw-count-approved', countOf('approved'));
  setCount('sw-count-rejected', countOf('rejected'));

  // ── subtitle ──
  const subEl = document.getElementById('sw-page-sub');
  if(subEl){
    const prog = _swProgramFilter ? departmentLabel(_swProgramFilter) : null;
    const row  = _swRows.find(r => r.key === _swSectionFilter);
    const student = _swSelectedStudent ? _swStudents.find(s => s.user_id === _swSelectedStudent) : null;
    if(student){
      const n = listWorks.length;
      subEl.textContent = `${student.full_name || 'Student'} — ${n} work${n===1?'':'s'}${row ? ' · ' + row.label : ''}`;
    }else if(row){
      const n = swStudentsInSection(row.key).length;
      subEl.textContent = `${prog ? prog + ' · ' : ''}${row.label}${row.meta ? ' · ' + row.meta : ''} — ${n} student${n===1?'':'s'} enrolled`;
    }else{
      subEl.textContent = _swItems.length
        ? `Every work your students sent in — ${_swItems.length} work${_swItems.length===1?'':'s'} across ${_swRows.length} section${_swRows.length===1?'':'s'}.`
        : 'Every work your students sent in, program by program, section by section, student by student.';
    }
  }

  // ── the list area: works → students → one student's works ──
  if(_swSelectedStudent)           renderStudentWorksView(listWorks);
  else if(_swSectionFilter !== null) renderStudentListView();
  else                              renderWorksListView(listWorks);
}

// ── VIEW 1: every work sent in ──
function renderWorksListView(listWorks){
  const listEl = document.getElementById('sw-list');
  if(!listEl) return;
  const shown = _swStatusFilter === 'all'
    ? listWorks
    : listWorks.filter(p => p.status === _swStatusFilter);
  listEl.innerHTML = shown.length
    ? shown.map(submissionItemHtml).join('')
    : `<div class="empty-state"><p>${_swItems.length
        ? 'No works in this category yet.'
        : 'No works have been sent in yet.'}</p></div>`;
}

// ── VIEW 2: the roster of the picked section ──
function renderStudentListView(){
  const listEl = document.getElementById('sw-list');
  if(!listEl) return;
  const row  = _swRows.find(r => r.key === _swSectionFilter);
  const label = row ? row.label : 'this section';
  const students = swStudentsInSection(_swSectionFilter)
    .slice().sort((a,b) => (a.full_name||'').localeCompare(b.full_name||''));

  let html = `<div style="margin-bottom:18px;cursor:pointer;color:var(--text3);font-size:13px;" onclick="swFilterSection(-1)">← All works</div>`;

  if(!students.length){
    html += `<div class="empty-state"><p>No students are enrolled in ${esc(label)} yet.</p></div>`;
    listEl.innerHTML = html;
    return;
  }

  html += `<div class="students-list">` + students.map(s => {
    const works = _swItems.filter(p => p.userId === s.user_id);
    const meta  = [s.student_id || 'No ID', s.year_level || ''].filter(Boolean).join(' · ');
    const sent  = works.length
      ? `${works.length} work${works.length===1?'':'s'} sent in`
      : 'Nothing sent in yet';
    return `<div class="student-row" onclick="openSubmittedWorksStudent('${s.user_id}')">
      <div class="student-ava">${avatarFaceHtml(s.full_name, s.avatar_url)}</div>
      <div class="student-row-info">
        <div class="student-row-name">${esc(s.full_name || 'Student')}</div>
        <div class="student-row-meta">${esc(meta)}</div>
        <div class="student-row-meta" style="margin-top:3px;">${esc(sent)}</div>
      </div>
      <button class="btn-view-sm" onclick="event.stopPropagation();openSubmittedWorksStudent('${s.user_id}')">👁 View Works</button>
    </div>`;
  }).join('') + `</div>`;

  listEl.innerHTML = html;
}

// ── VIEW 3: one student's works (rate + grade them here) ──
function renderStudentWorksView(listWorks){
  const listEl = document.getElementById('sw-list');
  if(!listEl) return;
  const student = _swStudents.find(s => s.user_id === _swSelectedStudent);
  const row     = _swRows.find(r => r.key === _swSectionFilter);
  const works   = listWorks || [];
  const shown   = _swStatusFilter === 'all'
    ? works
    : works.filter(p => p.status === _swStatusFilter);

  const name = student ? (student.full_name || 'Student') : 'Student';
  let html = `<div style="margin-bottom:18px;cursor:pointer;color:var(--text3);font-size:13px;" onclick="closeSubmittedWorksStudent()">← ${esc(row ? row.label : 'section roster')}</div>`;

  // Header — the same card the professor sees on the Students page.
  html += `<div class="portfolio-header" style="margin-bottom:20px;">
    <div class="portfolio-header-inner">
      <div class="portfolio-avatar-lg">${student ? avatarFaceHtml(student.full_name, student.avatar_url) : ''}</div>
      <div class="portfolio-info">
        <div class="portfolio-name">${esc(name)}</div>
        <div class="portfolio-meta">${esc([
          student && student.student_id ? student.student_id : 'No student ID',
          row ? row.label : '',
          student && student.year_level ? student.year_level : ''
        ].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
  </div>`;

  if(!works.length){
    html += `<div class="empty-state"><p>${esc(name)} hasn't sent in any work yet.</p></div>`;
    listEl.innerHTML = html;
    return;
  }

  if(!shown.length){
    html += `<div class="empty-state"><p>No works in this category yet.</p></div>`;
    listEl.innerHTML = html;
    return;
  }

  html += `<div class="projects-grid">` + shown.map(p => {
    const thumb = cardThumbHtml(p, 'project-thumb-frame', 'upload-thumb-placeholder', 'height:180px');
    const badge = p.status==='approved' ? 'badge-approved' : p.status==='rejected' ? 'badge-rejected' : 'badge-pending';
    const stars = p.rating ? `<span class="sub-rating" style="position:absolute;top:8px;left:8px;z-index:1;background:rgba(0,0,0,.55);padding:2px 7px;border-radius:12px;">★ ${p.rating}</span>` : '';
    return `<div class="project-card" style="position:relative;cursor:pointer;" onclick="openReviewById('${p.id}')" title="Click to rate and grade">
      <span class="upload-status-badge ${badge}" style="position:absolute;top:8px;right:8px;z-index:1;">${p.status}</span>
      ${stars}
      ${thumb}
      <div class="project-info">
        <div class="project-title">${esc(p.title)}</div>
        <div class="project-cat">${workMeta(p)}</div>
        <div class="project-desc">${esc(p.desc || '')}</div>
      </div>
    </div>`;
  }).join('') + `</div>`;

  listEl.innerHTML = html;
}

// ── SIDEBAR SECTION LIST ──
// The same sections as the page, grouped under their program.
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

  // Group the rows by program, keeping the program's own order.
  const byProgram = new Map();
  _swRows.forEach(r => {
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

  el.innerHTML = html || `<div class="snav-sub-empty">No sections yet</div>`;
}

// ── NAV / FILTER ACTIONS ──
// Section picked in the sidebar: jump to the page with that section open.
function openSubmittedWorksSection(i){
  const row = _swRows[i];
  if(!row) return;
  // Open the program that owns the section, so both tab rows agree.
  _swProgramFilter = row.program;
  _swSectionFilter = row.key;
  _swSelectedStudent = null;
  _swNavOpen = true;
  applySubmittedWorksNavState();
  pPage('p-submitted-works');
}

// Student picked in the roster: open that student's works.
function openSubmittedWorksStudent(userId){
  if(!userId) return;
  _swSelectedStudent = userId;
  renderSubmittedWorksBody();
}

// Back from a student's works to the roster of the section.
function closeSubmittedWorksStudent(){
  _swSelectedStudent = null;
  renderSubmittedWorksBody();
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
    // "All Sections" means every program — nothing narrows it.
    _swSectionFilter = null;
  }else{
    const remembered = _swSectionByProgram[next];
    const row = remembered ? _swRows.find(r => r.key === remembered) : null;
    _swSectionFilter = (row && row.program === next) ? remembered : null;
  }
  _swSelectedStudent = null;

  renderSubmittedWorksBody();
  renderSubmittedWorksNav();
}

// Section picked in the second tab row (-1 = all works).
function swFilterSection(i, btn){
  _swSectionFilter = (i < 0 || !_swRows[i]) ? null : _swRows[i].key;
  _swSelectedStudent = null;
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
