// ══════════════════════════════════════════════════════
//  Artfolio — Application Logic
//  Web-Based Portfolio Management System for
//  Multimedia Arts Students (ASIATECH)
//
//  Handles: auth, student dashboard/upload/projects,
//  professor review/grading/rankings, Supabase + Cloudinary.
//  Boots once js/loader.js finishes injecting all pages
//  (see the "artfolio:ready" listener at the bottom).
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════
const SUPABASE_URL    = 'https://hqupvkevnsioxmiszytd.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_m_eNY9jBAa3AlofPTSEmiA_2ujoSo0T';
const CLOUDINARY_CLOUD  = 'drrel1ee7';
const CLOUDINARY_PRESET = 'portfolio_upload';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── EmailJS (review-decision notifications) ──
const EMAILJS_PUBLIC_KEY  = 'VrNccoTJpqBpWuw08';
const EMAILJS_SERVICE_ID  = 'service_ht8hu26';
const EMAILJS_TEMPLATE_ID = 'template_qnkvctd';
if(typeof emailjs !== 'undefined') emailjs.init(EMAILJS_PUBLIC_KEY);

// ── CUSTOM SIGNUP OTP (via EmailJS, not Supabase Auth) ──
// Supabase's own "Confirm email" flow sends through Supabase's built-in mailer,
// which is capped very low on the free tier — fine for a handful of test
// signups, not fine for many real signups a day. This generates and emails
// the code ourselves via EmailJS (same account as the review-notification
// email above, just a second template) and only creates the actual Supabase
// account (sb.auth.signUp) AFTER that code is verified.
// SETUP REQUIRED (one-time, both in dashboards — no code changes needed after):
//   1. In Supabase Dashboard → Authentication → Sign In / Providers → Email,
//      turn "Confirm email" OFF. Otherwise Supabase ALSO tries to send its
//      own confirmation email on top of this one, and you're back to its limit.
//   2. In Supabase SQL Editor, create the otp_codes table (see project notes /
//      the SQL provided alongside this file).
//   3. In EmailJS, create a second email template (separate from the review-
//      notification one) with template variables {{to_email}} and {{code}},
//      then paste its Template ID below.
const EMAILJS_OTP_TEMPLATE_ID = 'template_XXXXXXX'; // ← replace with your new OTP template's ID

function generateOtpCode(){
  return String(Math.floor(10000000 + Math.random()*90000000)); // 8 digits — matches the 8 otp-box inputs already in the UI
}

// Creates a row in otp_codes (5-minute expiry) and emails the code via EmailJS.
// Returns true on success; callers show their own toast on failure.
async function sendCustomOtp(email){
  const code      = generateOtpCode();
  const expiresAt = new Date(Date.now() + 5*60*1000).toISOString();
  try{
    const { error: dbErr } = await sb.from('otp_codes').insert([{ email, code, expires_at: expiresAt }]);
    if(dbErr) throw dbErr;
    if(typeof emailjs === 'undefined') throw new Error('EmailJS not loaded');
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_OTP_TEMPLATE_ID, { to_email: email, code });
    return true;
  }catch(err){
    console.error('sendCustomOtp error:', err);
    return false;
  }
}

