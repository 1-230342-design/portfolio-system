// ══════════════════════════════════════════════════════
//  Artfolio — Classwork / Assignments
//  Google-Classroom-style "Classwork" tab: professors post
//  an assignment, students see it and attach a submission
//  directly to it. Loaded after js/app.js — reuses its
//  globals (sb, currentUser, esc, showToast, Cloudinary/
//  Imagga/similarity helpers) since both are plain classic
//  <script> tags sharing the same top-level scope.
// ══════════════════════════════════════════════════════

let _assignmentsCache        = [];   // last-loaded list of assignments (shared by both roles)
let currentAttachAssignmentId = null; // assignment the student is currently attaching work to
let attachRawFile             = null; // File object staged for that attachment

// ══════════════════════════════════════════════════════
//  SHARED — load assignments (readable by both roles)
// ══════════════════════════════════════════════════════
async function loadAssignments(){
  try{
    // Newest-posted assignment first, so a freshly-posted assignment always lands at
    // the TOP of the Classwork/Assignments list — previously this sorted by due_date
    // (soonest deadline first), so a new assignment with a later or no due date could
    // silently land near the bottom instead of showing up where the professor just put it.
    const { data, error } = await sb
      .from('assignments')
      .select('id, professor_id, title, instructions, subject_id, grading_period, due_date, created_at, subjects(name,code)')
      .order('created_at', { ascending: false });
    if(error) throw error;
    return data || [];
  }catch(err){
    console.error('loadAssignments error:', err);
    return [];
  }
}

// ══════════════════════════════════════════════════════
//  STUDENT — Classwork page
// ══════════════════════════════════════════════════════
async function loadMyAssignmentPortfolios(uid){
  try{
    const { data, error } = await sb
      .from('portfolios')
      .select('id, assignment_id, status, submitted_at, final_grade')
      .eq('student_id', uid)
      .not('assignment_id', 'is', null);
    if(error) throw error;
    return data || [];
  }catch(err){
    console.error('loadMyAssignmentPortfolios error:', err);
    return [];
  }
}

async function renderAssignmentsPage(uid){
  const el = document.getElementById('sa-list');
  if(!el || !uid) return; // fragment not in the DOM yet, or not a student session

  const [assignments, myPorts] = await Promise.all([
    loadAssignments(),
    loadMyAssignmentPortfolios(uid)
  ]);
  _assignmentsCache = assignments;

  const byAssignment = {};
  myPorts.forEach(p => { byAssignment[p.assignment_id] = p; });

  const badge = document.getElementById('assign-badge');
  if(badge){
    const notDone = assignments.filter(a => !byAssignment[a.id]).length;
    if(notDone > 0){ badge.textContent = notDone > 9 ? '9+' : notDone; badge.classList.add('show'); }
    else badge.classList.remove('show');
  }

  if(!assignments.length){
    el.innerHTML = `<div class="empty-state"><p>No classwork posted yet. Check back once your professor posts an assignment.</p></div>`;
    return;
  }

  el.innerHTML = assignments.map(a => {
    const mine   = byAssignment[a.id];
    const status = mine ? mine.status : 'none';
    const badgeCls   = status==='approved' ? 'badge-approved' : status==='rejected' ? 'badge-rejected' : (status==='submitted') ? 'badge-pending' : '';
    const badgeLabel = status==='none' ? 'Not submitted' : status==='draft' ? 'Withdrawn' : status;
    // Deadline lock — once the due date+time passes, nobody can attach
    // anything anymore (not first submissions, not resubmissions). Applies to
    // every student regardless of their own status.
    const pastDue = a.due_date && new Date(a.due_date) <= new Date();

    return `<div class="assignment-card">
      <div class="assignment-card-top">
        <div>
          <div class="assignment-title">${esc(a.title)}</div>
          <div class="assignment-meta">${a.grading_period ? esc(a.grading_period) : ''}${a.due_date ? (a.grading_period ? ' &middot; ' : '')+'Due '+fmtDateTime(a.due_date) : ''}</div>
        </div>
        <span class="upload-status-badge ${esc(badgeCls)}" style="position:static;white-space:nowrap;">${esc(badgeLabel)}</span>
      </div>
      ${a.instructions ? `<div class="assignment-instructions">${esc(a.instructions)}</div>` : ''}
      ${pastDue ? `<div class="assignment-overdue">🔒 Submissions closed — past due (${fmtDateTime(a.due_date)})</div>` : ''}
      ${(mine && mine.final_grade!=null) ? `<div class="assignment-meta" style="margin-top:8px;"><strong style="color:var(--dark)">Grade: ${mine.final_grade}/100</strong></div>` : ''}
      ${pastDue
        ? `<button class="btn-submit-work" style="margin-top:12px;opacity:.5;cursor:not-allowed;" disabled>🔒 Closed</button>`
        : `<button class="btn-submit-work" style="margin-top:12px;" onclick="openAttachWorkModal('${a.id}')">${mine ? '📎 Manage Submission' : '📎 Attach Work'}</button>`}
    </div>`;
  }).join('');
}

