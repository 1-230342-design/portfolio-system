// ══════════════════════════════════════════════════════
//  Artfolio — Grade Archives (section-centric)
//  A "section" now carries School Year + Semester and covers
//  every grading period within it. Students enroll into a
//  section at sign-up; every grade a professor saves for them
//  is snapshotted with that section (see saveGrade() in app.js).
//  Clicking a section previews its grades live — Details view
//  (one row per graded submission, plus who still has NO grade
//  in the period) or Summary view (one row per student with
//  per-period finals and a semester average) — and downloads
//  either the current view or the whole semester (4 periods +
//  summary) as .xlsx. The 🔒 Freeze button locks a section +
//  period so re-saving a grade can't silently rewrite history
//  (needs supabase-archive-freeze.sql, run once in the SQL
//  Editor; without it the button explains itself and grading
//  works exactly as before).
//  Loaded after js/app.js — shares its globals (sb, currentUser,
//  esc, showToast, _profItems).
// ══════════════════════════════════════════════════════

const GRADING_PERIOD_LABEL = { prelim:'Prelim', midterm:'Midterm', prefinals:'Pre-Finals', finals:'Finals' };
const PERIOD_ORDER = ['prelim', 'midterm', 'prefinals', 'finals'];

let _sectionsCache          = [];   // last-loaded list of sections
let currentPreviewSectionId = null; // section currently open in the preview modal
let currentPreviewRows      = [];   // details rows currently shown (also what gets downloaded)
let currentPreviewView      = 'details'; // 'details' | 'summary'
let currentSummaryRows      = [];   // summary rows currently shown (also what gets downloaded)
let _freezeTableOk          = null; // null = unknown, false = freeze table missing (lock fails open)

// ══════════════════════════════════════════════════════
//  MANAGE SECTIONS (professor: add/remove, and this is what
//  populates the dropdown students see at sign-up)
// ══════════════════════════════════════════════════════
async function addSection(){
  if(!currentUser){ showToast('⚠️ Please sign in first'); return; }
  const name       = document.getElementById('new-section-name').value.trim();
  const schoolYear = document.getElementById('new-section-syear').value.trim();
  const semester   = document.getElementById('new-section-semester').value;
  if(!name){ showToast('⚠️ Enter a section name'); return; }
  if(!schoolYear){ showToast('⚠️ Enter a school year (e.g. 2026-2027)'); return; }
  showToast('💾 Adding section…');
  try{
    const { error } = await sb.from('sections').insert([{ name, school_year: schoolYear, semester, created_by: currentUser.id }]);
    if(error) throw error;
    document.getElementById('new-section-name').value  = '';
    document.getElementById('new-section-syear').value = '';
    showToast('✅ Section added: '+name);
    renderSectionsManager();
  }catch(err){
    console.error('addSection error:', err);
    showToast('❌ Error: '+err.message);
  }
}

async function deleteSection(id){
  if(!confirm('Delete this section? Students already enrolled keep their current section text — this only removes it from the sign-up dropdown and this list. Already-saved grades keep their section on record.')) return;
  try{
    const { error } = await sb.from('sections').delete().eq('id', id);
    if(error) throw error;
    showToast('🗑️ Section deleted.');
    renderSectionsManager();
  }catch(err){
    console.error('deleteSection error:', err);
    showToast('❌ Error: '+err.message);
  }
}

async function renderSectionsManager(){
  const el = document.getElementById('sections-list');
  if(!el) return;
  el.innerHTML = `<div style="font-size:13px;color:var(--text3);">Loading sections…</div>`;
  try{
    const { data, error } = await sb.from('sections').select('id,name,school_year,semester').order('name');
    if(error) throw error;
    _sectionsCache = data || [];
  }catch(err){
    console.error('renderSectionsManager error:', err);
    _sectionsCache = [];
  }

  if(!_sectionsCache.length){
    el.innerHTML = `<div class="empty-state"><p>No sections yet. Add one above — it'll appear as a choice on the student sign-up page right away.</p></div>`;
    return;
  }

  el.innerHTML = _sectionsCache.map(s => `
    <div class="section-group" onclick="openSectionPreview('${s.id}')">
      <div class="section-group-info">
        <div class="section-name">${esc(s.name)}</div>
        <div class="section-year">${esc(s.school_year || 'No school year set')} &middot; ${esc(s.semester || '')}</div>
      </div>
      <button class="btn-cancel" style="padding:8px 12px;" onclick="event.stopPropagation();deleteSection('${s.id}')">🗑️</button>
    </div>`).join('');
}