// Checks the typed code against the most recent unused, unexpired row for
// that email, and marks it used on success so it can't be replayed.
async function verifyCustomOtp(email, code){
  try{
    const { data, error } = await sb.from('otp_codes')
      .select('id, expires_at')
      .eq('email', email).eq('code', code).eq('used', false)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if(error) throw error;
    if(!data) return false;
    if(new Date(data.expires_at) < new Date()) return false;
    await sb.from('otp_codes').update({ used: true }).eq('id', data.id);
    return true;
  }catch(err){
    console.error('verifyCustomOtp error:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════
let currentUser        = null;  // Supabase auth user
let currentProfile     = null;  // user_profiles row
let studentProjects    = {};    // cache: userId → [items]
let currentReview      = null;  // { itemId, portfolioId }
let allStudentProfiles = [];    // professor view cache
let _profItems         = [];    // all portfolio_items for professor
let pendingRawFile     = null;  // File object for Cloudinary
let pendingUploadFile  = null;  // preview metadata
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
let allSubjectsCache    = [];   // cache of subjects, used for dropdown + category name lookups
// dHash similarity between two UNRELATED images naturally averages ~50% purely by
// chance (each of the 64 gradient bits differs roughly at random for uncorrelated
// content) — it is not a "0% = different, 100% = same" linear scale. Only genuine
// near-duplicates (the same image re-uploaded, resized, cropped, or recompressed)
// reliably land in the 85-100% range. Thresholds below ~80% mostly just flag noise,
// which is why an unrelated photo was previously showing up as a "56% match."
const SIMILARITY_LOG_THRESHOLD  = 0.85; // log a match only if 85%+ visually similar
const SIMILARITY_FLAG_THRESHOLD = 0.93; // strong plagiarism warning at 93%+
// A high visual match means this is basically the same image already in the
// system — instead of just flagging it for the professor like
// SIMILARITY_FLAG_THRESHOLD does, this level blocks the submission outright
// so it never gets saved at all. Lowered from 0.999 to 0.90 on request.
// IMPORTANT: the block check (findBestSimilarityMatch, below) deliberately
// looks at the dHash VISUAL score only, not the Imagga tag-overlap score.
// Two different pieces that just share a lot of tags (e.g. the same drawn
// character holding a different prop) can score high on tag overlap without
// being the same image — blocking on that signal would auto-reject
// legitimate different work. Tag overlap still feeds the post-save
// similarity FLAG shown to the professor (runSimilarityCheck, further
// down) — it just no longer blocks the upload by itself.
const SIMILARITY_BLOCK_THRESHOLD = 0.90;
// Bump this whenever the gate logic changes (keep in sync with the ?v=
// cache-buster on the <script> tags in index.html). Printed to the console on
// every page load so anyone can verify in F12 whether the browser is actually
// running the pre-upload block or a stale cached copy without it.
const ORIGINALITY_GATE_VERSION = 'v3-preupload-rpc';

// ── PROFESSOR PERMISSIONS ──
// Only professors from this department get full grading + approve/reject power.
// Every other professor department is "reviewer only": they can view submissions,
// leave a star rating, and comment, but cannot grade or change a submission's status.
const FULL_ACCESS_DEPARTMENT = 'BS Information Technology Major in Multimedia Arts';
function isFullProfessor(){
  return !!(currentProfile && (currentProfile.role === 'professor' || currentProfile.role === 'admin') && currentProfile.department === FULL_ACCESS_DEPARTMENT);
}

// ── EDIT PROFILE: skills catalog + state ──
const ALL_SKILLS = [
  'Content Creation','Photo Editing','Illustration','Digital Painting','Typography','Web Design',
  '2D Animation','3D Modeling','VFX','Storyboarding','UI/UX Design','Cinematography','Sound Design',
  'Audio Editing','Music Production','Portrait Photography','Product Photography',
  'Event Photography','Landscape Photography'
];
let editSkills = []; // skills currently selected inside the Edit Profile modal

const AVATAR_COLORS = ['#2f6f75','#c2452d','#2d7d5a','#a8763e','#3a6ea5','#8a3e6e','#4c6b8a','#c0862f'];
// Deterministic color per name so the same person always gets the same
// avatar color across the app (sidebar, rankings, student rows, etc.)
// instead of every single initial-avatar being the same flat blue.
function avatarColor(name){
  const str = (name||'?').trim() || '?';
  let hash = 0;
  for(let i=0;i<str.length;i++){ hash = str.charCodeAt(i) + ((hash<<5)-hash); }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ══════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════
function esc(s){ return (s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Masks the first 3 DIGITS of a student number for public-facing pages (no login required),
// e.g. "1 - 230371" -> "• - ••0371". Dashes/spaces are left alone so the format still reads
// the same. Returns null if there's no id at all, so callers can pick their own fallback text.
function maskStudentId(id){
  if(!id) return null;
  let seen = 0;
  return id.replace(/\d/g, d => (++seen <= 3) ? '•' : d);
}
function fmtDate(iso){ return iso ? new Date(iso).toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'numeric'}) : '—'; }
// Assignment deadlines carry a time too (datetime-local picker), so they get
// their own formatter — e.g. "9/25/2026, 2:30 PM".
function fmtDateTime(iso){ return iso ? new Date(iso).toLocaleString('en-US',{month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : '—'; }
function formatBytes(b){ if(b<1024)return b+' B'; if(b<1024*1024)return (b/1024).toFixed(1)+' KB'; return (b/1024/1024).toFixed(1)+' MB'; }
function fileIsImage(f){
  if(!f||!f.dataUrl) return false;
  return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(f.dataUrl)||(f.mimeType&&f.mimeType.startsWith('image/'));
}
function fileIsVideo(f){
  if(!f||!f.dataUrl) return false;
  return /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|$)/i.test(f.dataUrl)||(f.mimeType&&f.mimeType.startsWith('video/'));
}
function readFileAsDataUrl(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(new Error('read failed')); r.readAsDataURL(file); });
}
function go(id){
  const el = document.getElementById(id);
  if(!el){
    console.error(`go('${id}') aborted: no element with id="${id}" found in the DOM. The matching page fragment likely hasn't finished loading yet.`);
    return;
  }
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  el.classList.add('active');
  window.scrollTo(0,0);
}
function showToast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3500); }
// Toggle a password input between hidden/visible, swapping the eye icon (open ↔ slashed).
// Reusable for any password field — just pass the input's id and the button that was clicked.
function togglePasswordVisibility(inputId, btnEl){
  const input = document.getElementById(inputId);
  if(!input) return;
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  if(btnEl){
    btnEl.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
    btnEl.innerHTML = showing
      ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.86 21.86 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.86 21.86 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }
}
// Supabase returns "Invalid login credentials" for both wrong email AND wrong
// password (it never says which, for security) — show one clear, friendly
// message for that case instead of the raw Supabase wording. Other auth
// errors (e.g. email not confirmed, rate limited) still show their real message.
function loginErrorMessage(error){
  const msg = (error && error.message) || '';
  if(/invalid login credentials/i.test(msg)) return 'Invalid email or Password please try again.';
  return msg || 'Something went wrong. Please try again.';
}

// ══════════════════════════════════════════════════════
//  AVATARS — initial letter of the account's name
// ══════════════════════════════════════════════════════
function setAvatar(containerId, name){
  const el = document.getElementById(containerId);
  if(!el) return;
  const firstName = (name||'').trim().split(/\s+/)[0] || '';
  const match = firstName.match(/[A-Za-z]/); // first actual letter, skipping numbers/dashes
  const letter = match ? match[0].toUpperCase() : '?';
  el.innerHTML = `<div class="avatar-initial" style="background:${avatarColor(name)}">${esc(letter)}</div>`;
}

// ══════════════════════════════════════════════════════
//  PORTFOLIO HEADER — Student ID, Section/Year, Social Link, Skills, Avatar
// ══════════════════════════════════════════════════════
function renderPortfolioHeader(){
  if(!currentProfile) return;
  const nameEl = document.getElementById('s-portfolio-name');
  if(nameEl) nameEl.textContent = currentProfile.full_name || '';

  const metaEl = document.getElementById('s-portfolio-meta');
  if(metaEl){
    const lines = [];
    lines.push(esc(currentProfile.student_id || 'Student ID not set'));
    const secYear = [currentProfile.section, currentProfile.year_level].filter(Boolean).join(' &nbsp;·&nbsp; ');
    lines.push(secYear || 'Section &nbsp;·&nbsp; Year Level');
    if(currentProfile.social_link){
      lines.push(`<a href="${esc(currentProfile.social_link)}" target="_blank" rel="noopener">${esc(currentProfile.social_link)}</a>`);
    } else {
      lines.push('<span style="opacity:.6">No social link added</span>');
    }
    metaEl.innerHTML = lines.join('<br>');
  }

  const skillsEl = document.getElementById('s-portfolio-skills');
  if(skillsEl){
    const skills = Array.isArray(currentProfile.skills) ? currentProfile.skills : [];
    skillsEl.innerHTML = skills.length
      ? skills.map(sk=>`<span class="skill-pill">${esc(sk)}</span>`).join('')
      : `<span class="skill-pill" style="opacity:.6">No skills added yet</span>`;
  }

  setAvatar('s-portfolio-avatar', currentProfile.full_name);
  setAvatar('s-sidebar-avatar', currentProfile.full_name);
}

// ══════════════════════════════════════════════════════
//  EDIT PROFILE MODAL
// ══════════════════════════════════════════════════════
function openEditProfile(){
  if(!currentProfile){ showToast('⚠️ Please log in first.'); return; }
  document.getElementById('ep-fullname').value   = currentProfile.full_name || '';
  document.getElementById('ep-section').value    = currentProfile.section || '';
  document.getElementById('ep-year').value       = currentProfile.year_level || '';
  document.getElementById('ep-social').value     = currentProfile.social_link || '';
  editSkills = Array.isArray(currentProfile.skills) ? [...currentProfile.skills] : [];
  renderSkillChips();
  renderSkillPicker();
  document.getElementById('ep-skill-picker').style.display = 'none';
  document.getElementById('editProfileOverlay').classList.add('open');
}
function closeEditProfile(){
  document.getElementById('editProfileOverlay').classList.remove('open');
}
function renderSkillChips(){
  const el = document.getElementById('ep-skill-chips');
  el.innerHTML = editSkills.length
    ? editSkills.map(sk=>`<span class="skill-chip">${esc(sk)}<button type="button" onclick="removeSkill('${esc(sk)}')">✕</button></span>`).join('')
    : `<span style="font-size:12px;color:var(--text3)">No skills added yet.</span>`;
}
function renderSkillPicker(){
  const el = document.getElementById('ep-skill-picker');
  el.innerHTML = ALL_SKILLS.map(sk=>{
    const picked = editSkills.includes(sk);
    return `<div class="skill-picker-item ${picked?'picked':''}" onclick="toggleSkill('${esc(sk)}')">${picked?'✓ ':''}${esc(sk)}</div>`;
  }).join('');
}
function toggleSkillPicker(){
  const el = document.getElementById('ep-skill-picker');
  el.style.display = (el.style.display === 'none' || !el.style.display) ? 'grid' : 'none';
}
function toggleSkill(sk){
  if(editSkills.includes(sk)) editSkills = editSkills.filter(s=>s!==sk);
  else editSkills.push(sk);
  renderSkillChips();
  renderSkillPicker();
}
function removeSkill(sk){
  editSkills = editSkills.filter(s=>s!==sk);
  renderSkillChips();
  renderSkillPicker();
}
async function saveProfileEdits(){
  if(!currentUser){ showToast('⚠️ Please log in first.'); return; }
  const full_name   = document.getElementById('ep-fullname').value.trim();
  const section     = document.getElementById('ep-section').value.trim();
  const year_level  = document.getElementById('ep-year').value;
  const social_link = document.getElementById('ep-social').value.trim();
  if(!full_name){ showToast('⚠️ Please enter your full name.'); return; }
  showToast('💾 Saving profile…');
  const { error } = await sb.from('user_profiles').update({
    full_name, section, year_level, social_link, skills: editSkills
  }).eq('user_id', currentUser.id);
  if(error){ showToast('❌ '+error.message); return; }
  currentProfile.full_name   = full_name;
  currentProfile.section     = section;
  currentProfile.year_level  = year_level;
  currentProfile.social_link = social_link;
  currentProfile.skills      = editSkills;
  const firstName = full_name.split(' ')[0] || 'Student';
  document.getElementById('s-sidebar-name').textContent = full_name;
  document.getElementById('s-welcome-name').textContent = 'Welcome Back, '+firstName+'!';
  renderPortfolioHeader();
  closeEditProfile();
  showToast('✅ Profile updated!');
}

// ══════════════════════════════════════════════════════
//  SUPABASE HELPERS  — mapped to YOUR real schema
// ══════════════════════════════════════════════════════

// AUTH
async function getProfile(userId){
  const { data } = await sb.from('user_profiles').select('*').eq('user_id', userId).maybeSingle();
  return data;
}

// Load portfolio items for a student
// Schema: portfolio_items → portfolios (via portfolio_id) → subjects (via subject_id)
async function loadProjectsForStudent(userId){
  // NOTE: intentionally no cache short-circuit here — always fetch fresh so
  // approvals/rejections/grades from the professor show up without the
  // student needing to log out and back in.
  try{
    // Step 1: get all portfolios belonging to this student
    const { data: portfolios, error: pe } = await sb
      .from('portfolios')
      .select('id, grading_period, status, submitted_at, approved_at, updated_at, title, description, subject_id, assignment_id, rating, creativity_score, technique_score, composition_score, final_grade, grade_remarks, graded_at, subjects(id,name,code)')
      .eq('student_id', userId);
    if(pe) throw pe;

    if(!portfolios || portfolios.length === 0){ studentProjects[userId]=[]; return []; }

    const portIds = portfolios.map(p=>p.id);

    // Step 2: get all items in those portfolios
    const { data: items, error: ie } = await sb
      .from('portfolio_items')
      .select('id, portfolio_id, title, description, file_url, file_type, file_size_bytes, is_watermarked, cloudinary_public_id, is_public, uploaded_at')
      .in('portfolio_id', portIds)
      .order('uploaded_at', { ascending: false });
    if(ie) throw ie;

    // Step 2b: get latest feedback comment per portfolio (professor's remarks on approve/reject)
    let feedbackMap = {};
    try{
      const { data: feedbackRows } = await sb
        .from('feedback')
        .select('portfolio_id, comment, created_at')
        .in('portfolio_id', portIds)
        .order('created_at', { ascending: false });
      (feedbackRows||[]).forEach(f=>{ if(!feedbackMap[f.portfolio_id]) feedbackMap[f.portfolio_id]=f.comment; });
    }catch(fbErr){ console.error('feedback load error:', fbErr); }

    // Step 3: map items, joining portfolio info
    const portMap = {};
    portfolios.forEach(p=>{ portMap[p.id]=p; });

    studentProjects[userId] = (items||[]).map(item=>{
      const port = portMap[item.portfolio_id] || {};
      const subj = port.subjects || {};
      return {
        id:            item.id,
        portfolioId:   item.portfolio_id,
        title:         item.title,
        desc:          item.description,
        category:      subj.name || subj.code || 'General',
        subjectName:   subj.name || '',
        gradingPeriod: port.grading_period || '',
        assignmentId:  port.assignment_id || null,
        status:        port.status || 'draft',
        file:{ name: item.title, dataUrl: item.file_url, mimeType: item.file_type, sizeBytes: item.file_size_bytes, isCloudinary:true },
        submittedAt:   port.submitted_at || item.uploaded_at,
        watermarked:   item.is_watermarked,
        isPublic:      item.is_public || false,
        cloudinaryPublicId: item.cloudinary_public_id || null,
        rating:        port.rating || 0,
        creativityScore:   port.creativity_score,
        techniqueScore:    port.technique_score,
        compositionScore:  port.composition_score,
        finalGrade:        port.final_grade,
        gradeRemarks:      port.grade_remarks,
        gradedAt:          port.graded_at,
        feedbackComment:   feedbackMap[port.id] || '',
        decisionAt:        port.status==='approved' ? (port.approved_at||port.updated_at) : (port.updated_at||port.submitted_at),
        comment: ''
      };
    });
  }catch(err){
    console.error('loadProjects error:', err);
    studentProjects[userId] = [];
  }
  return studentProjects[userId];
}

// Upload to Cloudinary
async function uploadToCloudinary(file){
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_PRESET);
  fd.append('folder', 'artfolio');
  
  showToast('☁️ Uploading to Cloudinary…');
  const res  = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`,{ method:'POST', body:fd });
  const data = await res.json();
  if(data.error) throw new Error(data.error.message);
  return { url: data.secure_url, publicId: data.public_id, bytes: data.bytes, format: data.format };
}

// ══════════════════════════════════════════════════════
//  IMAGE SIMILARITY — perceptual hash computed client-side
//  Note: Cloudinary's `phash` field is only returned for authenticated/signed
//  uploads, not for unsigned upload-preset uploads (like the one above), so it
//  is never actually populated in this app. Instead we compute a standard
//  64-bit difference hash (dHash) ourselves from the raw file before upload,
//  using a canvas — this needs no server, no signed API calls, and produces a
//  hex string the same length/format the rest of the similarity code expects.
// ══════════════════════════════════════════════════════
function loadImageFromFile(file){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = ()=>{ URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e)=>{ URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function computePerceptualHash(file){
  if(!file || !file.type || !file.type.startsWith('image/')) return null; // only images can be hashed this way
  try{
    const img = await loadImageFromFile(file);
    const w = 9, h = 8; // 9 columns so we get 8 horizontal comparisons per row = 64 bits total
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const gray = [];
    for(let i=0;i<data.length;i+=4){
      gray.push(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
    }

    let bits = '';
    for(let row=0; row<h; row++){
      for(let col=0; col<w-1; col++){
        bits += (gray[row*w+col] > gray[row*w+col+1]) ? '1' : '0';
      }
    }
    // bits.length === 64 → pack into 16 hex characters
    let hex = '';
    for(let i=0;i<bits.length;i+=4){
      hex += parseInt(bits.substr(i,4), 2).toString(16);
    }
    return hex;
  }catch(err){
    console.error('computePerceptualHash error:', err);
    return null;
  }
}

// Compare two Cloudinary phash hex strings → similarity score from 0 (totally different) to 1 (identical)
function phashSimilarity(hexA, hexB){
  if(!hexA || !hexB || hexA.length !== hexB.length) return 0;
  let bitsDiff = 0;
  const totalBits = hexA.length * 4;
  for(let i=0;i<hexA.length;i++){
    let x = parseInt(hexA[i],16) ^ parseInt(hexB[i],16);
    while(x){ bitsDiff += x & 1; x >>= 1; }
  }
  return 1 - (bitsDiff / totalBits);
}

// ── IMAGGA (optional second signal) ──
// Imagga's API key/secret must NEVER live in browser JS — they're held server-side
// as Supabase Edge Function secrets (IMAGGA_API_KEY / IMAGGA_API_SECRET), set via
// the dashboard Secrets panel, same pattern as CLOUDINARY_API_SECRET. The browser
// only calls our own 'imagga-tags' Edge Function, which relays the request.
// Imagga returns descriptive tags (e.g. "portrait", "sunset"), not a duplicate-image
// fingerprint — so we treat tag overlap as a *concept similarity* signal, separate
// from (and complementary to) the dHash visual-duplicate check above.
const IMAGGA_MIN_TAG_CONFIDENCE = 30; // ignore low-confidence tags below this %

async function fetchImaggaTags(imageUrl){
  try{
    const { data, error } = await sb.functions.invoke('imagga-tags', { body: { imageUrl } });
    if(error){ console.error('Imagga tags error:', error); return []; }
    return (data && data.tags) || [];
  }catch(err){
    console.error('Imagga tags error:', err);
    return []; // fail quietly — the dHash check still works on its own
  }
}

// Jaccard similarity between two tag sets (0 = no overlap, 1 = identical tag sets)
function tagSimilarity(tagsA, tagsB){
  const setA = new Set((tagsA||[]).filter(t=>t.confidence>=IMAGGA_MIN_TAG_CONFIDENCE).map(t=>(t.tag||'').toLowerCase()));
  const setB = new Set((tagsB||[]).filter(t=>t.confidence>=IMAGGA_MIN_TAG_CONFIDENCE).map(t=>(t.tag||'').toLowerCase()));
  if(setA.size===0 || setB.size===0) return 0;
  let intersection = 0;
  setA.forEach(t=>{ if(setB.has(t)) intersection++; });
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection/union : 0;
}

// Shared comparator — checks a phash/tags pair against every OTHER existing
// portfolio_items row and returns the single closest match, using the same
// "higher of visual-hash or concept-tag score" logic as runSimilarityCheck()
// below. Used BEFORE a submission is saved (submitWork / submitAttachedWork)
// so a true 100% duplicate can be blocked outright, instead of only being
// logged for the professor to notice after the fact.
async function findBestSimilarityMatch(phash, tags, excludeItemId, assignmentId, embedding, ownerStudentId){
  if(!phash && !embedding) return { bestScore: 0, best: null }; // nothing to compare without a phash or an AI fingerprint
  try{
    // Pull the AI fingerprint column too, when this upload actually has one and the
    // column exists — previously this block check NEVER looked at the AI embedding at
    // all, only the raw pixel hash, so a submission the AI recognised as "same subject,
    // different background" (90%+) sailed straight through and got saved anyway. The
    // AI score was only ever used AFTER saving, to flag it for a professor to notice.
    const useAI = !!embedding && (typeof embeddingColumnAvailable === 'function') && await embeddingColumnAvailable();
    const targetAssignmentId = assignmentId || null;

    // PREFERRED PATH — get_similarity_fingerprints() RPC (see
    // supabase-similarity-rpc.sql, one-time setup in the SQL Editor).
    // This gate runs in the STUDENT's browser, and when RLS restricts
    // portfolio_items/portfolios to owners only, the direct table query below
    // comes back EMPTY for a student — the gate compares against 0 candidates,
    // scores 0%, and waves every duplicate through, while the professor (full
    // read access) later sees the real 99% in the Review Panel. The RPC is
    // SECURITY DEFINER so it bypasses RLS, but it only returns same-assignment
    // fingerprints excluding the uploader's own work — nothing else.
    let scoped = null;
    try{
      const { data: rpcRows, error: rpcErr } = await sb.rpc('get_similarity_fingerprints', {
        p_assignment_id: targetAssignmentId,
        p_owner_id:      ownerStudentId || null,
        p_exclude_id:    excludeItemId || null
      });
      if(!rpcErr && Array.isArray(rpcRows)){
        scoped = rpcRows.map(r => ({
          id: r.item_id, phash: r.phash, embedding: useAI ? r.embedding : null,
          title: r.title, file_url: r.file_url, file_type: r.file_type,
          portfolios: { assignment_id: r.assignment_id, student_id: r.student_id }
        }));
        console.log('[originality] gate compared via RPC against ' + scoped.length + ' submission(s).');
      } else if(rpcErr){
        console.info('[originality] similarity RPC not available yet — run supabase-similarity-rpc.sql in the SQL Editor. Falling back to direct query. (' + (rpcErr.message || rpcErr) + ')');
      }
    }catch(rpcEx){
      console.info('[originality] similarity RPC failed — falling back to direct query.', rpcEx);
    }

    if(!scoped){
      // FALLBACK PATH — direct table read. Works for professors / open RLS,
      // but is typically BLIND for students under owner-only RLS (returns no
      // other-student rows). Kept so the gate still functions before the SQL
      // setup above is run.
      let query = sb.from('portfolio_items').select('id, phash, imagga_tags, title, file_url, file_type, portfolios(assignment_id, student_id)' + (useAI ? ', embedding' : ''));
      if(excludeItemId) query = query.neq('id', excludeItemId);
      const { data: others, error } = await query;
      if(error || !others || others.length === 0){
        console.warn('[originality] gate saw 0 existing submissions — nothing to compare against (if duplicates keep slipping through, this empty read is why: check RLS / run supabase-similarity-rpc.sql).');
        return { bestScore: 0, best: null };
      }

      // Only compare against submissions attached to the SAME assignment. A
      // plain "Upload Work" (no assignment — assignmentId is null) is only
      // compared against other plain uploads, never against a different
      // assignment's submissions, so unrelated classwork can't false-positive
      // against each other just for existing in the same system.
      //
      // Also excludes the SAME student's own other items (e.g. a withdrawn
      // submission still sitting in the table with status='draft'). Without this,
      // unsubmitting and then re-attaching the exact same file matched the
      // student's own earlier copy at ~100% and got blocked as "plagiarism" of
      // themselves — resubmitting your own work should never be flagged at all.
      scoped = others.filter(o => {
        const port = o.portfolios || {};
        if(ownerStudentId && port.student_id === ownerStudentId) return false;
        return (port.assignment_id || null) === targetAssignmentId;
      });
      console.log('[originality] gate compared via direct query against ' + scoped.length + ' submission(s).');
    }

    if(!scoped.length){
      console.warn('[originality] gate found no submissions in the same scope — passing (if this is wrong, check RLS / run supabase-similarity-rpc.sql).');
      return { bestScore: 0, best: null };
    }

    // CRITICAL: an older submission may not have its AI fingerprint yet — that
    // backfill normally only happens quietly in the background once a PROFESSOR
    // logs in (embWarmUp, js/similarity-ai.js). A student can submit before any
    // professor has opened the app since that other work was uploaded, so without
    // this, the block check would silently fall back to the basic pixel hash only
    // for that comparison, MISS an AI-detected match (same subject, different
    // background/crop), let the upload through — and only show the real % once a
    // professor's review backfills it later. That's exactly the "got through
    // unblocked, but the Review Panel shows 99%" bug. So: compute any missing
    // fingerprints for this (small, assignment-scoped) comparison set right now,
    // before deciding, so the block check sees the same picture a professor would.
    if(useAI && typeof embEnsureForItems === 'function' && scoped.length){
      await embEnsureForItems(scoped);
    }

    // Same AI+hash blended comparison used everywhere else (js/similarity-ai.js
    // pairSimilarity/similarityBetween): the AI score catches "same subject on a
    // different background", and it's still blended with the raw pixel hash so a
    // spurious AI spike on unrelated stylized art (see similarity-ai.js's caveat
    // about MobileNet + flat-color/cartoon art) can't block a legitimate upload
    // on its own. NOTE: tag overlap is still deliberately excluded from this —
    // see the SIMILARITY_BLOCK_THRESHOLD comment above for why.
    const me = { phash, embedding: useAI ? embedding : null };
    let best = null, bestScore = 0;
    scoped.forEach(o=>{
      const other = { phash: o.phash, embedding: useAI ? o.embedding : null };
      const r = (typeof pairSimilarity === 'function') ? pairSimilarity(me, other) : { score: (phash && o.phash) ? phashSimilarity(phash, o.phash) : 0 };
      if(r.score > bestScore){ bestScore = r.score; best = o; }
    });
    return { bestScore, best };
  }catch(err){
    console.error('findBestSimilarityMatch error:', err);
    return { bestScore: 0, best: null }; // fail open — never block a legit upload just because this check errored
  }
}

// ══════════════════════════════════════════════════════
//  ORIGINALITY CHECK MODAL — a short "scanning" animation shown right
//  before a submission is saved (both the regular Upload Work flow in
//  this file and the Classwork "Attach Work" flow in assignments.js call
//  this). The real phash/tag comparison already ran (or runs alongside
//  a floor delay) by the time the animation finishes, so what's "playing"
//  is cosmetic — but it turns a silent block into an understandable,
//  reassuring moment instead of an abrupt error toast.
// ══════════════════════════════════════════════════════
function showOriginalityScanning(){
  document.getElementById('oc-scanning').style.display = 'block';
  document.getElementById('oc-result-blocked').style.display = 'none';
  document.getElementById('oc-result-clear').style.display = 'none';
  document.getElementById('oc-percent').textContent = '0%';
  document.getElementById('originalityCheckOverlay').classList.add('open');
}
function closeOriginalityCheck(){
  document.getElementById('originalityCheckOverlay').classList.remove('open');
}
// Counts the on-screen percentage up to the real score over durationMs —
// purely visual pacing, the actual score is already known before this runs.
function animateOcPercent(targetPct, durationMs){
  return new Promise(resolve=>{
    const el = document.getElementById('oc-percent');
    if(!el){ resolve(); return; }
    const start = performance.now();
    function tick(now){
      const t = Math.min(1, (now - start) / durationMs);
      el.textContent = Math.round(targetPct * t) + '%';
      if(t < 1) requestAnimationFrame(tick); else resolve();
    }
    requestAnimationFrame(tick);
  });
}

// Runs the real duplicate check behind the scanning animation, then reveals
// the result. Returns true if the submission must be BLOCKED (100% match),
// false if it's clear to proceed with saving.
async function runOriginalityCheckUI(phash, tags, assignmentId, embedding, ownerStudentId){
  showOriginalityScanning();
  const [{ bestScore, best }] = await Promise.all([
    findBestSimilarityMatch(phash, tags, null, assignmentId, embedding, ownerStudentId),
    new Promise(r => setTimeout(r, 300)) // floor so the ring is visible even on a fast connection
  ]);
  const pct = Math.round(bestScore * 100);
  await animateOcPercent(pct, 900);

  // Blocks at SIMILARITY_BLOCK_THRESHOLD (90%), not just on a literal 100% duplicate —
  // the copy below used to hardcode "100% Match Found" even though the real threshold
  // is 90%, which made a genuine 90-99% AI-detected block look like a display bug.
  const blocked = bestScore >= SIMILARITY_BLOCK_THRESHOLD;
  if(blocked){
    document.getElementById('oc-scanning').style.display = 'none';
    document.getElementById('oc-result-blocked').style.display = 'block';
    const titleEl = document.getElementById('oc-blocked-title');
    if(titleEl) titleEl.textContent = pct >= 99 ? '100% Match Found' : `${pct}% Similarity Detected`;
    document.getElementById('oc-blocked-text').textContent = (best && best.title)
      ? `This work is ${pct}% similar to an existing submission ("${best.title}") already in the system — too close to be submitted as original work.`
      : `This work is ${pct}% similar to a submission already in the system — too close to be submitted as original work.`;
    // Stays open — the student has to tap "Got It" to dismiss it themselves.
  } else {
    document.getElementById('oc-scanning').style.display = 'none';
    document.getElementById('oc-result-clear').style.display = 'block';
    await new Promise(r => setTimeout(r, 700));
    closeOriginalityCheck();
  }
  return blocked;
}

// One comparison between two works ({ phash, embedding } each). Uses the AI
// image comparison from js/similarity-ai.js when both works have an embedding,
// and the basic image-hash score otherwise (e.g. if that file or the model
// couldn't load), so similarity checks never break.
function pairSimilarity(a, b){
  if(typeof similarityBetween === 'function') return similarityBetween(a, b);
  const dh = (a.phash && b.phash) ? phashSimilarity(a.phash, b.phash) : 0;
  return { score: dh, cos: null, dh, method: 'hash' };
}

// After a new image is uploaded, compare it against every other student's uploaded
// images (AI comparison when available, image hash otherwise) and log the closest match.
// NOTE: Imagga tag overlap is deliberately NOT part of this score anymore. Tags are
// generic ("cartoon", "character", "toy"...), so two completely different pictures
// could score a fake "100% match" on tags alone. Only the picture itself counts.
async function runSimilarityCheck(newItemId, newPhash, newTags, newEmbedding, assignmentId, ownerStudentId){
  if(!newPhash && !newEmbedding) return; // no image fingerprint (e.g. a video/PDF) — nothing to compare
  try{
    const useAI = !!newEmbedding && (typeof embeddingColumnAvailable === 'function') && await embeddingColumnAvailable();
    const { data: others, error } = await sb
      .from('portfolio_items')
      .select('id, phash, title, file_url, portfolios(assignment_id, student_id)' + (useAI ? ', embedding' : ''))
      .neq('id', newItemId);
    if(error || !others || others.length === 0) return;

    // Same-assignment scoping, and same-student exclusion — see findBestSimilarityMatch() for why.
    const targetAssignmentId = assignmentId || null;
    const scoped = others.filter(o => {
      const port = o.portfolios || {};
      if(ownerStudentId && port.student_id === ownerStudentId) return false;
      return (port.assignment_id || null) === targetAssignmentId;
    });

    let best = null, bestScore = 0;
    const me = { phash: newPhash, embedding: useAI ? newEmbedding : null };
    scoped.forEach(o=>{
      const score = pairSimilarity(me, o).score;
      if(score > bestScore){ bestScore = score; best = o; }
    });

    // Always record the closest match, even at 0%, so the Review Panel can show
    // "X% similar to <student>" for every submission — not just the ones that
    // cross the warning threshold. SIMILARITY_FLAG_THRESHOLD is still used to
    // decide whether the professor gets the "possible similarity" warning banner.
    if(best){
      await sb.from('similarity_logs').insert([{
        checked_item_id:  newItemId,
        matched_item_id:  best.id,
        similarity_score: bestScore,
        flagged:          bestScore >= SIMILARITY_FLAG_THRESHOLD
      }]);
    }
  }catch(err){
    console.error('similarity check error:', err);
  }
}

// Save uploaded item to Supabase using your real schema
// Flow: find/create portfolio → insert portfolio_item
async function saveItemToSupabase(userId, { title, desc, subjectId, gradingPeriod, fileUrl, fileType, fileSize, cloudinaryId, phash, imaggaTags, embedding }){
  // 1. Find or create a portfolio for this student + grading_period (subject is optional)
  let portfolioId;
  let existingQuery = sb.from('portfolios').select('id, status').eq('student_id', userId).eq('grading_period', gradingPeriod);
  if(subjectId) existingQuery = existingQuery.eq('subject_id', subjectId);
  else existingQuery = existingQuery.is('subject_id', null);
  const { data: existingPort } = await existingQuery.maybeSingle();

  if(existingPort){
    portfolioId = existingPort.id;
    // A new item added to this grading period must send the WHOLE shared portfolio
    // back into review — regardless of its previous status. Previously this only
    // reset 'draft' or 'rejected' portfolios, so adding a new file to an
    // ALREADY-APPROVED portfolio silently kept it 'approved' and the new,
    // never-reviewed upload instantly showed up under Approved Works.
    if(existingPort.status !== 'submitted'){
      await sb.from('portfolios').update({ status:'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', portfolioId);
    }
  } else {
    const newPortData = {
      student_id:     userId,
      grading_period: gradingPeriod,
      status:         'submitted',
      submitted_at:   new Date().toISOString()
    };
    if(subjectId) newPortData.subject_id = subjectId;
    const { data: newPort, error: pe } = await sb.from('portfolios').insert([newPortData]).select().single();
    if(pe) throw pe;
    portfolioId = newPort.id;
  }

  // 2. Insert portfolio_item
  const itemRow = {
    portfolio_id:    portfolioId,
    title:           title,
    description:     desc,
    file_url:        fileUrl,
    file_type:       fileType || 'application/octet-stream',
    file_size_bytes: fileSize,
    is_watermarked:  false,
    phash:           phash || null,
    imagga_tags:     (imaggaTags && imaggaTags.length) ? imaggaTags : null,
    cloudinary_public_id: cloudinaryId || null,
    uploaded_at:     new Date().toISOString()
  };
  if(embedding) itemRow.embedding = embedding; // only sent when the AI comparison produced one (column may not exist otherwise)
  const { data: item, error: ie } = await sb.from('portfolio_items').insert([itemRow]).select().single();
  if(ie) throw ie;

  return { item, portfolioId };
}

// ── EMAIL NOTIFICATION — tuwing may approve/reject decision ──
function sendReviewNotification({ studentEmail, studentName, artworkTitle, decision, comment, finalGrade }){
  if(typeof emailjs === 'undefined'){ console.error('EmailJS not loaded'); return; }
  if(!studentEmail){ console.warn('No student email on file — notification skipped.'); return; }

  const appUrl = appBaseUrl();
  console.log('[review email] app_url being sent:', appUrl);
  if(/localhost|127\.0\.0\.1/.test(appUrl)) console.warn('[review email] app_url is a LOCAL address — it will not open for students. Set APP_PUBLIC_URL to your deployed site.');

  // The "View in Artfolio" button must land on the public landing page ONLY —
  // never straight inside an account. The base URL alone auto-restores any
  // saved session and walks right into the dashboard, so tag it with
  // ?to=landing, which initApp honours by showing the landing page and
  // skipping the session restore for that visit.
  const landingUrl = appUrl + (appUrl.includes('?') ? '&' : '?') + 'to=landing';
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    email:              studentEmail,
    student_name:       studentName || 'Student',
    artwork_title:      artworkTitle || 'Untitled',
    decision:           decision === 'approved' ? 'Approved' : 'Rejected',
    professor_comment:  comment || 'No comment provided.',
    final_grade:        finalGrade != null ? finalGrade+'/100' : 'Not yet graded',
    app_url:            landingUrl  // link for the "View in Artfolio" button in the email template ({{app_url}})
  }).then(()=>{
    console.log('Review notification sent to', studentEmail);
  }).catch(err=>{
    console.error('EmailJS send error:', err);
  });
}

// Professor: update portfolio status (approve/reject) + add feedback + star rating
async function updatePortfolioStatus(portfolioId, status, comment, professorId, rating){
  const upd = { status, updated_at: new Date().toISOString() };
  if(status === 'approved') upd.approved_at = new Date().toISOString();
  if(status === 'approved') upd.approved_by = professorId;
  if(rating) upd.rating = rating;
  const { error } = await sb.from('portfolios').update(upd).eq('id', portfolioId);
  if(error) throw error;

  // Insert feedback if comment provided
  if(comment){
    await sb.from('feedback').insert([{
      portfolio_id: portfolioId,
      professor_id: professorId,
      comment: comment
    }]);
  }
}

// Professor: load ALL portfolio items across all students
async function loadAllItemsForProfessor(){
  // Get all portfolios with subject info (subjects embed works fine — direct FK)
  const { data: portfolios, error: pe } = await sb
    .from('portfolios')
    .select('id, student_id, grading_period, status, submitted_at, approved_at, subject_id, assignment_id, rating, creativity_score, technique_score, composition_score, final_grade, grade_remarks, subjects(name,code)')
    .order('submitted_at', { ascending: false });
  if(pe){ console.error(pe); return []; }

  if(!portfolios || portfolios.length === 0) return [];
  const portIds = portfolios.map(p=>p.id);

  // Get all items
  const { data: items, error: ie } = await sb
    .from('portfolio_items')
    .select('id, portfolio_id, title, description, file_url, file_type, file_size_bytes, cloudinary_public_id, uploaded_at')
    .in('portfolio_id', portIds)
    .order('uploaded_at', { ascending: false });
  if(ie){ console.error(ie); return []; }

  // Fetch student profiles separately — portfolios.student_id and user_profiles.user_id
  // both point at auth.users, but there's no direct FK between portfolios and
  // user_profiles, so PostgREST can't auto-embed them. We join manually instead.
  const studentIds = [...new Set(portfolios.map(p=>p.student_id).filter(Boolean))];
  let profileMap = {};
  if(studentIds.length){
    const { data: profiles, error: profErr } = await sb
      .from('user_profiles')
      .select('user_id, full_name, student_id, section, email')
      .in('user_id', studentIds);
    if(profErr) console.error('profile fetch error:', profErr);
    (profiles||[]).forEach(pr=>{ profileMap[pr.user_id] = pr; });
  }

  // Latest feedback comment per portfolio — so the professor sees their own
  // prior comment when reopening a review, instead of it always showing blank.
  let feedbackMap = {};
  try{
    const { data: feedbackRows } = await sb
      .from('feedback')
      .select('portfolio_id, comment, created_at')
      .in('portfolio_id', portIds)
      .order('created_at', { ascending: false });
    (feedbackRows||[]).forEach(f=>{ if(!feedbackMap[f.portfolio_id]) feedbackMap[f.portfolio_id]=f.comment; });
  }catch(fbErr){ console.error('feedback load error (professor view):', fbErr); }

  const portMap = {};
  portfolios.forEach(p=>{ portMap[p.id]=p; });

  return (items||[]).map(item=>{
    const port    = portMap[item.portfolio_id] || {};
    const subj    = port.subjects || {};
    const profile = profileMap[port.student_id] || {};
    return {
      id:            item.id,
      portfolioId:   item.portfolio_id,
      title:         item.title,
      desc:          item.description,
      category:      subj.name || subj.code || 'General',
      gradingPeriod: port.grading_period || '',
      assignmentId:  port.assignment_id || null,
      status:        port.status || 'draft',
      file:{ dataUrl: item.file_url, mimeType: item.file_type, sizeBytes: item.file_size_bytes, isCloudinary:true },
      cloudinaryPublicId: item.cloudinary_public_id || null,
      submittedAt:   port.submitted_at || item.uploaded_at,
      studentName:   profile.full_name || 'Student',
      studentId:     profile.student_id || '',
      studentEmail:  profile.email || '',
      section:       profile.section || '',
      userId:        port.student_id,
      rating:            port.rating || 0,
      creativityScore:   port.creativity_score,
      techniqueScore:    port.technique_score,
      compositionScore:  port.composition_score,
      finalGrade:        port.final_grade,
      gradeRemarks:      port.grade_remarks,
      comment: feedbackMap[port.id] || ''
    };
  });
}

// Get all subjects (for upload dropdown)
async function loadSubjects(){
  const { data } = await sb.from('subjects').select('id, name, code').order('name');
  return data || [];
}

// Computes the closest match live, every time the professor opens a review.
// It deliberately does NOT read or write similarity_logs: old rows in that table were
// scored with a flawed formula (fake 100% matches), so trusting them would keep showing
// wrong results. Live compute is always correct and self-healing.
// It never waits on the AI: older works are analysed silently in the background
// (embWarmUp in js/similarity-ai.js), and any work that doesn't have its AI
// fingerprint yet is compared with the basic image hash until it does.
async function computeAndCacheSimilarity(itemId){
  try{
    const useAI = (typeof embeddingColumnAvailable === 'function') && await embeddingColumnAvailable();
    const { data: self, error: selfErr } = await sb
      .from('portfolio_items').select('id, phash, file_url, file_type, portfolios(assignment_id, student_id)' + (useAI ? ', embedding' : '')).eq('id', itemId).single();
    if(selfErr || !self) return null;

    const { data: others, error } = await sb
      .from('portfolio_items')
      .select('id, phash, title, file_url, file_type, portfolio_id, portfolios(assignment_id, student_id)' + (useAI ? ', embedding' : ''))
      .neq('id', itemId);
    if(error || !others || others.length === 0) return null; // truly nothing to compare against

    // Same-assignment scoping, and same-student exclusion — see findBestSimilarityMatch()
    // for why a student's own other submissions (e.g. an earlier withdrawn copy) should
    // never show up here as a "similarity match" against themselves.
    const myAssignmentId = (self.portfolios && self.portfolios.assignment_id) || null;
    const myStudentId    = (self.portfolios && self.portfolios.student_id) || null;
    const scopedOthers = others.filter(o => {
      const port = o.portfolios || {};
      if(myStudentId && port.student_id === myStudentId) return false;
      return (port.assignment_id || null) === myAssignmentId;
    });
    if(!scopedOthers.length) return null; // nothing else in this assignment (or plain-upload pool) yet

    // Same just-in-time backfill the pre-upload block check does
    // (findBestSimilarityMatch): an older work with no AI fingerprint yet
    // must be analysed right now, otherwise this review silently falls back
    // to the basic hash and can show a different % than the upload gate saw.
    if(useAI && typeof embEnsureForItems === 'function' && scopedOthers.length){
      try{ await embEnsureForItems([self, ...scopedOthers]); }catch(e){ console.warn('[similarity] review backfill skipped:', e); }
    }

    let best = null, bestScore = 0, bestDetail = null;
    const scored = [];
    scopedOthers.forEach(o=>{
      const r = pairSimilarity(self, o);
      scored.push({ title: o.title, final: Math.round(r.score*100)+'%', method: r.method, rawAI: r.cos != null ? +r.cos.toFixed(3) : null, imageHash: Math.round(r.dh*100)+'%' });
      if(r.score > bestScore){ bestScore = r.score; best = o; bestDetail = r; }
    });
    if(!best) return null;
    scored.sort((a,b)=> (b.rawAI ?? -1) - (a.rawAI ?? -1));
    console.log('[similarity] this work vs the others (closest first):', scored.slice(0, 8));

    const flagged = bestScore >= SIMILARITY_FLAG_THRESHOLD;

    return {
      matched_item_id: best.id, similarity_score: bestScore, flagged,
      method: bestDetail.method, cos: bestDetail.cos,
      portfolio_items: { title: best.title, file_url: best.file_url, portfolio_id: best.portfolio_id }
    };
  }catch(err){
    console.error('live similarity compute error:', err);
    return null;
  }
}

// Get similarity logs for a portfolio item
async function loadSimilarityLogs(itemId){
  const { data } = await sb
    .from('similarity_logs')
    .select('id, matched_item_id, similarity_score, flagged, checked_at, portfolio_items!similarity_logs_matched_item_id_fkey(title, file_url, portfolio_id)')
    .eq('checked_item_id', itemId)
    .order('similarity_score', { ascending: false });
  return data || [];
}

// Resolve which student owns a given portfolio — used to reveal who a
// similarity match belongs to, so the professor can inspect and decide.
async function getPortfolioOwnerName(portfolioId){
  if(!portfolioId) return 'Unknown Student';
  try{
    const { data: port } = await sb.from('portfolios').select('student_id').eq('id', portfolioId).single();
    if(!port) return 'Unknown Student';
    const profile = await getProfile(port.student_id);
    return (profile && profile.full_name) || 'Unknown Student';
  }catch(e){
    console.error('getPortfolioOwnerName error:', e);
    return 'Unknown Student';
  }
}

// ══════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════
function showSection(sec){
  document.getElementById('sec-about').style.display    = sec==='about'    ? 'block':'none';
  document.getElementById('sec-features').style.display = sec==='features' ? 'block':'none';
  document.querySelectorAll('.landing-nav-links a').forEach(a=>{
    a.classList.toggle('active', a.getAttribute('onclick').includes(sec));
  });
}

// ══════════════════════════════════════════════════════
//  NEW LANDING PAGE (js/app.js side) — smooth-scroll nav,
//  a bridge from the hero "Welcome back" login card into the
//  REAL doLogin()/doLoginProf() flow (so there's only ever one
//  place that actually authenticates), and two small Supabase
//  reads that populate the hero showcase mosaic + Explore grid
//  with real public/approved student work — no fake demo data.
// ══════════════════════════════════════════════════════
function scrollLandingTo(id){
  const el = document.getElementById(id);
  if(el) el.scrollIntoView({ behavior:'smooth', block:'start' });
}

// The hero login card has its OWN input ids (lp-login-email/pass) so it can't
// collide with the real login screen's ids — this just copies the values over
// and calls the exact same doLogin()/doLoginProf() everything else uses, so
// validation, error messages, and session handling all stay in one place.
function handleLandingLogin(role){
  if(role === 'professor') doLoginProf(); else doLogin();
}

// Small helper shared by the two loaders below: grab the most recently
// uploaded PUBLIC + APPROVED works, then keep only one per student so the
// same person doesn't dominate the mosaic/grid.
async function loadRecentPublicWorks(limit){
  const { data: items, error } = await sb
    .from('portfolio_items')
    .select('id, title, file_url, file_type, portfolio_id, uploaded_at')
    .eq('is_public', true)
    .order('uploaded_at', { ascending:false })
    .limit(limit);
  if(error || !items || !items.length) return [];

  const portIds = [...new Set(items.map(i=>i.portfolio_id))];
  const { data: ports } = await sb
    .from('portfolios').select('id, student_id, status, subjects(name,code)')
    .in('id', portIds).eq('status', 'approved');
  const portMap = {};
  (ports||[]).forEach(p=>{ portMap[p.id] = p; });

  const seen = new Set();
  const picks = [];
  for(const it of items){
    const port = portMap[it.portfolio_id];
    if(!port || seen.has(port.student_id)) continue;
    seen.add(port.student_id);
    picks.push({ ...it, studentId: port.student_id, subj: port.subjects });
    if(picks.length >= 6) break;
  }
  if(!picks.length) return [];

  const { data: profiles } = await sb
    .from('user_profiles').select('user_id, full_name')
    .in('user_id', picks.map(p=>p.studentId));
  const nameMap = {};
  (profiles||[]).forEach(p=>{ nameMap[p.user_id] = p.full_name; });
  picks.forEach(p=>{ p.studentName = nameMap[p.studentId] || 'Student'; });

  return picks;
}

// Hero "Recently shared works" mosaic — up to 6 thumbnails.
async function loadShowcaseMosaic(){
  const grid = document.getElementById('lp-showcase-grid');
  if(!grid) return;
  try{
    const picks = await loadRecentPublicWorks(18);
    if(!picks.length) return; // leave the static placeholder tiles in place
    grid.innerHTML = picks.map(p=>{
      const isImg = fileIsImage({ dataUrl:p.file_url, mimeType:p.file_type });
      const style = isImg ? `background-image:url('${esc(p.file_url)}')` : '';
      return `<div class="lp-thumb" style="${style}">${!isImg ? (fileIsVideo({dataUrl:p.file_url,mimeType:p.file_type})?'🎬':'🖼️') : ''}<span>${esc(p.studentName)}</span></div>`;
    }).join('');
  }catch(err){
    console.error('loadShowcaseMosaic error:', err);
  }
}

// Explore section grid — same underlying query, richer cards (name + subject),
// each opening the real public profile page.
async function loadLandingExplore(){
  const grid = document.getElementById('lp-explore-grid');
  if(!grid) return;
  try{
    const picks = await loadRecentPublicWorks(24);
    if(!picks.length){
      grid.innerHTML = `<div style="grid-column:1/-1;color:var(--lp-ink-soft);font-size:13px;">No public portfolios yet — be the first to share your work!</div>`;
      return;
    }
    grid.innerHTML = picks.map(p=>{
      const isImg = fileIsImage({ dataUrl:p.file_url, mimeType:p.file_type });
      const thumbStyle = isImg ? `background-image:url('${esc(p.file_url)}')` : `background:var(--lp-surface-tint);display:flex;align-items:center;justify-content:center;font-size:30px;`;
      const subj = (p.subj && (p.subj.name || p.subj.code)) || 'Multimedia Arts';
      return `<div class="lp-portfolio-card" onclick="openPublicProfile('${p.studentId}')">
        <div class="lp-portfolio-thumb" style="${thumbStyle}">${!isImg ? '🖼️' : ''}</div>
        <h4>${esc(p.studentName)}</h4>
        <span>${esc(subj)}</span>
      </div>`;
    }).join('');
  }catch(err){
    console.error('loadLandingExplore error:', err);
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--lp-ink-soft);font-size:13px;">Couldn't load portfolios right now.</div>`;
  }
}