// ── Attach-work modal (student) ──
async function openAttachWorkModal(assignmentId){
  const a = _assignmentsCache.find(x => x.id === assignmentId);
  if(!a){ showToast('⚠️ Assignment not found'); return; }
  // Deadline lock (first line of defence — the button is already disabled,
  // but this stops anyone reaching the modal another way). Server clock wins
  // over the device clock when the hardening SQL has been run.
  if(await isAssignmentClosedNow(a)){ showToast('🔒 Submissions are closed — this assignment is past due.'); return; }
  currentAttachAssignmentId = assignmentId;
  attachRawFile = null;
  document.getElementById('aw-assignment-title').textContent = a.title;
  document.getElementById('aw-title').value = a.title;
  document.getElementById('aw-desc').value  = '';
  document.getElementById('aw-drop-text').textContent = 'Drop files here or click to upload';
  document.getElementById('attachWorkOverlay').classList.add('open');
}
function closeAttachWorkModal(){
  document.getElementById('attachWorkOverlay').classList.remove('open');
  currentAttachAssignmentId = null;
  attachRawFile = null;
}
function handleAttachFileSelect(e){
  attachRawFile = e.target.files && e.target.files[0];
  if(attachRawFile) document.getElementById('aw-drop-text').textContent = `✅ ${attachRawFile.name} selected (${formatBytes(attachRawFile.size)})`;
}
function handleAttachDrop(e){
  e.preventDefault();
  document.getElementById('aw-drop-zone').style.borderColor = 'var(--border)';
  attachRawFile = e.dataTransfer.files && e.dataTransfer.files[0];
  if(attachRawFile) document.getElementById('aw-drop-text').textContent = `✅ ${attachRawFile.name} selected (${formatBytes(attachRawFile.size)})`;
}