// This is the page-load entry point pPage() calls when opening Grade Archives
async function renderArchivesPage(){
  renderSectionsManager();
}

// ══════════════════════════════════════════════════════
//  SECTION PREVIEW — click a section, pick Details/Summary,
//  pick a grading period (Details), see the grades, freeze,
//  and download the current view or the full semester.
// ══════════════════════════════════════════════════════
async function openSectionPreview(sectionId){
  const section = _sectionsCache.find(s => s.id === sectionId);
  if(!section){ showToast('⚠️ Section not found'); return; }
  currentPreviewSectionId = sectionId;
  currentPreviewView = 'details';
  updatePreviewViewUI();
  document.getElementById('sp-section-title').textContent = `${section.name} — ${section.school_year || ''} ${section.semester || ''}`;
  document.getElementById('sectionPreviewOverlay').classList.add('open');
  await loadSectionPreview();
}

function closeSectionPreview(){
  document.getElementById('sectionPreviewOverlay').classList.remove('open');
  currentPreviewSectionId = null;
  currentPreviewRows = [];
  currentSummaryRows = [];
  currentPreviewView = 'details';
}

function switchPreviewView(view){
  if(currentPreviewView === view) return;
  currentPreviewView = view;
  updatePreviewViewUI();
  if(view === 'summary') loadSectionSummary();
  else loadSectionPreview();
}

function updatePreviewViewUI(){
  const d = document.getElementById('sp-view-details');
  const s = document.getElementById('sp-view-summary');
  if(d) d.classList.toggle('active', currentPreviewView === 'details');
  if(s) s.classList.toggle('active', currentPreviewView === 'summary');
  // Summary spans all four periods, so the period picker doesn't apply to it.
  const sel = document.getElementById('sp-period-select');
  if(sel){
    sel.disabled = (currentPreviewView === 'summary');
    sel.style.opacity = (currentPreviewView === 'summary') ? '.45' : '1';
  }
}

// Shared fetch: every graded portfolio snapshotted to this section name,
// optionally for one grading period. Filters on portfolios.section — the
// snapshot saveGrade() writes at grading time — not the student's live
// profile section, so a grade stays correctly filed under the section the
// student was actually in when it was graded, even if they change sections
// later. Older grades saved before this snapshot existed won't have a
// section value yet; re-saving those grades once will backfill them.
async function fetchSectionGradeData(sectionName, period){
  let q = sb
    .from('portfolios')
    .select('student_id, assignment_id, grading_period, creativity_score, technique_score, composition_score, final_grade, grade_remarks')
    .eq('section', sectionName)
    .not('final_grade', 'is', null);
  if(period) q = q.eq('grading_period', period);
  const { data: rows, error } = await q;
  if(error) throw error;

  const list = rows || [];
  const studentIds = [...new Set(list.map(r => r.student_id))];
  let profileMap = {};
  if(studentIds.length){
    const { data: profiles } = await sb
      .from('user_profiles').select('user_id, full_name, student_id').in('user_id', studentIds);
    (profiles || []).forEach(p => { profileMap[p.user_id] = p; });
  }

  // A student can have more than one graded portfolio in the same section +
  // grading period — one per Classwork assignment, plus possibly a plain
  // "Upload Work" submission with no assignment attached. Without knowing
  // which is which, two rows for the same student/period look like a
  // duplicate. Pulling in the assignment title (looked up separately, since
  // there's no direct FK embed used for this relationship elsewhere in the
  // app) makes each row identifiable.
  const assignmentIds = [...new Set(list.map(r => r.assignment_id).filter(Boolean))];
  let assignmentMap = {};
  if(assignmentIds.length){
    const { data: assignmentRows } = await sb.from('assignments').select('id, title').in('id', assignmentIds);
    (assignmentRows || []).forEach(a => { assignmentMap[a.id] = a.title; });
  }

  return { list, profileMap, assignmentMap };
}