// ══════════════════════════════════════════════════════
//  PUBLIC SEARCH (no login required) — search students by name or
//  student ID, then view only the works they've chosen to make public.
//  Requires: portfolio_items.is_public column + RLS SELECT policies that
//  allow anonymous reads for user_profiles and for portfolio_items where
//  is_public = true (otherwise these queries will just come back empty).
// ══════════════════════════════════════════════════════
async function runLandingSearch(inputId){
  const id = inputId || 'landing-search-input';
  const q  = (document.getElementById(id).value || '').trim();
  if(!q){ browseAllStudents(); return; } // no query typed — just show everyone enrolled
  showToast('🔍 Searching…');
  let data, error;
  try{
    ({ data, error } = await sb
      .from('user_profiles')
      .select('user_id, full_name, student_id, section, year_level')
      .eq('role', 'student')
      .or(`full_name.ilike.%${q}%,student_id.ilike.%${q}%`)
      .limit(30));
  }catch(networkErr){
    console.error('public search network error:', networkErr);
    showToast('❌ Network error — could not reach Supabase.');
    return;
  }
  if(error){ console.error('public search error:', error); showToast('❌ '+error.message); return; }

  document.getElementById('public-search-summary').textContent =
    (data && data.length) ? `${data.length} result${data.length===1?'':'s'} for "${q}"` : `No students found for "${q}"`;

  renderStudentResults(data);
  go('s-public-search');
}

// ── BROWSE ALL STUDENTS (no login required) — for visitors who don't know the
// exact name or student number, this lists everyone enrolled so they can scroll
// and find the person, instead of being forced to type a perfect search query. ──
async function browseAllStudents(){
  showToast('📋 Loading student list…');
  let data, error;
  try{
    ({ data, error } = await sb
      .from('user_profiles')
      .select('user_id, full_name, student_id, section, year_level')
      .eq('role', 'student')
      .order('full_name', { ascending: true })
      .limit(500));
  }catch(networkErr){
    console.error('browse students network error:', networkErr);
    showToast('❌ Network error — could not reach Supabase.');
    return;
  }
  if(error){ console.error('browse students error:', error); showToast('❌ '+error.message); return; }

  document.getElementById('public-search-summary').textContent =
    (data && data.length) ? `${data.length} enrolled student${data.length===1?'':'s'}` : `No enrolled students found.`;

  renderStudentResults(data);
  go('s-public-search');
}

// Shared renderer for both search results and the full browse list —
// STEP 1 of a two-step drill-down (same pattern as the professor's own
// Students page): first show the SECTIONS that matched, grouped exactly
// like Section/Grade Archives does. Tapping a section then reveals just
// the students enrolled in it (openPublicSection below), and tapping a
// student opens their public portfolio (openPublicProfile, unchanged).
// Students with no section set are grouped into a "No Section" catch-all
// pushed to the end.
let _publicSearchData      = [];   // last-loaded flat list of students (from search or browse)
let _publicSectionStudents = [];   // students currently shown inside one section
let currentPublicSectionName = null;