// Same find-or-create-portfolio pattern as saveItemToSupabase() in app.js,
// but keyed on assignment_id instead of grading_period/subject_id, so a
// student's attachments to ONE assignment always land in the same portfolio.
async function saveAssignmentSubmission(userId, assignment, payload){
  let portfolioId;
  const { data: existingPort } = await sb
    .from('portfolios').select('id, status')
    .eq('student_id', userId).eq('assignment_id', assignment.id).maybeSingle();

  if(existingPort){
    portfolioId = existingPort.id;
    // Re-submitting to an already-approved/rejected portfolio sends it back to review.
    if(existingPort.status !== 'submitted'){
      await sb.from('portfolios').update({
        status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq('id', portfolioId);
    }
  } else {
    const newPortData = {
      student_id: userId, assignment_id: assignment.id,
      status: 'submitted', submitted_at: new Date().toISOString(),
      grading_period: assignment.grading_period || null
    };
    if(assignment.subject_id) newPortData.subject_id = assignment.subject_id;
    const { data: newPort, error: pe } = await sb.from('portfolios').insert([newPortData]).select().single();
    if(pe) throw pe;
    portfolioId = newPort.id;
  }

  const itemRow = {
    portfolio_id: portfolioId, title: payload.title, description: payload.desc,
    file_url: payload.fileUrl, file_type: payload.fileType || 'application/octet-stream',
    file_size_bytes: payload.fileSize, is_watermarked: false,
    phash: payload.phash || null,
    imagga_tags: (payload.imaggaTags && payload.imaggaTags.length) ? payload.imaggaTags : null,
    cloudinary_public_id: payload.cloudinaryId || null, uploaded_at: new Date().toISOString()
  };
  if(payload.embedding) itemRow.embedding = payload.embedding; // only sent when the AI comparison produced one
  if(payload.sha256) itemRow.sha256 = payload.sha256; // needs supabase-integrity-hardening.sql — retried without it below
  let { data: item, error: ie } = await sb.from('portfolio_items').insert([itemRow]).select().single();
  if(ie && payload.sha256 && /sha256/i.test(ie.message || '')){
    console.info('[save] sha256 column missing — run supabase-integrity-hardening.sql. Saving without the exact-file fingerprint.');
    delete itemRow.sha256;
    ({ data: item, error: ie } = await sb.from('portfolio_items').insert([itemRow]).select().single());
  }
  if(ie) throw ie;

  return { item, portfolioId };
}

// Deadline truth from the DATABASE clock (supabase-integrity-hardening.sql).
// Returns true = open, false = closed, null = unknown (SQL not run yet —
// callers fall back to the device clock). Kills rewound-laptop-clock tricks
// for the UI; the RLS policy behind it kills them for real.
async function isAssignmentOpenServer(assignmentId){
  if(!assignmentId) return null;
  try{
    const { data, error } = await sb.rpc('is_assignment_open', { p_assignment_id: assignmentId });
    if(error) throw error;
    return data === true;
  }catch(e){
    return null;
  }
}
// One combined verdict: server truth wins when available, device clock otherwise.
async function isAssignmentClosedNow(assignment){
  if(!assignment || !assignment.due_date) return false;
  const serverOpen = await isAssignmentOpenServer(assignment.id);
  if(serverOpen === true) return false; // server says open — trust it over a wrong device clock
  if(serverOpen === false) return true; // server says closed — rewound clocks can't help
  return new Date(assignment.due_date) <= new Date();
}

async function submitAttachedWork(){
  if(!currentUser){ showToast('⚠️ Please sign in first'); return; }
  if(!currentAttachAssignmentId){ showToast('⚠️ No assignment selected'); return; }
  const assignment = _assignmentsCache.find(a => a.id === currentAttachAssignmentId);
  if(!assignment){ showToast('⚠️ Assignment not found'); return; }
  // Deadline lock (last line of defence — catches the case where the cutoff
  // passed while the student had the modal open). Server clock wins.
  if(await isAssignmentClosedNow(assignment)){
    closeAttachWorkModal();
    showToast('🔒 Submissions are closed — this assignment is past due.');
    return;
  }

  const title = document.getElementById('aw-title').value.trim();
  const desc  = document.getElementById('aw-desc').value.trim();
  if(!title){ showToast('⚠️ Please enter a title'); return; }
  if(!attachRawFile){ showToast('⚠️ Please select a file to attach'); return; }

  try{
    // BLOCK-BEFORE-UPLOAD: fingerprint the file locally (dHash + AI embedding)
    // and run the 90%+ originality check BEFORE anything is uploaded to
    // Cloudinary or saved to the database — so a duplicate never leaves the
    // student's browser. The block check deliberately ignores Imagga tags
    // (see SIMILARITY_BLOCK_THRESHOLD in app.js), so no Cloudinary URL is
    // needed for this step.
    const attachKind = (typeof similarityKindLabel === 'function') ? similarityKindLabel(attachRawFile.type) : 'image';
    showToast(attachKind === 'video' ? '🎬 Comparing video content…' : attachKind === 'image' ? '🧠 Comparing image content…' : '🧠 Comparing file content…');
    const [ourPhash, embedding, ourSha256] = await Promise.all([
      computePerceptualHash(attachRawFile),
      (typeof embFromFile === 'function') ? embFromFile(attachRawFile) : Promise.resolve(null),
      computeSha256(attachRawFile) // exact-file fingerprint — catches PDFs/ZIPs/etc too
    ]);

    // Play the same originality-check scanning animation used by the regular
    // Upload Work flow (app.js) — blocks outright at 90%+ similarity, so
    // Classwork attachments can't be used to route around it.
    const isDuplicate = await runOriginalityCheckUI(ourPhash, [], assignment.id, embedding, currentUser.id, ourSha256, attachKind);
    if(isDuplicate){
      attachRawFile = null;
      document.getElementById('aw-drop-text').textContent = 'Drop files here or click to upload';
      return;
    }

    // Clear — now upload to Cloudinary, then fetch Imagga tags for the
    // post-save professor flag (tags never block, they only inform review).
    const cloud = await uploadToCloudinary(attachRawFile);
    showToast('🏷️ Analyzing image content…');
    const imaggaTags = (attachRawFile.type && attachRawFile.type.startsWith('image/')) ? await fetchImaggaTags(cloud.url) : [];

    showToast('💾 Saving submission…');
    const { item } = await saveAssignmentSubmission(currentUser.id, assignment, {
      title, desc, fileUrl: cloud.url, fileType: attachRawFile.type,
      fileSize: attachRawFile.size, cloudinaryId: cloud.publicId, phash: ourPhash, imaggaTags, embedding,
      sha256: ourSha256
    });
    runSimilarityCheck(item.id, ourPhash, imaggaTags, embedding, assignment.id, currentUser.id);

    closeAttachWorkModal();
    showToast('✅ Work attached and submitted!');
    await loadProjectsForStudent(currentUser.id); // also refreshes My Projects/grades automatically
    refreshStudentViews();
  }catch(err){
    console.error('submitAttachedWork error:', err);
    // A row-level-security rejection on the portfolio insert means the
    // database-clock deadline policy fired (closed assignment) — say so
    // plainly instead of showing raw RLS wording.
    if(/row-level security/i.test(err.message || '')){
      closeAttachWorkModal();
      showToast('🔒 Submissions are closed — this assignment is past due.');
      return;
    }
    showToast('❌ Submission failed: '+err.message);
  }
}

// ══════════════════════════════════════════════════════
//  PROFESSOR — Assignments page
// ══════════════════════════════════════════════════════
async function loadAssignmentSubmissionCounts(){
  try{
    const { data, error } = await sb.from('portfolios').select('assignment_id, status').not('assignment_id', 'is', null);
    if(error) throw error;
    const counts = {};
    (data || []).forEach(r => {
      if(!counts[r.assignment_id]) counts[r.assignment_id] = { total: 0, submitted: 0 };
      counts[r.assignment_id].total++;
      if(r.status === 'submitted') counts[r.assignment_id].submitted++;
    });
    return counts;
  }catch(err){
    console.error('loadAssignmentSubmissionCounts error:', err);
    return {};
  }
}

async function renderProfAssignmentsPage(){
  const el = document.getElementById('pa-list');
  if(!el) return;

  const [assignments, counts] = await Promise.all([loadAssignments(), loadAssignmentSubmissionCounts()]);
  _assignmentsCache = assignments;

  if(!assignments.length){
    el.innerHTML = `<div class="empty-state"><p>No assignments posted yet. Click "+ New Assignment" to post your first one.</p></div>`;
    return;
  }

  el.innerHTML = assignments.map(a => {
    const c = counts[a.id] || { total: 0, submitted: 0 };
    const mine = a.professor_id === (currentUser && currentUser.id);
    return `<div class="assignment-card">
      <div class="assignment-card-top">
        <div>
          <div class="assignment-title">${esc(a.title)}</div>
          <div class="assignment-meta">${a.grading_period ? esc(a.grading_period) : ''}${a.due_date ? (a.grading_period ? ' &middot; ' : '')+'Due '+fmtDateTime(a.due_date) : ''}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="btn-view-sm" onclick="toggleAssignmentSubmissions('${a.id}')">👁 ${c.total} Submission${c.total===1?'':'s'}</button>
          ${mine ? `<button class="btn-cancel" style="padding:8px 12px;" onclick="deleteAssignment('${a.id}')">🗑️</button>` : ''}
        </div>
      </div>
      ${a.instructions ? `<div class="assignment-instructions">${esc(a.instructions)}</div>` : ''}
      <div class="assignment-submissions-panel" id="pa-panel-${a.id}"></div>
    </div>`;
  }).join('');
}

async function toggleAssignmentSubmissions(assignmentId){
  const panel = document.getElementById('pa-panel-'+assignmentId);
  if(!panel) return;
  const isOpen = panel.classList.contains('open');
  document.querySelectorAll('.assignment-submissions-panel.open').forEach(p => p.classList.remove('open'));
  if(isOpen) return; // clicking an already-open panel just closes it

  panel.classList.add('open');
  panel.innerHTML = `<div style="font-size:13px;color:var(--text3);">Loading submissions…</div>`;
  if(!_profItems || !_profItems.length) _profItems = await loadAllItemsForProfessor();
  const items = _profItems.filter(p => p.assignmentId === assignmentId && p.status !== 'draft'); // withdrawn/personal stays private
  panel.innerHTML = items.length
    ? `<div class="submissions-list">${items.map(submissionItemHtml).join('')}</div>`
    : `<div style="font-size:13px;color:var(--text3);">No submissions yet for this assignment.</div>`;
}

// ── Create-assignment modal (professor) ──
function openCreateAssignmentModal(){
  document.getElementById('ca-title').value = '';
  document.getElementById('ca-instructions').value = '';
  document.getElementById('ca-due').value = '';
  document.getElementById('ca-period').value = '';
  document.getElementById('createAssignmentOverlay').classList.add('open');
}
function closeCreateAssignmentModal(){
  document.getElementById('createAssignmentOverlay').classList.remove('open');
}

async function createAssignment(){
  if(!currentUser){ showToast('⚠️ Please sign in first'); return; }
  const title         = document.getElementById('ca-title').value.trim();
  const instructions  = document.getElementById('ca-instructions').value.trim();
  const gradingPeriod = document.getElementById('ca-period').value || null;
  const dueRaw        = document.getElementById('ca-due').value;
  const dueDate       = dueRaw ? new Date(dueRaw).toISOString() : null;
  if(!title){ showToast('⚠️ Please enter an assignment title'); return; }

  showToast('💾 Posting assignment…');
  try{
    // This school only has one subject (Multimedia Arts), so we don't ask the
    // professor to pick one — just reuse the same auto-resolved subject the
    // student Upload flow already uses (defaultSubjectId, set in app.js).
    const insertData = { professor_id: currentUser.id, title, instructions: instructions || null, grading_period: gradingPeriod, due_date: dueDate };
    if(typeof defaultSubjectId !== 'undefined' && defaultSubjectId) insertData.subject_id = defaultSubjectId;
    const { error } = await sb.from('assignments').insert([insertData]);
    if(error) throw error;
    closeCreateAssignmentModal();
    showToast('✅ Assignment posted!');
    renderProfAssignmentsPage();
  }catch(err){
    console.error('createAssignment error:', err);
    showToast('❌ Error: '+err.message);
  }
}

async function deleteAssignment(id){
  if(!confirm('Delete this assignment? This ALSO permanently deletes every student submission attached to it — they will disappear from the students\' Classwork, My Projects, and grades. This cannot be undone.')) return;
  try{
    showToast('🗑️ Deleting assignment and its submissions…');
    // Find every student portfolio attached to this assignment, so the
    // assignment vanishes from the students' dashboards too — not just from
    // the professor's list. Previously these rows were left behind, so
    // students kept seeing orphaned submissions for a deleted assignment.
    const { data: ports, error: portErr } = await sb.from('portfolios').select('id').eq('assignment_id', id);
    if(portErr) throw portErr;
    const portIds = (ports || []).map(p => p.id);

    if(portIds.length){
      const { data: items } = await sb.from('portfolio_items').select('id, cloudinary_public_id').in('portfolio_id', portIds);
      const itemIds = (items || []).map(i => i.id);

      if(itemIds.length){
        // FK rows first, otherwise the item delete is rejected.
        await sb.from('similarity_logs').delete().in('checked_item_id', itemIds);
        await sb.from('similarity_logs').delete().in('matched_item_id', itemIds);
        const { error: itemErr } = await sb.from('portfolio_items').delete().in('portfolio_id', portIds);
        if(itemErr) throw itemErr;
        // Best-effort Cloudinary cleanup — never fails the whole delete.
        (items || []).forEach(it => {
          if(it.cloudinary_public_id) sb.functions.invoke('delete-cloudinary-asset', { body: { publicId: it.cloudinary_public_id } }).catch(()=>{});
        });
      }
      await sb.from('feedback').delete().in('portfolio_id', portIds);
      const { error: delPortErr } = await sb.from('portfolios').delete().in('id', portIds);
      if(delPortErr) throw delPortErr;
    }

    const { error } = await sb.from('assignments').delete().eq('id', id);
    if(error) throw error;
    showToast('🗑️ Assignment and its submissions deleted.');
    renderProfAssignmentsPage();
  }catch(err){
    console.error('deleteAssignment error:', err);
    showToast('❌ Error: '+err.message);
  }
}