function buildDetailRows(data){
  return data.list.map(r => {
    const pr = data.profileMap[r.student_id] || {};
    return {
      studentId: r.student_id,
      name: pr.full_name || 'Student',
      studentNumber: pr.student_id || '',
      assignment: r.assignment_id ? (data.assignmentMap[r.assignment_id] || 'Untitled Assignment') : 'General Submission',
      creativity: r.creativity_score,
      technique: r.technique_score,
      composition: r.composition_score,
      finalGrade: r.final_grade,
      remarks: r.grade_remarks || ''
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.assignment.localeCompare(b.assignment));
}

async function loadSectionPreview(){
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section) return;
  const period = document.getElementById('sp-period-select').value;
  const wrap = document.getElementById('sp-table-wrap');
  wrap.innerHTML = `<div style="font-size:13px;color:var(--text3);">Loading grades…</div>`;

  try{
    const data = await fetchSectionGradeData(section.name, period);
    currentPreviewRows = buildDetailRows(data);

    if(!currentPreviewRows.length){
      currentPreviewRows = [];
      wrap.innerHTML = `<div class="empty-state"><p>No graded submissions yet for ${esc(section.name)} — ${esc(GRADING_PERIOD_LABEL[period] || period)}.</p></div>`
        + await renderMissingBlock(section, period, new Set());
    }else{
      const gradedIds = new Set(data.list.map(r => r.student_id));
      wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;border-bottom:2px solid var(--border);">
          <th style="padding:8px 6px;">Student</th>
          <th style="padding:8px 6px;">ID</th>
          <th style="padding:8px 6px;">Assignment</th>
          <th style="padding:8px 6px;">Creativity</th>
          <th style="padding:8px 6px;">Technique</th>
          <th style="padding:8px 6px;">Composition</th>
          <th style="padding:8px 6px;">Final</th>
        </tr></thead>
        <tbody>${currentPreviewRows.map(r => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px 6px;font-weight:600;color:var(--dark);">${esc(r.name)}</td>
            <td style="padding:8px 6px;color:var(--text3);">${esc(r.studentNumber)}</td>
            <td style="padding:8px 6px;color:var(--text2);">${esc(r.assignment)}</td>
            <td style="padding:8px 6px;">${r.creativity ?? '—'}</td>
            <td style="padding:8px 6px;">${r.technique ?? '—'}</td>
            <td style="padding:8px 6px;">${r.composition ?? '—'}</td>
            <td style="padding:8px 6px;font-weight:700;color:var(--dark);">${r.finalGrade}/100</td>
          </tr>`).join('')}
        </tbody></table>`
        + await renderMissingBlock(section, period, gradedIds);
    }
  }catch(err){
    console.error('loadSectionPreview error:', err);
    wrap.innerHTML = `<div class="empty-state"><p>Couldn't load grades right now.</p></div>`;
  }
  refreshFreezeNote();
}

// Students enrolled in this section (by their sign-up section text) who have
// NO graded portfolio in the selected period — the professor's "who still
// needs grading" list. Returns '' when everyone is graded or the enrollment
// list can't be read.
async function renderMissingBlock(section, period, gradedIds){
  try{
    const { data: enrolled, error } = await sb
      .from('user_profiles').select('user_id, full_name, student_id').eq('role', 'student').eq('section', section.name);
    if(error || !enrolled || !enrolled.length) return '';
    const missing = enrolled.filter(s => !gradedIds.has(s.user_id)).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    if(!missing.length) return `<div style="margin-top:14px;font-size:13px;color:var(--text3);">✅ Everyone in ${esc(section.name)} has a grade for ${esc(GRADING_PERIOD_LABEL[period] || period)}.</div>`;
    return `<div style="margin-top:14px;background:var(--surface);border-radius:10px;padding:12px 14px;">
      <div style="font-size:13px;font-weight:700;color:var(--orange);margin-bottom:8px;">⚠️ Not yet graded in ${esc(GRADING_PERIOD_LABEL[period] || period)} (${missing.length})</div>
      ${missing.map(s => `<div style="font-size:13px;color:var(--dark);padding:3px 0;">${esc(s.full_name || 'Student')} <span style="color:var(--text3);">· ${esc(s.student_id || 'No ID')}</span></div>`).join('')}
    </div>`;
  }catch(err){
    console.warn('missing-grades lookup skipped:', err);
    return '';
  }
}

// ══════════════════════════════════════════════════════
//  SUMMARY VIEW — one row per student: each period's final
//  (averaged across that period's assignments when there's
//  more than one) plus a semester average across the periods
//  that actually have grades. This is the class-record shape.
// ══════════════════════════════════════════════════════
const avg1 = arr => arr.length ? +((arr.reduce((a, b) => a + b, 0)) / arr.length).toFixed(1) : null;

async function loadSectionSummary(){
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section) return;
  const wrap = document.getElementById('sp-table-wrap');
  wrap.innerHTML = `<div style="font-size:13px;color:var(--text3);">Loading summary…</div>`;

  try{
    const data = await fetchSectionGradeData(section.name, null);
    const byStudent = {};
    data.list.forEach(r => {
      if(r.final_grade == null) return;
      const sid = r.student_id;
      if(!byStudent[sid]) byStudent[sid] = { periods: { prelim: [], midterm: [], prefinals: [], finals: [] } };
      if(byStudent[sid].periods[r.grading_period]) byStudent[sid].periods[r.grading_period].push(+r.final_grade);
    });

    currentSummaryRows = Object.keys(byStudent).map(sid => {
      const pr = data.profileMap[sid] || {};
      const per = {};
      PERIOD_ORDER.forEach(p => { per[p] = avg1(byStudent[sid].periods[p]); });
      const have = PERIOD_ORDER.map(p => per[p]).filter(v => v != null);
      return {
        name: pr.full_name || 'Student',
        studentNumber: pr.student_id || '',
        prelim: per.prelim, midterm: per.midterm, prefinals: per.prefinals, finals: per.finals,
        average: avg1(have)
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    if(!currentSummaryRows.length){
      wrap.innerHTML = `<div class="empty-state"><p>No graded submissions yet for ${esc(section.name)}.</p></div>`;
    }else{
      const cell = v => v == null ? '<span style="color:var(--text3);">—</span>' : v;
      wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;border-bottom:2px solid var(--border);">
          <th style="padding:8px 6px;">Student</th>
          <th style="padding:8px 6px;">ID</th>
          <th style="padding:8px 6px;">Prelim</th>
          <th style="padding:8px 6px;">Midterm</th>
          <th style="padding:8px 6px;">Pre-Finals</th>
          <th style="padding:8px 6px;">Finals</th>
          <th style="padding:8px 6px;">Average</th>
        </tr></thead>
        <tbody>${currentSummaryRows.map(r => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px 6px;font-weight:600;color:var(--dark);">${esc(r.name)}</td>
            <td style="padding:8px 6px;color:var(--text3);">${esc(r.studentNumber)}</td>
            <td style="padding:8px 6px;">${cell(r.prelim)}</td>
            <td style="padding:8px 6px;">${cell(r.midterm)}</td>
            <td style="padding:8px 6px;">${cell(r.prefinals)}</td>
            <td style="padding:8px 6px;">${cell(r.finals)}</td>
            <td style="padding:8px 6px;font-weight:700;color:var(--dark);">${cell(r.average)}</td>
          </tr>`).join('')}
        </tbody></table>
        <div style="margin-top:10px;font-size:11px;color:var(--text3);">Period scores average every graded submission in that period; the semester average averages the periods that have grades.</div>`;
    }
  }catch(err){
    console.error('loadSectionSummary error:', err);
    wrap.innerHTML = `<div class="empty-state"><p>Couldn't load the summary right now.</p></div>`;
  }
  refreshFreezeNote();
}

// ══════════════════════════════════════════════════════
//  DOWNLOADS — the current view, or the whole semester
//  (4 period sheets + summary) in one workbook.
// ══════════════════════════════════════════════════════
function sectionFileStem(section){
  return `${section.name} - ${section.school_year || ''} - ${section.semester || ''}`.replace(/[\\/:*?"<>|]/g, '_');
}

async function downloadSectionSpreadsheet(){
  if(typeof XLSX === 'undefined'){
    showToast('❌ Spreadsheet library failed to load — check your internet connection and try again.');
    return;
  }
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section) return;

  if(currentPreviewView === 'summary'){
    if(!currentSummaryRows.length){ showToast('⚠️ Nothing to download yet.'); return; }
    showToast('📊 Building spreadsheet…');
    const rows = currentSummaryRows.map(r => ({
      'Student Name': r.name, 'Student ID': r.studentNumber,
      'Prelim (/100)': r.prelim, 'Midterm (/100)': r.midterm,
      'Pre-Finals (/100)': r.prefinals, 'Finals (/100)': r.finals,
      'Semester Average': r.average
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    XLSX.writeFile(wb, `${sectionFileStem(section)} - Summary.xlsx`);
    return;
  }

  // Details view — the selected period, as before.
  if(!currentPreviewRows.length){ showToast('⚠️ Nothing to download for this period yet.'); return; }
  const period = document.getElementById('sp-period-select').value;
  showToast('📊 Building spreadsheet…');

  const rows = currentPreviewRows.map(r => ({
    'Student Name':       r.name,
    'Student ID':         r.studentNumber,
    'Assignment':         r.assignment,
    'Creativity (/40)':   r.creativity,
    'Technique (/35)':    r.technique,
    'Composition (/25)':  r.composition,
    'Final Grade (/100)': r.finalGrade,
    'Remarks':            r.remarks
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [ {wch:24},{wch:14},{wch:26},{wch:14},{wch:13},{wch:15},{wch:15},{wch:30} ];
  const wb = XLSX.utils.book_new();
  const periodLabel = GRADING_PERIOD_LABEL[period] || period;
  XLSX.utils.book_append_sheet(wb, ws, periodLabel.slice(0, 28));

  const fname = `${sectionFileStem(section)} - ${periodLabel}.xlsx`;
  XLSX.writeFile(wb, fname);
}

async function downloadSemesterWorkbook(){
  if(typeof XLSX === 'undefined'){
    showToast('❌ Spreadsheet library failed to load — check your internet connection and try again.');
    return;
  }
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section) return;
  showToast('📊 Building semester workbook…');

  try{
    const data = await fetchSectionGradeData(section.name, null);
    const wb = XLSX.utils.book_new();
    let anyGrades = false;

    for(const period of PERIOD_ORDER){
      const detail = buildDetailRows({
        list: data.list.filter(r => r.grading_period === period),
        profileMap: data.profileMap, assignmentMap: data.assignmentMap
      });
      if(!detail.length) continue;
      anyGrades = true;
      const ws = XLSX.utils.json_to_sheet(detail.map(r => ({
        'Student Name': r.name, 'Student ID': r.studentNumber, 'Assignment': r.assignment,
        'Creativity (/40)': r.creativity, 'Technique (/35)': r.technique,
        'Composition (/25)': r.composition, 'Final Grade (/100)': r.finalGrade, 'Remarks': r.remarks
      })));
      ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 26 }, { wch: 14 }, { wch: 13 }, { wch: 15 }, { wch: 15 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws, (GRADING_PERIOD_LABEL[period] || period).slice(0, 28));
    }

    // Summary sheet from the same data (no second fetch).
    const byStudent = {};
    data.list.forEach(r => {
      if(r.final_grade == null) return;
      if(!byStudent[r.student_id]) byStudent[r.student_id] = { prelim: [], midterm: [], prefinals: [], finals: [] };
      if(byStudent[r.student_id][r.grading_period]) byStudent[r.student_id][r.grading_period].push(+r.final_grade);
    });
    const summary = Object.keys(byStudent).map(sid => {
      const pr = data.profileMap[sid] || {};
      const per = {};
      PERIOD_ORDER.forEach(p => { per[p] = avg1(byStudent[sid][p]); });
      return {
        'Student Name': pr.full_name || 'Student', 'Student ID': pr.student_id || '',
        'Prelim (/100)': per.prelim, 'Midterm (/100)': per.midterm,
        'Pre-Finals (/100)': per.prefinals, 'Finals (/100)': per.finals,
        'Semester Average': avg1(PERIOD_ORDER.map(p => per[p]).filter(v => v != null))
      };
    }).sort((a, b) => String(a['Student Name']).localeCompare(String(b['Student Name'])));
    if(summary.length){
      anyGrades = true;
      const ws = XLSX.utils.json_to_sheet(summary);
      ws['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    }

    if(!anyGrades){ showToast('⚠️ Nothing graded in this section yet.'); return; }
    XLSX.writeFile(wb, `${sectionFileStem(section)} - Full Semester.xlsx`);
    showToast('✅ Semester workbook downloaded!');
  }catch(err){
    console.error('downloadSemesterWorkbook error:', err);
    showToast('❌ Could not build the workbook: ' + err.message);
  }
}

// ══════════════════════════════════════════════════════
//  FREEZE LOCK — locks a section + grading period so grades
//  can't be re-saved into it. Needs the archive_freezes table
//  (supabase-archive-freeze.sql, run once). Every path fails
//  open: if the table is missing, grading works exactly as
//  before and only the freeze UI says it's unavailable.
// ══════════════════════════════════════════════════════
async function isPeriodFrozen(sectionName, period){
  if(!sectionName || !period) return false;
  try{
    const { data, error } = await sb.from('archive_freezes')
      .select('id').eq('section_name', sectionName).eq('grading_period', period).maybeSingle();
    if(error) throw error;
    if(_freezeTableOk !== true) _freezeTableOk = true;
    return !!data;
  }catch(err){
    if(_freezeTableOk !== false){
      _freezeTableOk = false;
      console.info('[archives] freeze table unavailable — run supabase-archive-freeze.sql. Grading stays unlocked.');
    }
    return false; // fail open — never block a legit grade save on a setup issue
  }
}

async function refreshFreezeNote(){
  const noteEl = document.getElementById('sp-freeze-note');
  const btnEl  = document.getElementById('sp-freeze-btn');
  if(!noteEl || !btnEl) return;
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section){ noteEl.textContent = ''; btnEl.style.display = 'none'; return; }
  // The lock is per grading period; Summary view spans all four, so freezing
  // from there would be ambiguous — pick a period in Details to freeze it.
  if(currentPreviewView === 'summary'){
    noteEl.textContent = 'Switch to Details to freeze a grading period.';
    noteEl.style.color = 'var(--text3)';
    btnEl.style.display = 'none';
    return;
  }
  const period = document.getElementById('sp-period-select').value;
  btnEl.style.display = '';
  const frozen = await isPeriodFrozen(section.name, period);
  if(_freezeTableOk === false){
    noteEl.textContent = '🔒 Freeze unavailable — run supabase-archive-freeze.sql in the SQL Editor.';
    noteEl.style.color = 'var(--orange)';
    btnEl.textContent = '🔒 Freeze Period';
    return;
  }
  if(frozen){
    noteEl.textContent = `🔒 ${GRADING_PERIOD_LABEL[period] || period} is FROZEN — grades here can't be changed until it's unfrozen.`;
    noteEl.style.color = 'var(--red)';
    btnEl.textContent = '🔓 Unfreeze Period';
  }else{
    noteEl.textContent = `${GRADING_PERIOD_LABEL[period] || period} is open for grading.`;
    noteEl.style.color = 'var(--text3)';
    btnEl.textContent = '🔒 Freeze Period';
  }
}

async function toggleFreeze(){
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section || !currentUser) return;
  if(currentPreviewView === 'summary'){ showToast('⚠️ Switch to Details and pick the period to freeze.'); return; }
  const period = document.getElementById('sp-period-select').value;
  showToast('⏳ Updating freeze…');
  try{
    const frozen = await isPeriodFrozen(section.name, period);
    if(_freezeTableOk === false) throw new Error('Freeze is not set up yet — run supabase-archive-freeze.sql in the SQL Editor first.');
    if(frozen){
      const { error } = await sb.from('archive_freezes').delete().eq('section_name', section.name).eq('grading_period', period);
      if(error) throw error;
      showToast(`🔓 ${GRADING_PERIOD_LABEL[period] || period} unfrozen — grading is open again.`);
    }else{
      const { error } = await sb.from('archive_freezes').insert([{
        section_name: section.name, grading_period: period,
        school_year: section.school_year || null, semester: section.semester || null,
        frozen_by: currentUser.id
      }]);
      if(error) throw error;
      showToast(`🔒 ${GRADING_PERIOD_LABEL[period] || period} frozen — grades here are now locked.`);
    }
    await refreshFreezeNote();
  }catch(err){
    console.error('toggleFreeze error:', err);
    showToast('❌ ' + err.message);
  }
}