function renderStudentResults(data){
  _publicSearchData = data || [];

  const sectionsView  = document.getElementById('public-search-sections');
  const inSectionView = document.getElementById('public-search-in-section');
  if(sectionsView)  sectionsView.style.display  = 'block';
  if(inSectionView) inSectionView.style.display = 'none';
  currentPublicSectionName = null;

  const resultsEl = document.getElementById('public-search-results');
  if(!_publicSearchData.length){
    resultsEl.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:20px 0;">No students to show yet.</div>`;
    return;
  }

  const groups = {};
  _publicSearchData.forEach(s=>{
    const key = s.section || 'No Section';
    if(!groups[key]) groups[key] = [];
    groups[key].push(s);
  });
  // Alphabetical by section name, with the "No Section" catch-all pushed to the end.
  const sectionNames = Object.keys(groups).sort((a,b)=>{
    if(a==='No Section') return 1;
    if(b==='No Section') return -1;
    return a.localeCompare(b);
  });

  resultsEl.innerHTML = sectionNames.map(name=>{
    const count = groups[name].length;
    const safeName = esc(name).replace(/'/g,"\\'");
    return `<div class="section-group" onclick="openPublicSection('${safeName}')">
      <div class="section-group-info">
        <div class="section-name">${esc(name)}</div>
        <div class="section-year">${count} student${count===1?'':'s'}</div>
      </div>
      <button class="btn-view-sm" onclick="event.stopPropagation();openPublicSection('${safeName}')">👁 View</button>
    </div>`;
  }).join('');
}

// STEP 2: students within one section, from the results already loaded
// in Step 1 — no extra Supabase round-trip needed.
function openPublicSection(name){
  currentPublicSectionName = name;
  _publicSectionStudents = _publicSearchData.filter(s=>(s.section || 'No Section') === name);

  document.getElementById('public-search-sections').style.display = 'none';
  document.getElementById('public-search-in-section').style.display = 'block';
  document.getElementById('pss-section-title').textContent = `${name} (${_publicSectionStudents.length})`;

  const el = document.getElementById('public-search-section-students');
  el.innerHTML = _publicSectionStudents.length ? _publicSectionStudents.map(s=>{
    const meta = [maskStudentId(s.student_id)||'No ID', s.year_level||'Year Level'].join(' · ');
    return `<div class="student-row" onclick="openPublicProfile('${s.user_id}')">
      <div class="student-ava"><div class="avatar-initial" style="background:${avatarColor(s.full_name)};width:100%;height:100%;">${esc(studentInitial(s.full_name))}</div></div>
      <div class="student-row-info">
        <div class="student-row-name">${esc(s.full_name||'Student')}</div>
        <div class="student-row-meta">${esc(meta)}</div>
      </div>
      <button class="btn-view-sm" onclick="event.stopPropagation();openPublicProfile('${s.user_id}')">👁 View Portfolio</button>
    </div>`;
  }).join('') : `<div style="font-size:13px;color:var(--text3);padding:20px 0;">No students in this section.</div>`;
}

function backToPublicSections(){
  document.getElementById('public-search-in-section').style.display = 'none';
  document.getElementById('public-search-sections').style.display = 'block';
  currentPublicSectionName = null;
}

let _publicProfileWorks = [];
async function openPublicProfile(userId){
  showToast('📂 Loading portfolio…');

  const { data: profile, error: profErr } = await sb
    .from('user_profiles')
    .select('user_id, full_name, student_id, section, year_level, social_link, skills')
    .eq('user_id', userId)
    .maybeSingle();
  if(profErr || !profile){ showToast('❌ Could not load this profile.'); console.error(profErr); return; }

  // The profile screen lives in Pages/public-profile.html — if that fragment
  // failed to load, say so plainly instead of crashing on a null element and
  // leaving the visitor stuck on "Loading portfolio…".
  if(!document.getElementById('pp-name') || !document.getElementById('pp-works')){
    console.error(`openPublicProfile aborted: s-public-profile is missing from the DOM (Pages/public-profile.html didn't load).`);
    showToast('❌ Profile page failed to load. Please refresh and try again.');
    return;
  }

  document.getElementById('pp-name').textContent = profile.full_name || 'Student';
  const secYear = [profile.section, profile.year_level].filter(Boolean).join(' \u00b7 ');
  document.getElementById('pp-meta').innerHTML = [
    esc(maskStudentId(profile.student_id) || 'Student ID not set'),
    esc(secYear || 'Section · Year Level'),
    profile.social_link ? `<a href="${esc(profile.social_link)}" target="_blank" rel="noopener">${esc(profile.social_link)}</a>` : '<span style="opacity:.6">No social link added</span>'
  ].join('<br>');
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  document.getElementById('pp-skills').innerHTML = skills.length
    ? skills.map(sk=>`<span class="skill-pill">${esc(sk)}</span>`).join('')
    : `<span class="skill-pill" style="opacity:.6">No skills added yet</span>`;
  document.getElementById('pp-avatar').innerHTML = `<div class="avatar-initial" style="background:${avatarColor(profile.full_name)}">${esc(studentInitial(profile.full_name))}</div>`;

  // Only PUBLIC + APPROVED works are visible here — nothing pending/rejected/private,
  // and no grades or professor comments, since those stay private to the student.
  const worksEl = document.getElementById('pp-works');
  worksEl.innerHTML = `<div style="font-size:13px;color:var(--text3);grid-column:1/-1;">Loading works…</div>`;
  go('s-public-profile');

  try{
    const { data: portfolios, error: pe } = await sb
      .from('portfolios')
      .select('id, subjects(name,code)')
      .eq('student_id', userId)
      .eq('status', 'approved');
    if(pe) throw pe;
    const portIds = (portfolios||[]).map(p=>p.id);
    if(!portIds.length){
      _publicProfileWorks = [];
      worksEl.innerHTML = `<div class="empty-state"><p>This student hasn't made any works public yet.</p></div>`;
      return;
    }
    const portMap = {}; (portfolios||[]).forEach(p=>{ portMap[p.id]=p; });

    const { data: items, error: ie } = await sb
      .from('portfolio_items')
      .select('id, portfolio_id, title, description, file_url, file_type')
      .in('portfolio_id', portIds)
      .eq('is_public', true);
    if(ie) throw ie;

    _publicProfileWorks = (items||[]).map(it=>{
      const subj = (portMap[it.portfolio_id]||{}).subjects || {};
      return { id: it.id, title: it.title, desc: it.description, category: subj.name||subj.code||'General',
        file:{ dataUrl: it.file_url, mimeType: it.file_type } };
    });

    worksEl.innerHTML = _publicProfileWorks.length ? _publicProfileWorks.map((p,i)=>{
      const thumb = fileIsImage(p.file) ? `<img class="pwork-thumb" src="${esc(p.file.dataUrl)}" alt="${esc(p.title)}"/>` : `<div class="upload-thumb-placeholder" style="height:200px">${fileIsVideo(p.file)?'🎬':'🖼️'}</div>`;
      return `<div class="pwork-card" onclick="viewPublicWork(${i})">${thumb}
        <div class="pwork-overlay"><button class="btn-view-project">👁 View Project</button></div>
        <div class="pwork-info">
          <div class="pwork-title">${esc(p.title)}</div>
          <div class="pwork-cat">${esc(p.category)}</div>
          <div class="pwork-desc">${esc(p.desc||'')}</div>
        </div></div>`;
    }).join('') : `<div class="empty-state"><p>This student hasn't made any works public yet.</p></div>`;
  }catch(err){
    console.error('openPublicProfile works error:', err);
    worksEl.innerHTML = `<div class="empty-state"><p>Couldn't load this student's public works right now.</p></div>`;
  }
}

let currentPublicPreviewItemId = null;
function viewPublicWork(idx){
  const p = _publicProfileWorks[idx];
  if(!p) return;
  currentPublicPreviewItemId = p.id;
  document.getElementById('ppv-title').textContent = p.title;
  const img = document.getElementById('ppv-img');
  const vid = document.getElementById('ppv-video');
  const ph  = document.getElementById('ppv-placeholder');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  if(fileIsImage(p.file)){
    img.src = p.file.dataUrl; img.style.display='block'; vid.style.display='none'; ph.style.display='none';
  } else if(fileIsVideo(p.file)){
    // Videos are intentionally NOT playable while just browsing a profile —
    // only the QR-scan destination (public-work.html) is allowed to play them.
    img.style.display='none'; vid.style.display='none';
    ph.style.display='flex';
    ph.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
      <span style="font-size:44px;">🎬</span>
      <span style="font-size:12px;font-weight:600;color:var(--text2);">Scan the QR code below to watch this video</span>
    </div>`;
  } else {
    img.style.display='none'; vid.style.display='none'; ph.style.display='flex';
    ph.innerHTML = '🖼️';
  }
  // Title + image only here — the description is intentionally gated behind
  // the QR scan (public-work.html), not shown just by browsing the profile.
  const workUrl = buildWorkPublicUrl(p.id);
  const qrImg = document.getElementById('ppv-qr-img');
  if(qrImg) qrImg.src = buildGoQrImageUrl(workUrl, 180);
  const manualLink = document.getElementById('ppv-manual-link');
  if(manualLink){ manualLink.href = workUrl; manualLink.textContent = workUrl; }
  document.getElementById('publicWorkPreviewOverlay').classList.add('open');
}
function closePublicWorkPreview(){
  document.getElementById('publicWorkPreviewOverlay').classList.remove('open');
  const vid = document.getElementById('ppv-video');
  if(vid){ vid.pause(); }
  currentPublicPreviewItemId = null;
}

// ── LOGIN ALERT — email the account owner whenever someone tries to sign
//    in with their email, success or failure ──
// Captures the attempting device's public IP + rough location (via
// ipapi.co, no key needed) and browser/OS (from the User-Agent string),
// then emails that to the address that was typed into the login form.
// Needs a 3rd EmailJS template with variables: {{to_email}}, {{status}},
// {{ip}}, {{location}}, {{device}}, {{time}}.
const EMAILJS_LOGIN_ALERT_TEMPLATE_ID = 'template_rzqc89l'; // ← create this template in EmailJS, paste its ID here

// ── Alert behavior settings ──
const ALERT_ON_SUCCESS  = false;          // false = only email on FAILED attempts (saves your 200/month EmailJS quota); true = email on every login
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;  // max one alert per email address per 5 minutes (per browser)
// Leave '' to auto-detect the current site address. Set it to your real deployed URL
// (e.g. 'https://yourname.github.io/portfolio-system/') so the email buttons work
// when you are testing on localhost / Live Server.
const APP_PUBLIC_URL = '';
// true = ask the browser for the device's real location (shows an "Allow location?" prompt).
// This is far more accurate than the IP-address guess. If the person clicks Block or ignores
// the prompt, the alert still sends using the IP-based estimate.
const ASK_PRECISE_LOCATION = true;

function appBaseUrl(){ return APP_PUBLIC_URL || (location.origin + location.pathname); }
function buildAlertActionUrl(action, email){
  return `${appBaseUrl()}?action=${action}&email=${encodeURIComponent(email)}`;
}

// ── Where did the attempt come from? ──
// Fetch JSON but give up after a few seconds, so a slow or blocked lookup
// can never hang the alert.
async function fetchJsonWithTimeout(url, ms){
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 4000);
  try{
    const res = await fetch(url, { signal: ctrl.signal });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// "Chrome on Windows" instead of a 200-character user-agent string.
function describeDevice(){
  const ua = navigator.userAgent || '';
  let browser = 'Unknown browser';
  if(/Edg\//.test(ua))              browser = 'Edge';
  else if(/OPR\/|Opera/.test(ua))   browser = 'Opera';
  else if(/Firefox\//.test(ua))     browser = 'Firefox';
  else if(/Chrome\//.test(ua))      browser = 'Chrome';
  else if(/Safari\//.test(ua))      browser = 'Safari';
  let os = 'Unknown device';
  if(/Windows/.test(ua))                  os = 'Windows';
  else if(/Android/.test(ua))             os = 'Android';
  else if(/iPhone|iPad|iPod/.test(ua))    os = 'iOS';
  else if(/Mac OS X|Macintosh/.test(ua))  os = 'macOS';
  else if(/CrOS/.test(ua))                os = 'ChromeOS';
  else if(/Linux/.test(ua))               os = 'Linux';
  return `${browser} on ${os}`;
}

// Shown in Philippine time no matter what timezone the attacker's device is set to.
function alertTimestamp(){
  try{
    return new Date().toLocaleString('en-PH', { timeZone:'Asia/Manila', dateStyle:'medium', timeStyle:'short' }) + ' (Philippine time)';
  }catch(e){
    return new Date().toLocaleString();
  }
}

// Precise location from the browser (GPS / Wi-Fi). Needs the person's permission, so it can
// resolve to null (blocked, ignored, unsupported, insecure page). Never throws or hangs.
function getPreciseLocation(ms){
  return new Promise(resolve => {
    if(!('geolocation' in navigator)){ resolve(null); return; }
    const timer = setTimeout(() => resolve(null), ms || 12000); // covers a prompt nobody answers
    navigator.geolocation.getCurrentPosition(
      pos => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }); },
      ()  => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  });
}

// Coordinates -> "Barangay/City, Province, Country" (free, no API key). Falls back to null.
async function reverseGeocode(lat, lon){
  try{
    const d = await fetchJsonWithTimeout(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 4000);
    const parts = [d.locality, d.city, d.principalSubdivision, d.countryName].filter(Boolean);
    return [...new Set(parts)].join(', ') || null;
  }catch(err){
    console.warn('[login alert] reverse geocode failed:', err);
    return null;
  }
}

// IP-based guess. Tries a few free services in order (any one can be blocked by an ad blocker
// or rate-limited — school Wi-Fi shares one public IP across many students). Never throws.
async function lookupByIp(){
  let ip = 'Unknown', location = 'Unknown', lat = null, lon = null;
  const providers = [
    { url:'https://ipwho.is/',
      read: d => (d && d.success !== false) ? { ip:d.ip, city:d.city, region:d.region, country:d.country, lat:d.latitude, lon:d.longitude } : null },
    { url:'https://ipapi.co/json/',
      read: d => (d && !d.error) ? { ip:d.ip, city:d.city, region:d.region, country:d.country_name, lat:d.latitude, lon:d.longitude } : null }
  ];
  for(const p of providers){
    try{
      const info = p.read(await fetchJsonWithTimeout(p.url, 4000));
      if(info && info.ip){
        ip = info.ip;
        location = [info.city, info.region, info.country].filter(Boolean).join(', ') || 'Unknown';
        lat = info.lat ?? null; lon = info.lon ?? null;
        break;
      }
    }catch(err){
      console.warn('[login alert] lookup failed (' + p.url + '):', err);
    }
  }
  if(ip === 'Unknown'){ // last resort — at least get the IP address
    try{
      const d = await fetchJsonWithTimeout('https://api.ipify.org?format=json', 3000);
      if(d && d.ip) ip = d.ip;
    }catch(err){
      console.warn('[login alert] IP-only lookup failed:', err);
    }
  }
  return { ip, location, lat, lon };
}

// Combines both: the IP lookup (for the IP address + a fallback guess) and, if allowed,
// the device's real location. The location text says which one it is, so the email is honest.
async function getLoginAttemptInfo(){
  const [ipInfo, precise] = await Promise.all([
    lookupByIp(),
    ASK_PRECISE_LOCATION ? getPreciseLocation(12000) : Promise.resolve(null)
  ]);

  let location = ipInfo.location, lat = ipInfo.lat, lon = ipInfo.lon;
  if(precise){
    lat = precise.lat; lon = precise.lon;
    const place = await reverseGeocode(precise.lat, precise.lon);
    location = (place || `${precise.lat.toFixed(4)}, ${precise.lon.toFixed(4)}`) + ` (device location, within ${precise.acc} m)`;
  }
  // Exact pin only when we really have the device's position. For an IP-based guess, link to a
  // map search of the area name instead, so the map doesn't suggest a precise spot it can't know.
  const mapUrl = precise
    ? `https://www.google.com/maps?q=${lat},${lon}`
    : (location !== 'Unknown' ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}` : '');
  return { ip: ipInfo.ip, location, device: describeDevice(), mapUrl };
}

// Cooldown: true if an alert for this key was already sent (or is being sent) recently.
// Marks the key immediately so two quick failed attempts don't both send.
function alertOnCooldown(key){
  try{
    const last = Number(localStorage.getItem(key) || 0);
    if(Date.now() - last < ALERT_COOLDOWN_MS) return true;
    localStorage.setItem(key, String(Date.now()));
  }catch(e){ /* storage blocked — just send */ }
  return false;
}
function clearAlertCooldown(key){
  try{ localStorage.removeItem(key); }catch(e){}
}

// Fire-and-forget — callers do NOT await this, so a slow IP lookup or a
// blocked EmailJS request never delays the login itself.
// The email includes two buttons: "Change my password" (opens the Forgot Password
// screen with the email pre-filled) and "It was me — keep my password".
async function sendLoginAlert(email, success){
  if(typeof emailjs === 'undefined'){ console.warn('[login alert] EmailJS not loaded — skipped.'); return; }
  if(success && !ALERT_ON_SUCCESS) return;
  const key = 'artfolio_alert_' + (success ? 'ok_' : 'fail_') + email.toLowerCase();
  if(alertOnCooldown(key)){
    console.log('[login alert] skipped — an alert for ' + email + ' was already sent in the last 5 minutes.');
    return;
  }
  try{
    const { ip, location, device, mapUrl } = await getLoginAttemptInfo();
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_LOGIN_ALERT_TEMPLATE_ID, {
      to_email: email,
      status:   success ? 'Successful login' : 'Failed login attempt',
      ip, location, device,
      map_url: mapUrl || appBaseUrl(),
      time: alertTimestamp(),
      change_password_url: buildAlertActionUrl('changepw', email),
      keep_password_url:   buildAlertActionUrl('keep', email)
    });
    console.log('[login alert] sent to', email, '|', location, '|', ip);
  }catch(err){
    clearAlertCooldown(key); // sending failed — don't block the next try
    console.error('[login alert] EmailJS send failed:', err); // EmailJS errors look like { status, text }
  }
}

// Handles the two buttons in the alert email (?action=changepw / ?action=keep).
// Returns true if it took over the screen (so initApp skips restoring a session).
function handleAlertLink(){
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  if(action !== 'changepw' && action !== 'keep') return false;
  const email = params.get('email') || '';
  history.replaceState(null, '', location.pathname); // keep the email out of the address bar and don't re-run on refresh

  if(action === 'changepw'){
    go('s-forgot');
    showForgotStep('email');
    const inp = document.getElementById('forgot-email');
    if(inp) inp.value = email;
    showToast('🔐 Tap "Send Reset Code" to choose a new password.');
    return true;
  }
  showToast('👍 Got it — your password stays the same.');
  return false;
}

// ══════════════════════════════════════════════════════
//  AUTH — LOGIN
// ══════════════════════════════════════════════════════
async function doLogin(){
  const raw  = document.getElementById('lp-login-email').value.trim();
  const pass = document.getElementById('lp-login-pass').value;
  if(!raw)  { showToast('⚠️ Please enter your email'); return; }
  if(!pass) { showToast('⚠️ Please enter your password'); return; }
  const email = raw.includes('@') ? raw : raw+'@asiatech.edu.ph';
  showToast('🔐 Signing in…');
  let data, error;
  try{
    ({ data, error } = await sb.auth.signInWithPassword({ email, password: pass }));
  }catch(networkErr){
    console.error('signIn network error:', networkErr);
    showToast('❌ Network error — could not reach Supabase. Check your internet connection or the Supabase project status.');
    return;
  }
  if(error){ showToast('❌ '+loginErrorMessage(error)); sendLoginAlert(email, false); return; }
  let profile = await getProfile(data.user.id);
  if(!profile){
    // Profile row is missing — this can happen if the OTP step was skipped or RLS blocked the insert.
    // Auto-create a minimal profile so the user isn't permanently locked out.
    // Don't use the raw email/username as the name — it may just be a student number.
    await sb.from('user_profiles').insert([{
      user_id:  data.user.id,
      full_name: 'Student',
      role:     'student'
    }]);
    profile = await getProfile(data.user.id);
  }
  if(!profile){ showToast('❌ Could not load your profile. Please contact your administrator.'); return; }
  if(profile.role !== 'student'){ showToast('❌ Please use "Login as Professor" for professor accounts.'); return; }
  currentUser    = data.user;
  currentProfile = profile;
  const firstName = (profile.full_name||'').split(' ')[0] || 'Student';
  document.getElementById('s-sidebar-name').textContent  = profile.full_name || email;
  document.getElementById('s-welcome-name').textContent  = 'Welcome Back, '+firstName+'!';
  renderPortfolioHeader();
  go('s-student');
  sPage('dashboard');
  showToast('✅ Signed in as '+profile.full_name);
  sendLoginAlert(email, true);
  await loadProjectsForStudent(data.user.id);
  refreshStudentViews();
}

async function doLoginProf(){
  const raw  = document.getElementById('lp-login-email').value.trim();
  const pass = document.getElementById('lp-login-pass').value;
  if(!raw)  { showToast('⚠️ Please enter your email'); return; }
  if(!pass) { showToast('⚠️ Please enter your password'); return; }
  const email = raw.includes('@') ? raw : raw+'@asiatech.edu.ph';
  showToast('🔐 Signing in…');
  let data, error;
  try{
    ({ data, error } = await sb.auth.signInWithPassword({ email, password: pass }));
  }catch(networkErr){
    console.error('signIn network error:', networkErr);
    showToast('❌ Network error — could not reach Supabase. Check your internet connection or the Supabase project status.');
    return;
  }
  if(error){ showToast('❌ '+loginErrorMessage(error)); sendLoginAlert(email, false); return; }
  const profile = await getProfile(data.user.id);
  if(!profile){ showToast('❌ Profile not found. Please contact your administrator to set up your account.'); return; }
  if(profile.role !== 'professor' && profile.role !== 'admin'){ showToast('❌ This is not a professor account. Please use the student login instead.'); return; }
  currentUser    = data.user;
  currentProfile = profile;
  document.getElementById('p-sidebar-name').textContent = profile.full_name||'';
  setAvatar('p-sidebar-avatar', profile.full_name);
  go('s-professor');
  pPage('p-dashboard');
  showToast('✅ Signed in as '+profile.full_name);
  sendLoginAlert(email, true);
  refreshProfViews();
  applyProfessorPermissions();
}

// ── SIGN UP ──
async function doSignupStudent(){
  const firstName = document.querySelector('#s-signup-student input[placeholder="First Name"]').value.trim();
  const lastName  = document.querySelector('#s-signup-student input[placeholder="Last Name"]').value.trim();
  const studentId = document.querySelector('#s-signup-student input[placeholder="ex. 1 - 230371"]').value.trim();
  const section   = document.getElementById('signup-student-section').value;
  const yearLevel = document.getElementById('signup-student-year').value;
  const emailInp  = document.querySelector('#s-signup-student input[type="email"]').value.trim();
  if(!firstName||!lastName||!emailInp){ showToast('⚠️ Please fill in all required fields'); return; }
  const pass = prompt('Create a password (min 6 characters):');
  if(!pass||pass.length<6){ showToast('⚠️ Password must be at least 6 characters'); return; }

  showToast('📧 Sending verification code…');
  const sent = await sendCustomOtp(emailInp);
  if(!sent){ showToast('❌ Could not send verification code. Please try again.'); return; }

  // The real Supabase account (sb.auth.signUp) isn't created until
  // verifyStudentOtp() confirms this code — that's why the password has to
  // travel along in here too now, instead of being used immediately.
  sessionStorage.setItem('pendingSignup', JSON.stringify({
    email:      emailInp,
    password:   pass,
    role:       'student',
    full_name:  firstName+' '+lastName,
    student_id: studentId,
    section:    section,
    year_level: yearLevel
  }));
  go('s-verify-student');
  resetOtpTimer('student');
  showToast('✅ Verification code sent! Check your email.');
}

async function doSignupProf(){
  const firstName  = document.querySelector('#s-signup-prof input[placeholder="First Name"]').value.trim();
  const lastName   = document.querySelector('#s-signup-prof input[placeholder="Last Name"]').value.trim();
  const department = document.getElementById('signup-prof-department').value;
  const emailInp   = document.querySelector('#s-signup-prof input[type="email"]').value.trim();
  if(!firstName||!lastName||!department||!emailInp){ showToast('⚠️ Please fill in all required fields'); return; }
  const pass = prompt('Create a password (min 6 characters):');
  if(!pass||pass.length<6){ showToast('⚠️ Password must be at least 6 characters'); return; }

  showToast('📧 Sending verification code…');
  const sent = await sendCustomOtp(emailInp);
  if(!sent){ showToast('❌ Could not send verification code. Please try again.'); return; }

  sessionStorage.setItem('pendingSignup', JSON.stringify({
    email:      emailInp,
    password:   pass,
    role:       'professor',
    full_name:  firstName+' '+lastName,
    department: department
  }));
  go('s-verify-prof');
  resetOtpTimer('prof');
  showToast('✅ Verification code sent! Check your email.');
}

// ── EMAIL OTP VERIFICATION ──
function readOtpCode(containerId){
  return Array.from(document.querySelectorAll('#'+containerId+' .otp-box')).map(b=>b.value.trim()).join('');
}

async function verifyStudentOtp(){
  const code = readOtpCode('otp-student');
  if(code.length<8){ showToast('⚠️ Please enter the full 8-digit code'); return; }
  const pending = JSON.parse(sessionStorage.getItem('pendingSignup')||'null');
  if(!pending){ showToast('❌ Signup session expired. Please sign up again.'); go('s-signup-student'); return; }
  showToast('🔐 Verifying code…');

  const codeOk = await verifyCustomOtp(pending.email, code);
  if(!codeOk){ showToast('❌ Invalid or expired code. Please try again.'); return; }

  let data, error;
  try{
    ({ data, error } = await sb.auth.signUp({ email: pending.email, password: pending.password }));
  }catch(networkErr){
    console.error('signUp network error:', networkErr);
    showToast('❌ Network error — could not reach Supabase. Check your internet connection or the Supabase project status.');
    return;
  }
  if(error){ showToast('❌ '+(error.message||JSON.stringify(error))); return; }
  if(!data.session){
    // "Confirm email" is still ON in the Supabase dashboard — turn it off
    // (Authentication → Sign In / Providers → Email) so signUp() logs the
    // student straight in instead of waiting on Supabase's own email too.
    showToast('❌ Account created but not signed in — turn "Confirm email" OFF in Supabase Auth settings.');
    return;
  }
  await sb.from('user_profiles').insert([{
    user_id:    data.user.id,
    full_name:  pending.full_name,
    student_id: pending.student_id,
    role:       pending.role,
    section:    pending.section,
    year_level: pending.year_level,
    email:      pending.email
  }]);
  sessionStorage.removeItem('pendingSignup');
  const profile = await getProfile(data.user.id);
  currentUser    = data.user;
  currentProfile = profile;
  const firstName = (profile?.full_name||'').split(' ')[0]||'Student';
  document.getElementById('s-sidebar-name').textContent = profile?.full_name||'';
  document.getElementById('s-welcome-name').textContent = 'Welcome Back, '+firstName+'!';
  renderPortfolioHeader();
  go('s-student'); sPage('dashboard');
  await loadProjectsForStudent(data.user.id);
  refreshStudentViews();
  populateSubjectDropdown();
  showToast('✅ Account verified! Welcome, '+firstName+'.');
}

async function verifyProfOtp(){
  const code = readOtpCode('otp-prof');
  if(code.length<8){ showToast('⚠️ Please enter the full 8-digit code'); return; }
  const pending = JSON.parse(sessionStorage.getItem('pendingSignup')||'null');
  if(!pending){ showToast('❌ Signup session expired. Please sign up again.'); go('s-signup-prof'); return; }
  showToast('🔐 Verifying code…');

  const codeOk = await verifyCustomOtp(pending.email, code);
  if(!codeOk){ showToast('❌ Invalid or expired code. Please try again.'); return; }

  const { data, error } = await sb.auth.signUp({ email: pending.email, password: pending.password });
  if(error){ showToast('❌ '+(error.message||JSON.stringify(error))); return; }
  if(!data.session){
    showToast('❌ Account created but not signed in — turn "Confirm email" OFF in Supabase Auth settings.');
    return;
  }
  await sb.from('user_profiles').insert([{
    user_id:    data.user.id,
    full_name:  pending.full_name,
    role:       'professor',
    department: pending.department
  }]);
  sessionStorage.removeItem('pendingSignup');
  const profile = await getProfile(data.user.id);
  currentUser    = data.user;
  currentProfile = profile;
  document.getElementById('p-sidebar-name').textContent = profile?.full_name||'';
  setAvatar('p-sidebar-avatar', profile?.full_name);
  go('s-professor'); pPage('p-dashboard');
  refreshProfViews();
  applyProfessorPermissions();
  showToast('✅ Account verified! Welcome, '+(profile?.full_name||'Professor')+'.');
}

async function resendCode(kind){
  const pending = JSON.parse(sessionStorage.getItem('pendingSignup')||'null');
  if(!pending){ showToast('❌ No pending signup found.'); return; }
  const sent = await sendCustomOtp(pending.email);
  if(!sent){ showToast('❌ Could not resend code. Please try again.'); return; }
  resetOtpTimer(kind);
  showToast('📧 Code resent! Check your email.');
}

// ── FORGOT PASSWORD ──
function showForgotStep(step){
  document.getElementById('forgot-step-email').style.display   = step==='email'   ? 'block':'none';
  document.getElementById('forgot-step-otp').style.display     = step==='otp'     ? 'block':'none';
  document.getElementById('forgot-step-newpass').style.display = step==='newpass' ? 'block':'none';
}

async function sendResetCode(){
  const email = document.getElementById('forgot-email').value.trim();
  if(!email){ showToast('⚠️ Please enter your email'); return; }
  showToast('🔐 Sending reset code…');
  const { error } = await sb.auth.resetPasswordForEmail(email);
  if(error){ showToast('❌ '+error.message); return; }
  sessionStorage.setItem('pendingReset', email);
  showForgotStep('otp');
  resetOtpTimer('reset');
  showToast('✅ Reset code sent! Check your email.');
}

async function resendResetCode(){
  const email = sessionStorage.getItem('pendingReset');
  if(!email){ showToast('❌ No pending reset found.'); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email);
  if(error){ showToast('❌ '+error.message); return; }
  resetOtpTimer('reset');
  showToast('📧 Code resent! Check your email.');
}

async function verifyResetOtp(){
  const code = readOtpCode('otp-reset');
  if(code.length<8){ showToast('⚠️ Please enter the full 8-digit code'); return; }
  const email = sessionStorage.getItem('pendingReset');
  if(!email){ showToast('❌ Reset session expired. Please try again.'); go('s-forgot'); showForgotStep('email'); return; }
  showToast('🔐 Verifying code…');
  const { error } = await sb.auth.verifyOtp({ email, token: code, type: 'recovery' });
  if(error){ showToast('❌ '+error.message); return; }
  showForgotStep('newpass');
}

async function submitNewPassword(){
  const p1 = document.getElementById('reset-newpass').value;
  const p2 = document.getElementById('reset-newpass2').value;
  if(!p1||p1.length<6){ showToast('⚠️ Password must be at least 6 characters'); return; }
  if(p1!==p2){ showToast('⚠️ Passwords do not match'); return; }
  showToast('🔐 Updating password…');
  const { error } = await sb.auth.updateUser({ password: p1 });
  if(error){ showToast('❌ '+error.message); return; }
  sessionStorage.removeItem('pendingReset');
  await sb.auth.signOut();
  showForgotStep('email');
  go('s-landing');
  showToast('✅ Password updated! Please log in.');
}

// ══════════════════════════════════════════════════════
//  STUDENT PAGES
// ══════════════════════════════════════════════════════
async function sPage(page){
  const target = document.getElementById('sp-'+page);
  if(!target){
    console.error(`sPage('${page}') aborted: no element with id="sp-${page}" found in the DOM. This usually means the student-dashboard fragment hasn't loaded yet (check the Network tab for a failed/slow fetch of Dashboard/student-dashboard.html).`);
    return;
  }
  document.querySelectorAll('#s-student .main-content > div').forEach(d=>d.style.display='none');
  target.style.display='block';
  document.querySelectorAll('#s-student .snav-item').forEach(a=>{
    a.classList.toggle('active', a.getAttribute('onclick')&&a.getAttribute('onclick').includes("'"+page+"'"));
  });
  if(page==='notifications' && currentUser) markNotifsSeen(currentUser.id);
  if(currentUser) await loadProjectsForStudent(currentUser.id);
  refreshStudentViews();
}

function refreshStudentViews(){
  if(!currentUser) return;
  const uid = currentUser.id;
  renderDashboard(uid);
  renderPortfolioPage(uid);
  renderProjectsPage(uid);
  renderNotifications(uid);
  // Defined in js/assignments.js — guarded in case that file hasn't loaded yet
  if(typeof renderAssignmentsPage === 'function') renderAssignmentsPage(uid);
}

// ── NOTIFICATIONS (student: alerts when work is approved or rejected) ──
function lastSeenNotifTime(uid){
  return new Date(localStorage.getItem('artfolio_notif_seen_'+uid) || 0);
}
function markNotifsSeen(uid){
  localStorage.setItem('artfolio_notif_seen_'+uid, new Date().toISOString());
}
function updateStudentNotifBadge(uid, notifs){
  const badge = document.getElementById('notif-badge');
  if(!badge) return;
  const lastSeen = lastSeenNotifTime(uid);
  const unread = notifs.filter(n => new Date(n.decisionAt||n.submittedAt) > lastSeen).length;
  if(unread > 0){ badge.textContent = unread>9 ? '9+' : unread; badge.classList.add('show'); }
  else { badge.classList.remove('show'); }
}

function renderNotifications(uid){
  const list = studentProjects[uid] || [];
  // NOTE: previously this deduped by portfolioId, so if a student had more than one
  // work under the same portfolio (e.g. two uploads in the same grading period), only
  // the FIRST approved/rejected work generated a notification card and the rest were
  // silently dropped. Every individual work now gets its own card.
  const notifs = list.filter(p=>{
    return p.status==='approved' || p.status==='rejected' || p.status==='submitted';
  }).sort((a,b)=> new Date(b.decisionAt||b.submittedAt) - new Date(a.decisionAt||a.submittedAt));

  updateStudentNotifBadge(uid, notifs);

  const lastSeen = lastSeenNotifTime(uid);
  const notifCardHtml = p => {
    const isApproved = p.status==='approved';
    const isRejected = p.status==='rejected';
    const icon  = isApproved ? '✅' : isRejected ? '❌' : '📤';
    const cls   = isApproved ? 'approved' : isRejected ? 'rejected' : 'pending';
    const title = isApproved ? 'Work Approved' : isRejected ? 'Work Rejected' : 'Work Uploaded';
    const isUnread = new Date(p.decisionAt||p.submittedAt) > lastSeen;
    let body = isApproved ? `"${esc(p.title)}" was approved by your professor.`
      : isRejected ? `"${esc(p.title)}" was rejected by your professor.`
      : `"${esc(p.title)}" was uploaded and is awaiting review.`;
    if(isApproved && p.finalGrade!=null) body += ` Grade: ${p.finalGrade}/100.`;
    if(p.feedbackComment) body += ` Comment: "${esc(p.feedbackComment)}"`;
    return `<div class="notif-item ${cls}" style="position:relative;">
      ${isUnread ? '<span style="position:absolute;top:14px;right:16px;width:8px;height:8px;border-radius:50%;background:var(--red);"></span>' : ''}
      <div class="ni-header"><span class="ni-icon">${icon}</span><span class="ni-title">${title}</span></div>
      <div class="ni-body">${body}</div>
      <div class="ni-time">${fmtDate(p.decisionAt||p.submittedAt)}</div>
    </div>`;
  };

  const notifListEl = document.getElementById('s-notif-list');
  if(notifListEl){
    notifListEl.innerHTML = notifs.length ? notifs.map(notifCardHtml).join('') : `<div style="font-size:13px;color:var(--text3);padding:20px 0;">No notifications yet.</div>`;
  }

  const dashRecentEl = document.getElementById('dash-recent-notifs');
  if(dashRecentEl){
    const recent = notifs.slice(0,3);
    dashRecentEl.innerHTML = recent.length ? recent.map(p=>{
      const isApproved = p.status==='approved';
      const isRejected = p.status==='rejected';
      const icon  = isApproved ? '✅' : isRejected ? '❌' : '📤';
      const bgCls = isApproved ? 'approved-bg' : 'pending-bg';
      const title = isApproved ? 'Work Approved' : isRejected ? 'Work Rejected' : 'Work Uploaded';
      const bodyVerb = isApproved ? 'approved' : isRejected ? 'rejected' : 'uploaded';
      return `<div class="notif-card ${bgCls}">
        <div class="notif-icon">${icon}</div>
        <div>
          <div class="notif-title">${title}</div>
          <div class="notif-body">"${esc(p.title)}" was ${bodyVerb}.</div>
          <div class="notif-time">${fmtDate(p.decisionAt||p.submittedAt)}</div>
        </div>
      </div>`;
    }).join('') : `<div style="font-size:13px;color:var(--text3);">No notifications yet.</div>`;
  }
}

function renderDashboard(uid){
  const list     = studentProjects[uid] || [];
  const approved = list.filter(p=>p.status==='approved');
  const pending  = list.filter(p=>p.status==='submitted'||p.status==='draft');
  const totalEl  = document.getElementById('dash-total');
  if(!totalEl) return;
  totalEl.textContent = list.length;
  document.getElementById('dash-approved').textContent     = approved.length;
  document.getElementById('dash-pending').textContent      = pending.length;
  document.getElementById('dash-approval-rate').textContent= (list.length ? Math.round(approved.length/list.length*100):0)+'% approval rate';
  document.getElementById('s-welcome-sub').textContent     = `You have ${list.length} file${list.length===1?'':'s'} uploaded`;
  const recent = list.slice(0,3);
  document.getElementById('dash-recent-uploads').innerHTML = recent.length
    ? recent.map(p=>{
        const thumb = fileIsImage(p.file) ? `<img class="upload-thumb" src="${esc(p.file.dataUrl)}" alt="${esc(p.title)}"/>` : `<div class="upload-thumb-placeholder">${fileIsVideo(p.file)?'🎬':'🖼️'}</div>`;
        const badge = p.status==='approved'?'approved':p.status==='rejected'?'rejected':'pending';
        return `<div class="upload-card">${thumb}<span class="upload-status-badge badge-${badge}">${p.status}</span></div>`;
      }).join('')
    : `<div class="empty-state"><p>No uploads yet — share your first project!</p></div>`;
}

function renderPortfolioPage(uid){
  const pub = document.getElementById('pt-public');
  if(!pub) return;
  const list      = studentProjects[uid] || [];
  const approved  = list.filter(p=>p.status==='approved');
  const publicOnes= approved.filter(p=>p.isPublic);

  const cardHtml = p => {
    const thumb = fileIsImage(p.file) ? `<img class="pwork-thumb" src="${esc(p.file.dataUrl)}" alt="${esc(p.title)}"/>` : `<div class="upload-thumb-placeholder" style="height:200px">${fileIsVideo(p.file)?'🎬':'🖼️'}</div>`;
    const toggleLabel = p.isPublic ? '🔒 Remove from Public' : '🌐 Add to Public';
    // QR shows automatically (no button/click needed) the moment a work is public —
    // it's just a goqr.me image URL, so no async call required to render it.
    // Clicking it opens the bigger printable version + download (student-only, since
    // this card only ever renders on the logged-in student's own dashboard).
    const qrThumbHtml = p.isPublic
      ? `<img class="pwork-qr-thumb" src="${buildGoQrImageUrl(buildWorkPublicUrl(p.id), 90)}" alt="QR code" title="Tap to download" onclick="event.stopPropagation();showWorkQr('${p.id}')" style="position:absolute;top:8px;right:8px;width:44px;height:44px;background:#fff;border-radius:6px;padding:3px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15);z-index:2;"/>`
      : '';
    return `<div class="pwork-card" style="position:relative;">${thumb}
      ${qrThumbHtml}
      <div class="pwork-overlay">
        <button class="btn-view-project" onclick="viewStudentProject('${p.id}')">👁 View Project</button>
        <button class="btn-view-project" onclick="event.stopPropagation();togglePublic('${p.id}')">${toggleLabel}</button>
      </div>
      <span class="pwork-badge badge-approved" style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;">${p.isPublic ? '🌐 Public' : 'Approved'}</span>
      <div class="pwork-info">
        <div class="pwork-title">${esc(p.title)}</div>
        <div class="pwork-cat">${esc(p.category)} · ${esc(p.gradingPeriod)}</div>
        <div class="pwork-desc">${esc(p.desc||'')}</div>
      </div></div>`;
  };
  pub.innerHTML = publicOnes.length ? publicOnes.map(cardHtml).join('') : `<div class="empty-state"><p>Nothing public yet. Open an approved work and tap "Add to Public" so it shows up when people search for you.</p></div>`;
  document.getElementById('pt-approved').innerHTML = approved.length ? approved.map(cardHtml).join('') : `<div class="empty-state"><p>No approved works yet.</p></div>`;
}

// ── TOGGLE PUBLIC VISIBILITY (student: choose which approved works strangers can find via search) ──
async function togglePublic(itemId){
  if(!currentUser) return;
  const list = studentProjects[currentUser.id] || [];
  const item = list.find(p=>p.id===itemId);
  if(!item){ showToast('⚠️ Work not found'); return; }
  if(item.status !== 'approved'){ showToast('⚠️ Only approved works can be made public.'); return; }
  const newValue = !item.isPublic;
  try{
    // .select() after update lets us see exactly which rows were changed — without it,
    // Supabase/RLS can silently update 0 rows and still report "no error," which looks
    // like success in the UI (and reverts on refresh) while nothing actually changed.
    const { data: updatedRows, error } = await sb.from('portfolio_items').update({ is_public: newValue }).eq('id', itemId).select();
    if(error) throw error;
    if(!updatedRows || updatedRows.length === 0){
      throw new Error('Nothing was updated — this is usually a Supabase RLS permissions issue, not a bug in the app. Check that an UPDATE policy exists on portfolio_items allowing the owning student to update is_public on their own rows.');
    }
    item.isPublic = newValue;
    refreshStudentViews();
    // Keep the preview modal's button in sync if it's currently open on this item
    if(currentPreviewItemId === itemId) viewStudentProject(itemId);

    if(newValue){
      // Just went public — this is the ONLY moment a QR makes sense (a professor
      // reviewing a private/pending submission has zero use for one), so generate
      // and show it immediately instead of making the student click a second button.
      showToast('🌐 Added to your public portfolio! Generating QR code…');
      if(typeof showWorkQr === 'function') showWorkQr(itemId);
    } else {
      showToast('🔒 Removed from public portfolio.');
    }
  }catch(err){
    console.error('togglePublic error:', err);
    showToast('❌ Error: '+err.message);
  }
}

// ── VIEW PROJECT (student: preview an approved work from the portfolio gallery) ──
let currentPreviewItemId = null;
function viewStudentProject(itemId){
  if(!currentUser) return;
  const list = studentProjects[currentUser.id] || [];
  const p = list.find(x=>x.id===itemId);
  if(!p){ showToast('⚠️ Project not found'); return; }
  currentPreviewItemId = itemId;

  document.getElementById('spv-title').textContent = p.title;
  document.getElementById('spv-meta').textContent   = `${p.category} · ${p.gradingPeriod}`;
  document.getElementById('spv-desc').textContent   = p.desc || '(no description)';

  const badge = document.getElementById('spv-status-badge');
  const badgeCls = p.status==='approved' ? 'badge-approved' : p.status==='rejected' ? 'badge-rejected' : 'badge-pending';
  badge.className = 'upload-status-badge '+badgeCls;
  badge.style.position = 'static';
  badge.textContent = p.status==='draft' ? 'withdrawn' : p.status;

  const img = document.getElementById('spv-img');
  const vid = document.getElementById('spv-video');
  const ph  = document.getElementById('spv-placeholder');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  if(fileIsImage(p.file)){
    img.src = p.file.dataUrl; img.style.display='block'; vid.style.display='none'; ph.style.display='none';
  } else if(fileIsVideo(p.file)){
    vid.src = p.file.dataUrl; vid.style.display='block'; img.style.display='none'; ph.style.display='none';
  } else {
    img.style.display='none'; vid.style.display='none'; ph.style.display='flex';
  }

  // Star rating the professor left when approving/rejecting
  const starsBox = document.getElementById('spv-stars-box');
  if(p.rating > 0){
    document.getElementById('spv-stars').textContent = '★'.repeat(p.rating) + '☆'.repeat(5-p.rating);
    starsBox.style.display = 'block';
  } else {
    starsBox.style.display = 'none';
  }

  // Full grade breakdown
  const gradeBox = document.getElementById('spv-grade-box');
  if(p.finalGrade != null){
    document.getElementById('spv-grade').textContent = p.finalGrade + '/100';
    document.getElementById('spv-c1').textContent = p.creativityScore ?? '—';
    document.getElementById('spv-c2').textContent = p.techniqueScore ?? '—';
    document.getElementById('spv-c3').textContent = p.compositionScore ?? '—';
    const remarksEl = document.getElementById('spv-remarks');
    if(p.gradeRemarks){ remarksEl.textContent = '"'+p.gradeRemarks+'"'; remarksEl.style.display='block'; }
    else { remarksEl.style.display='none'; }
    gradeBox.style.display = 'block';
  } else {
    gradeBox.style.display = 'none';
  }

  // Professor's comment left on approval/rejection
  const commentBox = document.getElementById('spv-comment-box');
  if(p.feedbackComment){
    document.getElementById('spv-comment').textContent = '"'+p.feedbackComment+'"';
    commentBox.style.display = 'block';
  } else {
    commentBox.style.display = 'none';
  }

  // Public/private toggle — only approved works can be made public.
  // The QR view button only shows once the work is ALREADY public — a
  // pending/private work has no shareable QR to look at.
  const pubBtn    = document.getElementById('spv-public-toggle-btn');
  const pubHint   = document.getElementById('spv-public-hint');
  const qrBtn     = document.getElementById('spv-qr-btn');
  const deleteBtn = document.getElementById('spv-delete-btn');
  const unsubmitBtn = document.getElementById('spv-unsubmit-btn');
  if(p.status === 'approved'){
    pubBtn.textContent = p.isPublic ? '🔒 Remove from Public' : '🌐 Add to Public';
    pubBtn.style.display = 'block';
    pubHint.style.display = 'block';
    if(qrBtn) qrBtn.style.display = p.isPublic ? 'block' : 'none';
    if(deleteBtn) deleteBtn.style.display = 'none'; // already approved — nothing left to undo
    if(unsubmitBtn) unsubmitBtn.style.display = 'none';
  } else {
    pubBtn.style.display = 'none';
    pubHint.style.display = 'none';
    if(qrBtn) qrBtn.style.display = 'none';
    if(p.status === 'submitted'){
      // Pending — pull it back from review first; deleting outright would remove it
      // from the professor's queue without ever going through that step.
      if(unsubmitBtn) unsubmitBtn.style.display = 'block';
      if(deleteBtn) deleteBtn.style.display = 'none';
    } else {
      if(unsubmitBtn) unsubmitBtn.style.display = 'none';
      if(deleteBtn) deleteBtn.style.display = 'block';
    }
  }

  document.getElementById('studentProjectPreviewOverlay').classList.add('open');
}
function closeStudentProjectPreview(){
  document.getElementById('studentProjectPreviewOverlay').classList.remove('open');
  const vid = document.getElementById('spv-video');
  if(vid){ vid.pause(); }
  currentPreviewItemId = null;
}
async function deleteWorkFromPreview(){
  if(!currentPreviewItemId) return;
  const id = currentPreviewItemId;
  closeStudentProjectPreview();
  await deleteWork(id);
}
async function unsubmitWorkFromPreview(){
  if(!currentPreviewItemId) return;
  const id = currentPreviewItemId;
  closeStudentProjectPreview();
  await unsubmitWork(id);
}

// ── DOWNLOAD WORK (student: save their own submission back to their device) ──
// Works as a personal archive — the file comes straight from Cloudinary, so
// the student always gets the exact original they uploaded, whatever its type
// (image, video, PDF…). Fetched as a blob first so the browser saves it with
// the work's title instead of just opening it in a new tab. If the fetch ever
// fails (e.g. offline quirks), falls back to opening the file in a new tab.
function downloadFileName(p){
  const base = ((p && p.title) || 'artfolio-work').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'artfolio-work';
  const m = (p && p.file && p.file.dataUrl || '').split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return base + (m ? '.' + m[1].toLowerCase() : '');
}
async function downloadWork(itemId){
  if(!currentUser) return;
  const list = studentProjects[currentUser.id] || [];
  const p = list.find(x => x.id === itemId);
  if(!p || !p.file || !p.file.dataUrl){ showToast('⚠️ File not available for download'); return; }
  showToast('⬇️ Downloading…');
  try{
    const res = await fetch(p.file.dataUrl, { mode: 'cors' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName(p);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('✅ Download started!');
  }catch(err){
    console.warn('downloadWork blob fetch failed, opening in new tab:', err);
    window.open(p.file.dataUrl, '_blank');
  }
}

function renderProjectsPage(uid){
  const approvedEl = document.getElementById('approved-p');
  if(!approvedEl) return;
  const list = studentProjects[uid] || [];
  const cardHtml = p => {
    const thumb = fileIsImage(p.file) ? `<img class="project-thumb" src="${esc(p.file.dataUrl)}" alt="${esc(p.title)}"/>` : `<div class="upload-thumb-placeholder" style="height:180px">${fileIsVideo(p.file)?'🎬':'🖼️'}</div>`;
    const canDelete = p.status !== 'approved' && p.status !== 'submitted'; // pending works are unsubmitted first, not deleted outright; approved works have nothing left to undo
    const deleteBtn = canDelete
      ? `<button class="btn-cancel" style="margin-top:10px;width:100%;color:var(--red);border-color:rgba(244,67,54,.4);justify-content:center;" onclick="event.stopPropagation();deleteWork('${p.id}')">🗑️ Delete Submission</button>`
      : '';
    const unsubmitBtn = p.status==='submitted'
      ? `<button class="btn-cancel" style="margin-top:10px;width:100%;justify-content:center;" onclick="event.stopPropagation();unsubmitWork('${p.id}')">↩️ Unsubmit</button>`
      : '';
    const withdrawnNote = p.status==='draft'
      ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--orange);">↩️ Withdrawn from review. Upload again for the same grading period to resubmit, or delete it below.</div>`
      : '';
    const feedbackHtml = (p.status==='approved' && (p.finalGrade!=null || p.feedbackComment))
      ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          ${p.finalGrade!=null ? `<div style="font-size:13px;font-weight:700;color:var(--dark);">Grade: ${p.finalGrade}/100</div>` : ''}
          ${p.feedbackComment ? `<div style="font-size:12px;color:var(--text2);font-style:italic;margin-top:4px;">"${esc(p.feedbackComment)}"</div>` : ''}
        </div>`
      : '';
    const publicToggleHtml = p.status==='approved'
      ? `<button class="btn-outline" style="margin-top:10px;" onclick="event.stopPropagation();togglePublic('${p.id}')">${p.isPublic ? '🔒 Remove from Public' : '🌐 Add to Public'}</button>`
      : '';
    // Every card gets a Download button — approved, pending, rejected, or
    // withdrawn. It's the student's own file, so it's always theirs to keep.
    const downloadBtnHtml = `<button class="btn-outline" style="margin-top:10px;" onclick="event.stopPropagation();downloadWork('${p.id}')">⬇️ Download</button>`;
    const rejectedHtml = (p.status==='rejected' && p.feedbackComment)
      ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <div style="font-size:12px;color:var(--red);font-weight:600;">Professor's Comment:</div>
          <div style="font-size:12px;color:var(--text2);font-style:italic;margin-top:2px;">"${esc(p.feedbackComment)}"</div>
        </div>`
      : '';
    return `<div class="project-card" style="cursor:pointer;" onclick="viewStudentProject('${p.id}')">${thumb}
      <div class="project-info">
        <div class="project-title">${esc(p.title)}</div>
        <div class="project-cat">${esc(p.category)} · ${esc(p.gradingPeriod)}</div>
        <div class="project-desc">${esc(p.desc||'')}</div>
        ${feedbackHtml}
        ${rejectedHtml}
        ${withdrawnNote}
        ${publicToggleHtml}
        ${downloadBtnHtml}
        ${unsubmitBtn}
        ${deleteBtn}
      </div></div>`;
  };
  approvedEl.innerHTML = list.filter(p=>p.status==='approved').map(cardHtml).join('') || `<div class="empty-state"><p>No Approved Works yet.</p></div>`;
  document.getElementById('pending-p').innerHTML  = list.filter(p=>p.status==='submitted'||p.status==='draft').map(cardHtml).join('') || `<div class="empty-state"><p>Nothing pending for review yet.</p></div>`;
  document.getElementById('rejected-p').innerHTML = list.filter(p=>p.status==='rejected').map(cardHtml).join('') || `<div class="empty-state"><p>No Rejected Works yet.</p></div>`;
  renderGradesPage(uid);
}

// ── UNSUBMIT (student: pull a pending submission back from professor review) ──
// This does NOT delete the file — it just reverts the parent portfolio's status
// back to 'draft' so it drops out of the professor's "Pending" queue. Note that
// status lives on the shared portfolio row (per student + grading period), so
// this affects every item submitted under the same period, not just this one.
async function unsubmitWork(itemId){
  if(!currentUser) return;
  const list = studentProjects[currentUser.id] || [];
  const localItem = list.find(p=>p.id===itemId);
  if(!localItem){ showToast('⚠️ Submission not found'); return; }
  if(localItem.status !== 'submitted'){ showToast('⚠️ Only pending submissions can be unsubmitted.'); return; }
  if(!confirm('Unsubmit this work? It will be pulled back from professor review. You can resubmit later by uploading again for the same grading period, or delete it entirely.')) return;
  showToast('↩️ Unsubmitting…');
  try{
    const { error } = await sb.from('portfolios').update({
      status: 'draft', updated_at: new Date().toISOString()
    }).eq('id', localItem.portfolioId);
    if(error) throw error;
    list.forEach(p=>{ if(p.portfolioId===localItem.portfolioId) p.status='draft'; });
    showToast('✅ Submission unsubmitted — pulled back from review.');
    refreshStudentViews();
  }catch(err){
    console.error('unsubmitWork error:', err);
    showToast('❌ Error: '+err.message);
  }
}

// ── DELETE WORK (student: any of their own submissions, incl. approved) ──
async function deleteWork(itemId){
  if(!currentUser) return;
  const list = studentProjects[currentUser.id] || [];
  const localItem = list.find(p=>p.id===itemId);
  const confirmMsg = (localItem && localItem.status==='approved')
    ? 'This work has already been APPROVED and graded. Deleting it will permanently remove it from your portfolio and its grade record. This cannot be undone. Continue?'
    : 'Delete this submission? This cannot be undone.';
  if(!confirm(confirmMsg)) return;
  showToast('🗑️ Deleting…');
  try{
    // Cascade: remove any similarity_logs rows that reference this item first,
    // in either direction, otherwise the foreign key will block deletion.
    await sb.from('similarity_logs').delete().eq('checked_item_id', itemId);
    await sb.from('similarity_logs').delete().eq('matched_item_id', itemId);

    // .select() after delete lets us see exactly which rows were removed —
    // without it, Supabase/RLS can silently delete 0 rows and still report
    // "no error," which looks like success but leaves the record untouched.
    const { data: deletedRows, error } = await sb.from('portfolio_items').delete().eq('id', itemId).select();
    if(error) throw error;
    if(!deletedRows || deletedRows.length === 0){
      throw new Error('Nothing was deleted — this is usually a Supabase permissions (RLS) issue, not a bug in the app. Check that a DELETE policy exists on portfolio_items for the owning student.');
    }

    // Delete the actual file from Cloudinary via a Supabase Edge Function
    // (deletion requires an API secret that must never live in browser JS,
    // so the Edge Function holds that secret server-side instead).
    const publicId = localItem && localItem.cloudinaryPublicId;
    if(publicId){
      try{
        const { error: fnErr } = await sb.functions.invoke('delete-cloudinary-asset', { body: { publicId } });
        if(fnErr) console.error('Cloudinary cleanup error:', fnErr);
      }catch(fnErr){
        console.error('Cloudinary cleanup error:', fnErr);
        // Don't block the user on this — the DB record is already gone either way.
      }
    }

    if(studentProjects[currentUser.id]){
      studentProjects[currentUser.id] = studentProjects[currentUser.id].filter(p=>p.id!==itemId);
    }
    showToast('✅ Submission deleted.');
    refreshStudentViews();
  }catch(err){
    console.error('deleteWork error:', err);
    showToast('❌ Delete failed: '+err.message);
  }
}

// ── MY GRADES (per academic period, deduplicated by portfolio) ──
function renderGradesPage(uid){
  const el = document.getElementById('grades-p');
  if(!el) return;
  const list = studentProjects[uid] || [];
  const seen = new Set();
  const periodOrder = { prelim:0, midterm:1, prefinals:2, finals:3 };
  const portfoliosGraded = list.filter(p=>{
    if(seen.has(p.portfolioId)) return false;
    seen.add(p.portfolioId);
    return p.finalGrade !== null && p.finalGrade !== undefined;
  }).sort((a,b)=>(periodOrder[a.gradingPeriod]??9)-(periodOrder[b.gradingPeriod]??9));

  if(portfoliosGraded.length===0){
    el.innerHTML = `<div class="empty-state"><p>No grades released yet. Your professor will post grades here once your submissions are reviewed.</p></div>`;
    return;
  }
  const periodLabel = p => ({prelim:'Prelim',midterm:'Midterm',prefinals:'Pre-Finals',finals:'Finals'}[p] || p);
  el.innerHTML = portfoliosGraded.map(p=>`
    <div class="review-decision" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div class="rd-title" style="margin:0;">${esc(periodLabel(p.gradingPeriod))} — ${esc(p.category)}</div>
        <span style="font-size:22px;font-weight:700;color:var(--dark);">${p.finalGrade}/100</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px;">
        <div class="sim-by">Creativity: <strong style="color:var(--dark)">${p.creativityScore ?? '—'}/40</strong></div>
        <div class="sim-by">Technique: <strong style="color:var(--dark)">${p.techniqueScore ?? '—'}/35</strong></div>
        <div class="sim-by">Composition: <strong style="color:var(--dark)">${p.compositionScore ?? '—'}/25</strong></div>
      </div>
      ${p.gradeRemarks ? `<div class="sim-by" style="font-style:italic;">"${esc(p.gradeRemarks)}"</div>` : ''}
    </div>
  `).join('');
}

// ── PORTFOLIO TABS ──
function portTab(el,tab){
  document.querySelectorAll('.ptab-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('pt-public').style.display   = tab==='public'   ? 'grid':'none';
  document.getElementById('pt-approved').style.display = tab==='approved' ? 'grid':'none';
}

// ── PROJECT FILTER ──
function projTab(el,tab){
  document.querySelectorAll('.filter-tab').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  ['approved-p','pending-p','rejected-p','grades-p'].forEach(id=>{
    const el2=document.getElementById(id);
    if(!el2) return;
    if(id!==tab){ el2.style.display='none'; return; }
    el2.style.display = (id==='approved-p'||id==='pending-p') ? 'grid' : 'block';
  });
}

// ══════════════════════════════════════════════════════
//  UPLOAD WORK
// ══════════════════════════════════════════════════════

// Auto-resolve the single subject for this portfolio system (no per-upload selection needed)
let defaultSubjectId = null;
async function populateSubjectDropdown(){
  const subjects = await loadSubjects();
  allSubjectsCache = subjects; // cache for resolving subject names elsewhere (e.g. after upload)
  defaultSubjectId = subjects.length ? subjects[0].id : null;
}

// ══════════════════════════════════════════════════════
//  SECTIONS — professor-managed list students pick from at signup
//  (replaces the old free-text "Section" field so names stay consistent
//  and can later be used to filter/archive grades per section)
// ══════════════════════════════════════════════════════
async function loadSections(){
  try{
    const { data, error } = await sb.from('sections').select('id,name').order('name');
    if(error) throw error;
    return data || [];
  }catch(err){
    console.error('loadSections error:', err);
    return [];
  }
}

// Populates the Section <select> on the student signup page. Runs on app
// boot (before login) so the dropdown is ready whenever someone lands on
// the signup screen — same pattern as populateSubjectDropdown().
async function populateSectionDropdown(){
  const sel = document.getElementById('signup-student-section');
  if(!sel) return;
  const sections = await loadSections();
  sel.innerHTML = '<option value="">Select Section</option>' +
    sections.map(s=>`<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
}

function handleUploadFileSelect(e){ processUploadFile(e.target.files&&e.target.files[0]); }
function handleUploadDrop(e){
  e.preventDefault();
  document.getElementById('up-drop-zone').style.borderColor='var(--border)';
  processUploadFile(e.dataTransfer.files&&e.dataTransfer.files[0]);
}
async function processUploadFile(file){
  if(!file) return;
  pendingRawFile    = file;
  pendingUploadFile = { name:file.name, sizeBytes:file.size, mimeType:file.type, dataUrl:null };
  document.getElementById('up-drop-text').textContent = `✅ ${file.name} selected (${formatBytes(file.size)})`;
  if(file.type.startsWith('image/')&&file.size<=MAX_PREVIEW_BYTES){
    try{ pendingUploadFile.dataUrl = await readFileAsDataUrl(file); }catch(e){}
  }
}

function cancelUpload(){
  pendingRawFile=null; pendingUploadFile=null;
  document.getElementById('up-title').value='';
  document.getElementById('up-desc').value='';
  document.getElementById('up-drop-text').textContent='Drop files here or click to upload';
  sPage('dashboard');
}

async function submitWork(){
  if(!currentUser){ showToast('⚠️ Please sign in first'); return; }
  const title         = document.getElementById('up-title').value.trim();
  const desc          = document.getElementById('up-desc').value.trim();
  const subjectId     = defaultSubjectId;
  const gradingPeriod = document.getElementById('up-grading-period') ? document.getElementById('up-grading-period').value : 'prelim';
  if(!title)     { showToast('⚠️ Please enter a project title'); return; }
  // subjectId is optional for multimedia-only systems — we proceed with null if no subjects are configured
  if(!pendingRawFile){ showToast('⚠️ Please select a file to upload'); return; }
  try{
    // 1. Fingerprint locally first (dHash + AI embedding), then run the 90%+
    // originality check BEFORE uploading to Cloudinary — a duplicate never
    // leaves the browser, so no orphan file or DB row is ever created.
    // The block check ignores Imagga tags (see SIMILARITY_BLOCK_THRESHOLD),
    // so no Cloudinary URL is needed for this step.
    showToast('🧠 Comparing image content…');
    const [ourPhash, embedding] = await Promise.all([
      computePerceptualHash(pendingRawFile),
      (typeof embFromFile === 'function') ? embFromFile(pendingRawFile) : Promise.resolve(null)
    ]);

    // 1b. Play the originality-check scanning animation while comparing
    // against every existing submission; blocks outright at 90%+ similarity
    // — checked BEFORE uploading/saving, so a duplicate never becomes a
    // real submission at all, not just a flagged one the professor has to
    // catch manually.
    const isDuplicate = await runOriginalityCheckUI(ourPhash, [], null, embedding, currentUser.id); // plain Upload Work — no assignment
    if(isDuplicate){
      pendingRawFile = null; pendingUploadFile = null;
      document.getElementById('up-drop-text').textContent = 'Drop files here or click to upload';
      return;
    }

    // 1c. Clear — now upload to Cloudinary.
    const cloud = await uploadToCloudinary(pendingRawFile);
    // 1d. Fetch Imagga tags for the uploaded image (via Edge Function — secret stays server-side).
    // Only meaningful for images; fails quietly (empty array) for non-image files or if the
    // Imagga quota/credentials aren't set up. Tags never block — they only feed the post-save professor flag.
    showToast('🏷️ Analyzing image content…');
    const imaggaTags = (pendingRawFile.type && pendingRawFile.type.startsWith('image/')) ? await fetchImaggaTags(cloud.url) : [];

    showToast('💾 Saving to database…');
    // 2. Save to Supabase using real schema
    const { item } = await saveItemToSupabase(currentUser.id, {
      title, desc, subjectId, gradingPeriod,
      fileUrl: cloud.url, fileType: pendingRawFile.type,
      fileSize: pendingRawFile.size, cloudinaryId: cloud.publicId, phash: ourPhash, imaggaTags, embedding
    });
    // 2b. Run similarity check against other students' uploads using our computed hash + tags
    runSimilarityCheck(item.id, ourPhash, imaggaTags, embedding, null, currentUser.id); // plain Upload Work — no assignment
    // 3. Update local cache — resolve real subject name instead of leaving the raw UUID
    const subjMatch    = allSubjectsCache.find(s=>String(s.id)===String(subjectId));
    const categoryName = subjMatch ? (subjMatch.name||subjMatch.code) : 'General';
    const local = {
      id: item.id, portfolioId: item.portfolio_id,
      title, desc, category: categoryName, gradingPeriod,
      status: 'submitted',
      file:{ dataUrl: cloud.url, mimeType: pendingRawFile.type, sizeBytes: pendingRawFile.size, isCloudinary:true },
      cloudinaryPublicId: cloud.publicId,
      submittedAt: item.uploaded_at, rating:0, comment:''
    };
    if(!studentProjects[currentUser.id]) studentProjects[currentUser.id]=[];
    studentProjects[currentUser.id].unshift(local);
    // Reset form
    pendingRawFile=null; pendingUploadFile=null;
    document.getElementById('up-title').value='';
    document.getElementById('up-desc').value='';
    document.getElementById('up-drop-text').textContent='Drop files here or click to upload';
    showToast('✅ Work submitted for professor review!');
    await sPage('projects');
    switchToProjectsTab('pending-p');
  }catch(err){
    console.error(err);
    showToast('❌ Upload failed: '+err.message);
  }
}

// Programmatically activate a Projects-page tab (Approved/Pending/Rejected/Grades)
// by clicking the matching filter-tab button — keeps active-state styling in sync
// instead of duplicating projTab's DOM logic here.
function switchToProjectsTab(tabId){
  const btn = Array.from(document.querySelectorAll('#sp-projects .filter-tab'))
    .find(b => (b.getAttribute('onclick')||'').includes("'"+tabId+"'"));
  if(btn) projTab(btn, tabId);
}

// ══════════════════════════════════════════════════════
//  PROFESSOR PAGES
// ══════════════════════════════════════════════════════
function pPage(page){
  document.querySelectorAll('#s-professor .main-content > div').forEach(d=>d.style.display='none');
  document.getElementById(page).style.display='block';
  document.querySelectorAll('#s-professor .snav-item').forEach(a=>{
    a.classList.toggle('active', a.getAttribute('onclick')&&a.getAttribute('onclick').includes("'"+page+"'"));
  });
  if(page==='p-dashboard'||page==='p-submissions') refreshProfViews();
  if(page==='p-students') renderStudentsPage();
  if(page==='p-rankings') loadAndRenderRankings();
  // Defined in js/assignments.js — guarded in case that file hasn't loaded yet
  if(page==='p-assignments' && typeof renderProfAssignmentsPage === 'function') renderProfAssignmentsPage();
  if(page==='p-archives' && typeof renderArchivesPage === 'function') renderArchivesPage();
}

// ══════════════════════════════════════════════════════
//  STUDENTS PAGE — Sections → Students in that section → Works
//  A "section" is just the professor-managed list from Grade
//  Archives (js/grade-archives.js). A student "belongs" to a
//  section simply because user_profiles.section matches that
//  section's name (set at sign-up, editable in Edit Profile).
//  There is no separate enrollment table — unenrolling a student
//  just clears that text field back to null.
// ══════════════════════════════════════════════════════
let _allStudentsCache      = [];    // every signed-up student — used for lookups (rankings, detail view)
let _studentSections       = [];    // sections list, same shape as grade-archives.js's _sectionsCache
let _currentSectionStudents= [];    // students currently shown in the "students in section" list
let currentSectionId       = null;  // section currently open in the "students in section" view

async function loadAllStudentProfiles(){
  const { data, error } = await sb
    .from('user_profiles')
    .select('user_id, full_name, student_id, section, year_level')
    .eq('role', 'student')
    .order('full_name');
  if(error){ console.error('loadAllStudentProfiles error:', error); return []; }
  return data || [];
}

// Kept for other callers (Overall Rankings) that just need the lookup cache populated.
async function loadAndRenderStudents(){
  _allStudentsCache = await loadAllStudentProfiles();
  return _allStudentsCache;
}

function studentInitial(name){
  const firstName = (name||'').trim().split(/\s+/)[0] || '';
  const match = firstName.match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : '?';
}

// ── STEP 1: SECTIONS LIST (entry point — pPage() calls this for p-students) ──
async function renderStudentsPage(){
  currentSectionId = null;
  const sectionsView = document.getElementById('p-students-sections');
  const inSectionView = document.getElementById('p-students-in-section');
  if(sectionsView) sectionsView.style.display = 'block';
  if(inSectionView) inSectionView.style.display = 'none';

  const el = document.getElementById('p-sections-list');
  if(!el) return;
  el.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:20px 0;">Loading sections…</div>`;

  try{
    const [{ data: sections, error }, students] = await Promise.all([
      sb.from('sections').select('id,name,school_year,semester').order('name'),
      loadAllStudentProfiles()
    ]);
    if(error) throw error;
    _studentSections  = sections || [];
    _allStudentsCache = students;
  }catch(err){
    console.error('renderStudentsPage error:', err);
    _studentSections = [];
  }

  if(!_studentSections.length){
    el.innerHTML = `<div class="empty-state"><p>No sections yet. Add one from Grade Archives — students will be able to pick it at sign-up, and it'll show up here once they do.</p></div>`;
    return;
  }

  el.innerHTML = _studentSections.map(s=>{
    const count = _allStudentsCache.filter(st=>st.section===s.name).length;
    return `<div class="section-group" onclick="openSectionStudents('${s.id}')">
      <div class="section-group-info">
        <div class="section-name">${esc(s.name)}</div>
        <div class="section-year">${esc(s.school_year||'No school year set')} &middot; ${esc(s.semester||'')} &middot; ${count} student${count===1?'':'s'} enrolled</div>
      </div>
      <button class="btn-view-sm" onclick="event.stopPropagation();openSectionStudents('${s.id}')">👁 View</button>
    </div>`;
  }).join('');
}

// ── STEP 2: STUDENTS IN A SECTION ──
function renderSectionStudentsList(students){
  const el = document.getElementById('p-section-students-list');
  if(!el) return;
  if(!students.length){
    el.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:20px 0;">No students enrolled in this section yet.</div>`;
    return;
  }
  el.innerHTML = students.map(s=>{
    const meta = [s.student_id||'No ID', s.year_level||'Year Level'].join(' · ');
    return `<div class="student-row" onclick="viewStudentProfile('${s.user_id}')">
      <div class="student-ava"><div class="avatar-initial" style="background:${avatarColor(s.full_name)};width:100%;height:100%;">${esc(studentInitial(s.full_name))}</div></div>
      <div class="student-row-info">
        <div class="student-row-name">${esc(s.full_name||'Student')}</div>
        <div class="student-row-meta">${esc(meta)}</div>
      </div>
      <button class="btn-view-sm" onclick="event.stopPropagation();viewStudentProfile('${s.user_id}')">👁 View</button>
      <button class="btn-cancel" style="padding:8px 12px;margin-left:8px;color:var(--red);border-color:rgba(244,67,54,.4);flex-shrink:0;" title="Remove this student from the section" onclick="event.stopPropagation();unenrollStudent('${s.user_id}','${esc((s.full_name||'this student').replace(/'/g,"\\'"))}')">↩️ Unenroll</button>
    </div>`;
  }).join('');
}

async function openSectionStudents(sectionId){
  const section = _studentSections.find(s=>s.id===sectionId);
  if(!section){ showToast('⚠️ Section not found'); return; }
  currentSectionId = sectionId;

  document.getElementById('p-students-sections').style.display = 'none';
  document.getElementById('p-students-in-section').style.display = 'block';
  document.getElementById('psx-section-title').textContent = section.name;
  document.getElementById('psx-section-meta').textContent = [section.school_year, section.semester].filter(Boolean).join(' · ') || '—';
  const searchBox = document.getElementById('psx-search');
  if(searchBox) searchBox.value = '';

  const el = document.getElementById('p-section-students-list');
  if(el) el.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:20px 0;">Loading students…</div>`;

  // Reload fresh — catches anyone who enrolled/unenrolled since the sections list was loaded
  _allStudentsCache = await loadAllStudentProfiles();
  _currentSectionStudents = _allStudentsCache.filter(s=>s.section===section.name);
  renderSectionStudentsList(_currentSectionStudents);
}

function backToSections(){
  document.getElementById('p-students-in-section').style.display = 'none';
  document.getElementById('p-students-sections').style.display = 'block';
  currentSectionId = null;
  renderStudentsPage(); // refresh counts in case something changed
}

function filterSectionStudents(q){
  const query = (q||'').trim().toLowerCase();
  if(!query){ renderSectionStudentsList(_currentSectionStudents); return; }
  const filtered = _currentSectionStudents.filter(s=>
    (s.full_name||'').toLowerCase().includes(query) ||
    (s.student_id||'').toLowerCase().includes(query)
  );
  renderSectionStudentsList(filtered);
}

// ── UNENROLL (professor: remove a student from a section without deleting their account) ──
async function unenrollStudent(userId, name){
  if(!confirm(`Unenroll ${name} from this section? They'll stay signed up and keep all their work — only their Section is cleared. Already-saved grades keep the section they were graded under and won't change.`)) return;
  showToast('💾 Unenrolling…');
  try{
    const { data: updatedRows, error } = await sb.from('user_profiles').update({ section: null }).eq('user_id', userId).select();
    if(error) throw error;
    if(!updatedRows || updatedRows.length === 0){
      throw new Error('Nothing was updated — this is usually a Supabase RLS permissions issue. Check that an UPDATE policy exists on user_profiles allowing professors to update section.');
    }
    showToast('✅ Student unenrolled from section.');
    const section = _studentSections.find(s=>s.id===currentSectionId);
    _allStudentsCache = await loadAllStudentProfiles();
    _currentSectionStudents = section ? _allStudentsCache.filter(s=>s.section===section.name) : [];
    renderSectionStudentsList(_currentSectionStudents);
  }catch(err){
    console.error('unenrollStudent error:', err);
    showToast('❌ Error: '+err.message);
  }
}

// ── STEP 3: A STUDENT'S WORKS (reused by Sections drill-down AND Overall Rankings) ──
async function viewStudentProfile(userId){
  const student = _allStudentsCache.find(s=>s.user_id===userId);
  if(!student){ showToast('⚠️ Student not found'); return; }

  document.getElementById('psd-name').textContent = student.full_name || 'Student';
  document.getElementById('psd-meta').innerHTML = [
    esc(student.student_id||'No student ID'),
    esc([student.section, student.year_level].filter(Boolean).join(' &nbsp;·&nbsp; ') || 'Section · Year Level')
  ].join('<br>');
  document.getElementById('psd-avatar').innerHTML = `<div class="avatar-initial" style="background:${avatarColor(student.full_name)}">${esc(studentInitial(student.full_name))}</div>`;

  const worksEl = document.getElementById('psd-works');
  worksEl.innerHTML = `<div style="font-size:13px;color:var(--text3);grid-column:1/-1;">Loading works…</div>`;

  // Make sure we have this professor's full item list, then filter to this student
  if(!_profItems || !_profItems.length) _profItems = await loadAllItemsForProfessor();
  const works = _profItems.filter(p=>p.userId===userId);

  worksEl.innerHTML = works.length ? works.map(p=>{
    const thumb = fileIsImage(p.file) ? `<img class="project-thumb" src="${esc(p.file.dataUrl)}" alt="${esc(p.title)}"/>` : `<div class="upload-thumb-placeholder" style="height:180px">${fileIsVideo(p.file)?'🎬':'🖼️'}</div>`;
    const badge = p.status==='approved'?'badge-approved':p.status==='rejected'?'badge-rejected':'badge-pending';
    return `<div class="project-card" style="position:relative;cursor:pointer;" onclick="openReviewById('${p.id}')">
      <span class="upload-status-badge ${badge}" style="position:absolute;top:8px;right:8px;z-index:1;">${p.status}</span>
      ${thumb}
      <div class="project-info">
        <div class="project-title">${esc(p.title)}</div>
        <div class="project-cat">${esc(p.category)} · ${esc(p.gradingPeriod)}</div>
        <div class="project-desc">${esc(p.desc||'')}</div>
      </div></div>`;
  }).join('') : `<div class="empty-state" style="grid-column:1/-1;"><p>This student hasn't submitted any works yet.</p></div>`;

  document.querySelectorAll('#s-professor .main-content > div').forEach(d=>d.style.display='none');
  document.getElementById('p-student-detail').style.display='block';
  document.querySelectorAll('#s-professor .snav-item').forEach(a=>{
    a.classList.toggle('active', a.getAttribute('onclick')&&a.getAttribute('onclick').includes("'p-students'"));
  });
}

// Back button on the student-works detail screen — returns to whichever list
// got us here: the section's student list (if we drilled in from a section)
// or the plain Sections list otherwise (e.g. arriving from Overall Rankings).
function backFromStudentDetail(){
  document.querySelectorAll('#s-professor .main-content > div').forEach(d=>d.style.display='none');
  document.querySelectorAll('#s-professor .snav-item').forEach(a=>{
    a.classList.toggle('active', a.getAttribute('onclick')&&a.getAttribute('onclick').includes("'p-students'"));
  });
  if(currentSectionId){
    document.getElementById('p-students').style.display = 'block';
    document.getElementById('p-students-in-section').style.display = 'block';
    document.getElementById('p-students-sections').style.display = 'none';
  } else {
    pPage('p-students');
  }
}

let profFilterStatus = 'all'; // currently active filter tab on Student Submissions page

// ══════════════════════════════════════════════════════
//  OVERALL RANKINGS — aggregated from real portfolio ratings
// ══════════════════════════════════════════════════════
let _rankingsCache = [];

// Pull every rated portfolio (professor gave 1-5 stars on approve/reject) and
// average the ratings per student to build a real leaderboard.
async function loadOverallRankings(){
  // NOTE: this used to rank by the star "rating" set in the Review Decision panel.
  // But that star click is a separate, easy-to-skip step from the actual grading
  // rubric (Creativity/Technique/Composition → final_grade), and in practice
  // professors mostly use the grading rubric and skip the stars. So rankings are
  // now based on final_grade, which is what actually reflects "this student's
  // work has been graded."
  // NOTE: portfolios.student_id and user_profiles.user_id both point at auth.users,
  // but there is no direct FK between portfolios and user_profiles, so PostgREST
  // can't auto-embed them (same issue noted in loadAllItemsForProfessor). The old
  // query here used a `user_profiles!portfolios_student_id_fkey(...)` embed that
  // doesn't exist, which made this query error out and silently return no rows —
  // that's why rankings looked like grades were "not being stored" even though
  // saveGrade() was writing final_grade correctly all along. Fetch separately instead.
  const { data, error } = await sb
    .from('portfolios')
    .select('student_id, final_grade')
    .not('final_grade', 'is', null);
  if(error){ console.error('loadOverallRankings error:', error); return []; }

  const studentIds = [...new Set((data||[]).map(r=>r.student_id).filter(Boolean))];
  let profileMap = {};
  if(studentIds.length){
    const { data: profiles, error: profErr } = await sb
      .from('user_profiles')
      .select('user_id, full_name, student_id, section, year_level')
      .in('user_id', studentIds);
    if(profErr) console.error('rankings profile fetch error:', profErr);
    (profiles||[]).forEach(pr=>{ profileMap[pr.user_id] = pr; });
  }

  const byStudent = {};
  (data||[]).forEach(row=>{
    const sid = row.student_id;
    if(!byStudent[sid]){
      byStudent[sid] = { userId: sid, profile: profileMap[sid] || {}, sum: 0, count: 0 };
    }
    byStudent[sid].sum   += row.final_grade;
    byStudent[sid].count += 1;
  });

  const list = Object.values(byStudent).map(s=>({
    userId:     s.userId,
    name:       s.profile.full_name || 'Student',
    studentId:  s.profile.student_id || '',
    sectionYear: [s.profile.section, s.profile.year_level].filter(Boolean).join(' · ') || 'Year & Section',
    avgGrade:   s.sum / s.count,
    graded:     s.count
  }));

  list.sort((a,b)=> b.avgGrade - a.avgGrade || b.graded - a.graded);
  return list;
}

async function loadAndRenderRankings(){
  const podiumEl = document.getElementById('rankings-podium');
  const listEl   = document.getElementById('rankings-list');
  if(!podiumEl || !listEl) return;
  podiumEl.innerHTML = `<div style="font-size:13px;color:var(--text3);">Loading rankings…</div>`;
  listEl.innerHTML = '';

  _rankingsCache = await loadOverallRankings();

  if(!_rankingsCache.length){
    podiumEl.innerHTML = '';
    listEl.innerHTML = `<div class="empty-state"><p>No graded works yet. Rankings appear once professors save a grade (Creativity/Technique/Composition) for at least one submission.</p></div>`;
    return;
  }

  const top3  = _rankingsCache.slice(0, 3);
  const rest  = _rankingsCache.slice(3);

  // Podium order: 2nd, 1st, 3rd (visually centered on 1st place)
  const podiumOrder = [top3[1], top3[0], top3[2]];
  podiumEl.innerHTML = podiumOrder.map((s, idx)=>{
    if(!s) return '';
    const place  = idx===0 ? 2 : idx===1 ? 1 : 3;
    const isFirst = place === 1;
    const ribbonCls  = place===1 ? 'rb-gold' : place===2 ? 'rb-silver' : 'rb-bronze';
    const ribbonMedal = place===1 ? '🥇' : place===2 ? '🥈' : '🥉';
    const ribbonHtml = `<div class="podium-ribbon-wrap"><div class="podium-ribbon ${ribbonCls}"><span class="rb-medal">${ribbonMedal}</span><span class="rb-place">${place===1?'1st':place===2?'2nd':'3rd'}</span></div></div>`;
    return `<div class="podium-card ${isFirst?'first':''}" style="width:${isFirst?200:180}px;${isFirst?'border:2px solid var(--dark);':''}">
      ${ribbonHtml}
      <div class="podium-avatar"><div class="avatar-initial" style="background:${avatarColor(s.name)};width:100%;height:100%;">${esc(studentInitial(s.name))}</div></div>
      <div class="podium-name">${esc(s.name)}</div>
      <div class="podium-meta">${esc(s.studentId||'No ID')} · ${esc(s.sectionYear)}</div>
      <div class="podium-stars"><span class="podium-score">${s.avgGrade.toFixed(1)}/100</span></div>
      <div class="podium-reviews">${s.graded} Graded Work${s.graded===1?'':'s'}</div>
      <button class="btn-view-podium" onclick="viewRankedStudent('${s.userId}')">👁 View</button>
    </div>`;
  }).join('');

  listEl.innerHTML = rest.length ? rest.map((s, i)=>`
    <div class="rank-item">
      <div class="rank-num">${i+4}</div>
      <div class="rank-ava"><div class="avatar-initial" style="background:${avatarColor(s.name)};width:100%;height:100%;">${esc(studentInitial(s.name))}</div></div>
      <div class="rank-info"><div class="rank-name">${esc(s.name)}</div><div class="rank-meta">${esc(s.studentId||'No ID')} · ${esc(s.sectionYear)}</div></div>
      <div style="text-align:right"><div class="rank-score">${s.avgGrade.toFixed(1)}/100</div><div class="rank-reviews">${s.graded} Graded Work${s.graded===1?'':'s'}</div></div>
      <button class="btn-view-sm" style="margin-left:12px" onclick="viewRankedStudent('${s.userId}')">👁 View</button>
    </div>`).join('') : '';
}

// The rankings list only knows the student_id (userId), not the row shape used by
// the Students page cache — so make sure that cache is loaded, then reuse viewStudentProfile.
async function viewRankedStudent(userId){
  currentSectionId = null; // arriving from Rankings, not from a section drill-down
  if(!_allStudentsCache || !_allStudentsCache.length) await loadAndRenderStudents();
  viewStudentProfile(userId);
}


// Show/hide the grading panel + approve/reject buttons in the review panel,
// and update the sidebar role label, based on the logged-in professor's department.
// Call this after login/session-restore/signup and again whenever the review
// panel is opened, since it's cheap and keeps things correct if the profile
// object was refreshed in between.
function applyProfessorPermissions(){
  const full        = isFullProfessor();
  const gradePanel  = document.getElementById('grade-panel');
  const decideBtns  = document.getElementById('approve-reject-actions');
  const feedbackBtn = document.getElementById('btn-submit-feedback');
  const note        = document.getElementById('rev-permission-note');
  const roleEl      = document.getElementById('p-sidebar-role');
  if(gradePanel)  gradePanel.style.display  = full ? '' : 'none';
  if(decideBtns)  decideBtns.style.display  = full ? '' : 'none';
  if(feedbackBtn) feedbackBtn.style.display = full ? 'none' : 'block';
  if(note)        note.style.display        = full ? 'none' : 'flex';
  if(roleEl && currentProfile && (currentProfile.role==='professor'||currentProfile.role==='admin')){
    roleEl.textContent = full ? 'Professor' : 'Professor · Reviewer Only';
  }
}

async function refreshProfViews(){
  _profItems = await loadAllItemsForProfessor();
  const all      = _profItems;
  const pending  = all.filter(p=>p.status==='submitted');
  const approved = all.filter(p=>p.status==='approved');

  const psubBadge = document.getElementById('psub-badge');
  if(psubBadge){
    if(pending.length > 0){ psubBadge.textContent = pending.length>9 ? '9+' : pending.length; psubBadge.classList.add('show'); }
    else { psubBadge.classList.remove('show'); }
  }
  const rejected = all.filter(p=>p.status==='rejected');

  const totalEl = document.getElementById('p-dash-total');
  if(totalEl){
    totalEl.textContent = all.length;
    document.getElementById('p-dash-approved').textContent = approved.length;
    document.getElementById('p-dash-pending').textContent  = pending.length;
    document.getElementById('p-dash-rate').textContent     = (all.length?Math.round(approved.length/all.length*100):0)+'% approval rate';
    document.getElementById('p-dash-sub').textContent      = `You have ${pending.length} submission${pending.length===1?'':'s'} waiting for review`;
    document.getElementById('p-dash-recent').innerHTML     = all.slice(0,4).map(submissionItemHtml).join('') || `<div class="empty-state"><p>No submissions yet.</p></div>`;
  }

  // Update filter tab counts
  const setCount = (id,n)=>{ const el=document.getElementById(id); if(el) el.textContent = '('+n+')'; };
  setCount('pf-count-all', all.length);
  setCount('pf-count-submitted', pending.length);
  setCount('pf-count-approved', approved.length);
  setCount('pf-count-rejected', rejected.length);

  renderSubmissionsList();

  // Quietly get the AI comparison ready in the background (no waiting, no counters) so
  // opening a review is instant. Does nothing if js/similarity-ai.js isn't loaded.
  if(typeof embWarmUp === 'function') embWarmUp();
}

function renderSubmissionsList(){
  const subList = document.getElementById('psub-list');
  if(!subList) return;
  const all = _profItems;
  const filtered = profFilterStatus==='all' ? all : all.filter(p=>p.status===profFilterStatus);
  subList.innerHTML = filtered.length ? filtered.map(submissionItemHtml).join('') : `<div class="empty-state"><p>No submissions in this category yet.</p></div>`;
}

function profFilterTab(el, status){
  profFilterStatus = status;
  document.querySelectorAll('#p-submissions .filter-tab').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  renderSubmissionsList();
}

function submissionItemHtml(p){
  const thumb = fileIsImage(p.file) ? `<img class="sub-thumb" src="${esc(p.file.dataUrl)}" alt="${esc(p.title)}"/>` : `<div class="sub-thumb-placeholder">${fileIsVideo(p.file)?'🎬':'🖼️'}</div>`;
  const badge = p.status==='approved'?'badge-approved':p.status==='rejected'?'badge-rejected':'badge-pending';
  // Rejected items can pile up as clutter — give the professor a quick way to clear
  // them out. Icon-only so it sits next to Review without pushing the row wider.
  const deleteBtn = p.status==='rejected'
    ? `<button class="btn-cancel" style="padding:9px 12px;color:var(--red);border-color:rgba(244,67,54,.4);flex-shrink:0;" title="Delete this rejected submission" onclick="event.stopPropagation();deleteSubmissionAsProfessor('${p.id}')">🗑️</button>`
    : '';
  return `<div class="submission-item">${thumb}
    <div class="sub-info">
      <div class="sub-title">${esc(p.title)} <span class="upload-status-badge ${badge}" style="position:static;font-size:11px;padding:2px 8px;border-radius:12px;vertical-align:middle">${p.status}</span></div>
      <div class="sub-meta">by ${esc(p.studentName)} · ${esc(p.section)} · ${esc(p.gradingPeriod)} · ${fmtDate(p.submittedAt)}</div>
    </div>
    <button class="btn-review" onclick="openReviewById('${p.id}')">👁 Review</button>
    ${deleteBtn}
  </div>`;
}

// ── DELETE SUBMISSION (professor: permanently remove a rejected item so it stops cluttering the list) ──
async function deleteSubmissionAsProfessor(itemId){
  const p = _profItems.find(x=>x.id===itemId);
  if(!confirm(`Permanently delete "${p ? p.title : 'this submission'}"? This removes it from the student's records too and cannot be undone.`)) return;
  showToast('🗑️ Deleting…');
  try{
    // Cascade: remove any similarity_logs rows referencing this item first,
    // in either direction, otherwise the foreign key will block deletion.
    await sb.from('similarity_logs').delete().eq('checked_item_id', itemId);
    await sb.from('similarity_logs').delete().eq('matched_item_id', itemId);

    const { data: deletedRows, error } = await sb.from('portfolio_items').delete().eq('id', itemId).select();
    if(error) throw error;
    if(!deletedRows || deletedRows.length === 0){
      throw new Error('Nothing was deleted — this is usually a Supabase permissions (RLS) issue. Check that a DELETE policy exists on portfolio_items for professors.');
    }

    // Clean up the actual file on Cloudinary via the same Edge Function students use.
    const publicId = p && p.cloudinaryPublicId;
    if(publicId){
      try{
        const { error: fnErr } = await sb.functions.invoke('delete-cloudinary-asset', { body: { publicId } });
        if(fnErr) console.error('Cloudinary cleanup error:', fnErr);
      }catch(fnErr){
        console.error('Cloudinary cleanup error:', fnErr);
      }
    }

    _profItems = _profItems.filter(x=>x.id!==itemId);
    showToast('✅ Submission deleted.');
    renderSubmissionsList();
    refreshProfViews();
  }catch(err){
    console.error('deleteSubmissionAsProfessor error:', err);
    showToast('❌ Delete failed: '+err.message);
  }
}

async function openReviewById(itemId){
  const p = _profItems.find(x=>x.id===itemId);
  if(!p){ showToast('⚠️ Submission not found'); return; }
  currentReview = { itemId: p.id, portfolioId: p.portfolioId };

  document.getElementById('rev-title').textContent = p.title;
  document.getElementById('rev-by').textContent    = p.studentName + ' · ' + p.section;
  document.getElementById('rev-date').textContent  = fmtDate(p.submittedAt);
  document.getElementById('rev-desc').textContent  = (p.desc||'(no description)') + (p.gradingPeriod ? ' · '+p.gradingPeriod : '');

  const img = document.getElementById('rev-img');
  const vid = document.getElementById('rev-video');
  const ph  = document.getElementById('rev-img-placeholder');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  if(fileIsImage(p.file)){
    img.src=p.file.dataUrl; img.style.display='block'; vid.style.display='none'; ph.style.display='none';
  } else if(fileIsVideo(p.file)){
    vid.src=p.file.dataUrl; vid.style.display='block'; img.style.display='none'; ph.style.display='none';
  } else {
    img.style.display='none'; vid.style.display='none'; ph.style.display='flex'; ph.textContent='🖼️';
  }

  document.getElementById('rev-comment').value = p.comment||'';
  setStars(p.rating||0);

  // Load this submission's existing grade (if any) into the grading inputs
  document.getElementById('grade-c1').value = p.creativityScore ?? '';
  document.getElementById('grade-c2').value = p.techniqueScore ?? '';
  document.getElementById('grade-c3').value = p.compositionScore ?? '';
  document.getElementById('grade-remarks').value = p.gradeRemarks || '';
  document.getElementById('grade-final-calc').textContent = p.finalGrade ?? '0';
  document.getElementById('grade-saved-msg').style.display = 'none';

  // Open the panel straight away — the similarity result fills in a moment later,
  // so the professor never waits on it.
  showSimilarityChecking();
  applyProfessorPermissions();
  pPage('p-review');
  renderReviewSimilarity(itemId);
}

// Placeholder shown for the split second while the similarity result is worked out
function showSimilarityChecking(){
  const simNoneEl = document.getElementById('rev-similarity-none');
  document.getElementById('rev-similarity-item').style.display = 'none';
  document.getElementById('rev-warning-note').style.display    = 'none';
  simNoneEl.textContent   = 'Checking similarity…';
  simNoneEl.style.display = 'block';
  setSimMethodNote('', false);
  currentSimilarMatch = null;
}

// Works out and shows the closest match for the submission open in the Review Panel.
// Uses the AI comparison (js/similarity-ai.js) when available; if older works are still
// being analysed in the background, shows what it has now and refreshes itself when done.
async function renderReviewSimilarity(itemId, isRetry){
  let logs = [];
  const live = await computeAndCacheSimilarity(itemId);
  if(live) logs = [live];
  if(!currentReview || currentReview.itemId !== itemId) return; // professor already moved on to something else

  const simNoneEl  = document.getElementById('rev-similarity-none');
  const simItemEl  = document.getElementById('rev-similarity-item');
  const warnEl     = document.getElementById('rev-warning-note');
  const warnTextEl = document.getElementById('rev-warning-text');

  if(logs.length > 0){
    const top     = logs[0];
    const pct     = Math.round((top.similarity_score||0)*100);
    const matched = top.portfolio_items || {};
    const ownerName = await getPortfolioOwnerName(matched.portfolio_id);
    if(!currentReview || currentReview.itemId !== itemId) return;
    document.getElementById('sim-thumb-img').src   = matched.file_url || '';
    document.getElementById('sim-name').textContent = matched.title || 'Similar Item';
    document.getElementById('sim-by').textContent   = 'Submitted by '+ownerName;
    document.getElementById('sim-badge').textContent = pct+'% Match';
    // Say plainly which method produced this number (a silent fallback to the basic hash hid problems before).
    // NOTE: similarityBetween() returns 'ai+hash' for the normal AI path
    // (AI blended with dHash) and 'ai' only when a phash is missing — both
    // mean the AI comparison ran, so both must show the AI note.
    if(top.method === 'ai' || top.method === 'ai+hash'){
      setSimMethodNote('🧠 AI image comparison (raw score '+(top.cos != null ? top.cos.toFixed(3) : '—')+')', false);
    } else {
      const why = (typeof embStatus === 'function') ? embStatus() : 'AI comparison OFF — js/similarity-ai.js was not loaded (check that the file is in your js/ folder and index.html includes it).';
      setSimMethodNote('⚠️ Basic image-hash comparison used. '+why+(why.indexOf('AI comparison ON') !== 0 ? '' : ' One of these images has not been analysed yet.'), true);
    }
    // Color-code the badge so a glance tells you the risk level:
    // low (<85%) = neutral, medium (85-92%) = caution, high (93%+) = flagged/red
    const simBadgeEl = document.getElementById('sim-badge');
    simBadgeEl.classList.remove('sim-badge-low','sim-badge-mid','sim-badge-high');
    simBadgeEl.classList.add(top.flagged ? 'sim-badge-high' : (pct >= SIMILARITY_LOG_THRESHOLD*100 ? 'sim-badge-mid' : 'sim-badge-low'));
    simItemEl.style.display = 'flex';
    simNoneEl.style.display = 'none';
    // Cache for the Inspect modal — this is the earlier submission it was checked against
    currentSimilarMatch = { title: matched.title || 'Similar Item', fileUrl: matched.file_url || '', owner: ownerName, pct };
    if(top.flagged){
      warnTextEl.innerHTML = `<strong>Possible Similarity Detected.</strong> This submission shows high similarity (${pct}%) with existing content submitted by ${esc(ownerName)}. Please review carefully before approval.`;
      warnEl.style.display = 'flex';
    } else {
      warnEl.style.display = 'none';
    }
  } else {
    // Only happens if there was nothing else in the system to compare against yet
    simItemEl.style.display = 'none';
    simNoneEl.textContent   = 'No similar submissions detected.';
    simNoneEl.style.display = 'block';
    warnEl.style.display    = 'none';
    currentSimilarMatch = null;
  }

  // Older works still being analysed in the background? Refresh this result automatically when that finishes.
  if(!isRetry && typeof embWarmPending === 'function' && embWarmPending()){
    const el = document.getElementById('rev-sim-method');
    if(el){ el.textContent = '⏳ Still preparing older works in the background — this result will update by itself.'; el.style.color = 'var(--text3)'; }
    embWarmUp().then(()=>{ if(currentReview && currentReview.itemId === itemId) renderReviewSimilarity(itemId, true); });
  }
}

// Small status line under the "Image Similarity Detection" subtitle
function setSimMethodNote(text, isWarning){
  let el = document.getElementById('rev-sim-method');
  if(!el){
    const sub = document.querySelector('#p-review .similarity-sub');
    if(!sub) return;
    el = document.createElement('div');
    el.id = 'rev-sim-method';
    el.style.cssText = 'font-size:11px;margin:-8px 0 12px;';
    sub.insertAdjacentElement('afterend', el);
  }
  el.textContent = text;
  el.style.color = isWarning ? 'var(--orange)' : 'var(--text3)';
}

function openReview(sk, id){ openReviewById(id); } // legacy compat

// ── INSPECT SIMILAR WORK (professor: preview the earlier submission a flagged item matched) ──
let currentSimilarMatch = null;
function inspectSimilarWork(){
  if(!currentSimilarMatch){ showToast('⚠️ No similar submission to inspect'); return; }
  document.getElementById('inspect-sim-img').src = currentSimilarMatch.fileUrl;
  document.getElementById('inspect-sim-title').textContent = currentSimilarMatch.title;
  document.getElementById('inspect-sim-owner').textContent = 'Submitted by '+currentSimilarMatch.owner;
  document.getElementById('inspect-sim-badge').textContent = currentSimilarMatch.pct+'% Match';
  document.getElementById('inspectSimilarOverlay').classList.add('open');
}
function closeInspectSimilar(){
  document.getElementById('inspectSimilarOverlay').classList.remove('open');
}

async function decideReview(decision){
  if(!currentReview){ showToast('⚠️ No submission selected'); return; }
  if(!isFullProfessor()){ showToast('⚠️ Only Multimedia Arts professors can approve or reject submissions.'); return; }
  const { portfolioId } = currentReview;
  const stars   = document.querySelectorAll('.star-btn.active').length;
  const comment = document.getElementById('rev-comment').value.trim();
  try{
    await updatePortfolioStatus(portfolioId, decision, comment, currentUser.id, stars);
    const p = _profItems.find(x=>x.portfolioId===portfolioId);
    if(p){ p.status=decision; p.comment=comment; p.rating=stars; }

    // ── Magpadala ng email notification sa estudyante ──
    if(p){
      sendReviewNotification({
        studentEmail: p.studentEmail,
        studentName:  p.studentName,
        artworkTitle: p.title,
        decision:     decision,
        comment:      comment,
        finalGrade:   p.finalGrade
      });
    }

    showToast(decision==='approved' ? '✅ Portfolio approved!' : '❌ Portfolio rejected.');
    currentReview = null;
    pPage('p-submissions');
  }catch(err){
    console.error(err);
    showToast('❌ Error: '+err.message);
  }
}

// Reviewer-only professors (non-Multimedia Arts): save a star rating + comment
// without touching the submission's approve/reject status or grade.
async function saveFeedbackOnly(){
  if(!currentReview){ showToast('⚠️ No submission selected'); return; }
  const { portfolioId } = currentReview;
  const stars   = document.querySelectorAll('.star-btn.active').length;
  const comment = document.getElementById('rev-comment').value.trim();
  if(!stars && !comment){ showToast('⚠️ Add a rating or a comment first.'); return; }
  try{
    if(stars){
      const { error } = await sb.from('portfolios').update({ rating: stars, updated_at: new Date().toISOString() }).eq('id', portfolioId);
      if(error) throw error;
    }
    if(comment){
      const { error } = await sb.from('feedback').insert([{
        portfolio_id: portfolioId,
        professor_id: currentUser.id,
        comment: comment
      }]);
      if(error) throw error;
    }
    const p = _profItems.find(x=>x.portfolioId===portfolioId);
    if(p){ if(stars) p.rating=stars; if(comment) p.comment=comment; }
    showToast('✅ Rating & comment submitted.');
  }catch(err){
    console.error('saveFeedbackOnly error:', err);
    showToast('❌ Error: '+err.message);
  }
}

// ── GRADING ──
function calcFinalGrade(){
  const c1 = parseFloat(document.getElementById('grade-c1').value)||0;
  const c2 = parseFloat(document.getElementById('grade-c2').value)||0;
  const c3 = parseFloat(document.getElementById('grade-c3').value)||0;
  document.getElementById('grade-final-calc').textContent = (c1+c2+c3).toFixed(1);
}

async function saveGrade(){
  if(!currentReview){ showToast('⚠️ No submission selected'); return; }
  if(!isFullProfessor()){ showToast('⚠️ Only Multimedia Arts professors can grade submissions.'); return; }
  const c1 = parseFloat(document.getElementById('grade-c1').value)||0;
  const c2 = parseFloat(document.getElementById('grade-c2').value)||0;
  const c3 = parseFloat(document.getElementById('grade-c3').value)||0;
  if(c1===0 && c2===0 && c3===0){ showToast('⚠️ Please enter at least one score.'); return; }
  const finalGrade = +(c1+c2+c3).toFixed(1);
  const remarks = document.getElementById('grade-remarks').value.trim() || 'Graded';
  // Snapshot the student's section onto the portfolio at the moment of
  // grading — this is what Grade Archives filters by later, so a grade
  // stays correctly filed under the section the student was actually in
  // when it was graded, even if they change sections afterward.
  const gradedItem = _profItems.find(x=>x.portfolioId===currentReview.portfolioId);
  const studentSection = (gradedItem && gradedItem.section) || null;
  // Freeze lock — a frozen section + grading period can't be re-graded until
  // a professor unfreezes it in Grade Archives. Fails open: if the freeze
  // table was never set up, grading works exactly as before.
  if(typeof isPeriodFrozen === 'function' && gradedItem && studentSection && gradedItem.gradingPeriod){
    try{
      if(await isPeriodFrozen(studentSection, gradedItem.gradingPeriod)){
        showToast('🔒 This section + period is frozen — unfreeze it in Grade Archives to change grades.');
        return;
      }
    }catch(e){ console.warn('[grade] freeze check skipped:', e); }
  }
  try{
    const { error } = await sb.from('portfolios').update({
      creativity_score:  c1,
      technique_score:   c2,
      composition_score: c3,
      final_grade:       finalGrade,
      grade_remarks:      remarks,
      section:            studentSection,
      graded_at:          new Date().toISOString(),
      graded_by:          currentUser.id,
      updated_at:         new Date().toISOString()
    }).eq('id', currentReview.portfolioId);
    if(error) throw error;
    const p = _profItems.find(x=>x.portfolioId===currentReview.portfolioId);
    if(p){ p.finalGrade=finalGrade; p.creativityScore=c1; p.techniqueScore=c2; p.compositionScore=c3; p.gradeRemarks=remarks; }
    document.getElementById('grade-final-calc').textContent = finalGrade;
    document.getElementById('grade-saved-msg').style.display = 'block';
    setTimeout(()=>{ document.getElementById('grade-saved-msg').style.display='none'; }, 3500);
    showToast('✅ Grade saved: '+finalGrade+'/100');
  }catch(err){
    console.error(err);
    showToast('❌ Error saving grade: '+err.message);
  }
}

// ── STARS ──
function setStars(n){ document.querySelectorAll('.star-btn').forEach((b,i)=>b.classList.toggle('active',i<n)); }

// ── OTP INPUT ──
function otpNext(el){
  if(el.value&&el.nextElementSibling&&el.nextElementSibling.classList.contains('otp-box')) el.nextElementSibling.focus();
}

// ── LANDING TIMER ──
let timerS=60,timerP=60,timerR=60;
setInterval(()=>{
  if(timerS>0){timerS--;const el=document.getElementById('timer-s');if(el)el.textContent=timerS;}
  if(timerP>0){timerP--;const el=document.getElementById('timer-p');if(el)el.textContent=timerP;}
  if(timerR>0){timerR--;const el=document.getElementById('timer-r');if(el)el.textContent=timerR;}
},1000);

function resetOtpTimer(kind){
  if(kind==='student'){ timerS=60; const el=document.getElementById('timer-s'); if(el) el.textContent=timerS; }
  else if(kind==='prof'){ timerP=60; const el=document.getElementById('timer-p'); if(el) el.textContent=timerP; }
  else if(kind==='reset'){ timerR=60; const el=document.getElementById('timer-r'); if(el) el.textContent=timerR; }
}

// ── ON LOAD: resume session if one already exists (e.g. page refresh) ──
async function restoreSession(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session) return;
  const user    = session.user;
  const profile = await getProfile(user.id);
  if(!profile) return;
  currentUser    = user;
  currentProfile = profile;
  if(profile.role === 'student'){
    const firstName = (profile.full_name||'').split(' ')[0]||'Student';
    document.getElementById('s-sidebar-name').textContent = profile.full_name||'';
    document.getElementById('s-welcome-name').textContent = 'Welcome Back, '+firstName+'!';
    renderPortfolioHeader();
    go('s-student'); sPage('dashboard');
    await loadProjectsForStudent(user.id);
    refreshStudentViews();
    populateSubjectDropdown();
  } else if(profile.role === 'professor' || profile.role === 'admin'){
    document.getElementById('p-sidebar-name').textContent = profile.full_name||'';
    setAvatar('p-sidebar-avatar', profile.full_name);
    go('s-professor'); pPage('p-dashboard'); refreshProfViews();
    applyProfessorPermissions();
  }
}


// ── APP BOOTSTRAP ──
// Runs only after loader.js has injected every Page/Dashboard
// fragment into the DOM, so getElementById calls above never race the fetch.
// Email "View in Artfolio" links carry ?to=landing so they always open the
// public landing page — never auto-enter a saved account session. Returns
// true if it took over the screen (initApp then skips the session restore).
function handleLandingLink(){
  let params;
  try{ params = new URLSearchParams(location.search); }catch(e){ return false; }
  if(params.get('to') !== 'landing') return false;
  history.replaceState(null, '', location.pathname); // clean the URL so a refresh restores the session normally
  go('s-landing');
  return true;
}

async function initApp(){
  console.log('[artfolio] originality gate ' + ORIGINALITY_GATE_VERSION + ' active — 90%+ similar images are blocked BEFORE upload (no Cloudinary file, no database row).');
  if(typeof checkForQrLink === 'function' && checkForQrLink()) return; // ?work=<id> in the URL — show that work's public page and stop here
  if(handleLandingLink()) return; // ?to=landing from notification emails — landing page only, no auto-login
  const openedFromAlert = handleAlertLink(); // ?action=changepw|keep from the login-alert email
  if(!openedFromAlert) await restoreSession();
  populateSubjectDropdown();
  populateSectionDropdown();
  loadShowcaseMosaic();  // hero "Recently shared works" mosaic on the landing page
  loadLandingExplore();  // "Explore creative works" grid on the landing page
}
document.addEventListener('artfolio:ready', initApp);