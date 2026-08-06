// ══════════════════════════════════════════════════════
//  Artfolio — Grade Archives (section-centric)
//  A "section" now carries School Year + Semester and covers
//  every grading period within it. Students enroll into a
//  section at sign-up; every grade a professor saves for them
//  is snapshotted with that section (see saveGrade() in app.js).
//  Clicking a section previews its grades for a chosen grading
//  period, live, and lets you download that view as .xlsx —
//  there's no separate manual "archive batch" step anymore.
//  Loaded after js/app.js — shares its globals (sb, currentUser,
//  esc, showToast, _profItems).
// ══════════════════════════════════════════════════════

const GRADING_PERIOD_LABEL = { prelim:'Prelim', midterm:'Midterm', prefinals:'Pre-Finals', finals:'Finals' };

let _sectionsCache          = [];   // last-loaded list of sections
let currentPreviewSectionId = null; // section currently open in the preview modal
let currentPreviewRows      = [];   // rows currently shown in the preview table (also what gets downloaded)

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
//  SECTION PREVIEW — click a section, pick a grading period,
//  see who's graded and download that view as a spreadsheet.
// ══════════════════════════════════════════════════════
async function openSectionPreview(sectionId){
  const section = _sectionsCache.find(s => s.id === sectionId);
  if(!section){ showToast('⚠️ Section not found'); return; }
  currentPreviewSectionId = sectionId;
  document.getElementById('sp-section-title').textContent = `${section.name} — ${section.school_year || ''} ${section.semester || ''}`;
  document.getElementById('sectionPreviewOverlay').classList.add('open');
  await loadSectionPreview();
}

function closeSectionPreview(){
  document.getElementById('sectionPreviewOverlay').classList.remove('open');
  currentPreviewSectionId = null;
  currentPreviewRows = [];
}

async function loadSectionPreview(){
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section) return;
  const period = document.getElementById('sp-period-select').value;
  const wrap = document.getElementById('sp-table-wrap');
  wrap.innerHTML = `<div style="font-size:13px;color:var(--text3);">Loading grades…</div>`;

  try{
    // Filters on portfolios.section — the snapshot saveGrade() writes at
    // grading time — not the student's live profile section, so a grade
    // stays correctly filed under the section the student was actually in
    // when it was graded, even if they change sections later. Older grades
    // saved before this snapshot existed won't have a section value yet;
    // re-saving those grades once will backfill them.
    const { data: rows, error } = await sb
      .from('portfolios')
      .select('student_id, creativity_score, technique_score, composition_score, final_grade, grade_remarks')
      .eq('section', section.name)
      .eq('grading_period', period)
      .not('final_grade', 'is', null);
    if(error) throw error;

    if(!rows || !rows.length){
      currentPreviewRows = [];
      wrap.innerHTML = `<div class="empty-state"><p>No graded submissions yet for ${esc(section.name)} — ${esc(GRADING_PERIOD_LABEL[period] || period)}.</p></div>`;
      return;
    }

    const studentIds = [...new Set(rows.map(r => r.student_id))];
    const { data: profiles } = await sb
      .from('user_profiles').select('user_id, full_name, student_id').in('user_id', studentIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.user_id] = p; });

    currentPreviewRows = rows.map(r => {
      const pr = profileMap[r.student_id] || {};
      return {
        name: pr.full_name || 'Student',
        studentNumber: pr.student_id || '',
        creativity: r.creativity_score,
        technique: r.technique_score,
        composition: r.composition_score,
        finalGrade: r.final_grade,
        remarks: r.grade_remarks || ''
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="text-align:left;border-bottom:2px solid var(--border);">
        <th style="padding:8px 6px;">Student</th>
        <th style="padding:8px 6px;">ID</th>
        <th style="padding:8px 6px;">Creativity</th>
        <th style="padding:8px 6px;">Technique</th>
        <th style="padding:8px 6px;">Composition</th>
        <th style="padding:8px 6px;">Final</th>
      </tr></thead>
      <tbody>${currentPreviewRows.map(r => `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:8px 6px;font-weight:600;color:var(--dark);">${esc(r.name)}</td>
          <td style="padding:8px 6px;color:var(--text3);">${esc(r.studentNumber)}</td>
          <td style="padding:8px 6px;">${r.creativity ?? '—'}</td>
          <td style="padding:8px 6px;">${r.technique ?? '—'}</td>
          <td style="padding:8px 6px;">${r.composition ?? '—'}</td>
          <td style="padding:8px 6px;font-weight:700;color:var(--dark);">${r.finalGrade}/100</td>
        </tr>`).join('')}
      </tbody></table>`;
  }catch(err){
    console.error('loadSectionPreview error:', err);
    wrap.innerHTML = `<div class="empty-state"><p>Couldn't load grades right now.</p></div>`;
  }
}

async function downloadSectionSpreadsheet(){
  if(typeof XLSX === 'undefined'){
    showToast('❌ Spreadsheet library failed to load — check your internet connection and try again.');
    return;
  }
  if(!currentPreviewRows.length){ showToast('⚠️ Nothing to download for this period yet.'); return; }
  const section = _sectionsCache.find(s => s.id === currentPreviewSectionId);
  if(!section) return;
  const period = document.getElementById('sp-period-select').value;
  showToast('📊 Building spreadsheet…');

  const rows = currentPreviewRows.map(r => ({
    'Student Name':       r.name,
    'Student ID':         r.studentNumber,
    'Creativity (/40)':   r.creativity,
    'Technique (/35)':    r.technique,
    'Composition (/25)':  r.composition,
    'Final Grade (/100)': r.finalGrade,
    'Remarks':            r.remarks
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [ {wch:24},{wch:14},{wch:14},{wch:13},{wch:15},{wch:15},{wch:30} ];
  const wb = XLSX.utils.book_new();
  const periodLabel = GRADING_PERIOD_LABEL[period] || period;
  XLSX.utils.book_append_sheet(wb, ws, periodLabel.slice(0, 28));

  const fname = `${section.name} - ${section.school_year || ''} - ${section.semester || ''} - ${periodLabel}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
  XLSX.writeFile(wb, fname);
}
