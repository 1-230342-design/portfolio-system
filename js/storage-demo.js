/* ══════════════════════════════════════════════════════════════
   STORAGE DEMO — Super Admin → Storage

   A demonstration control, deliberately scoped so it cannot break the
   live app:

   • The switch is PER-BROWSER (localStorage), never a global setting.
     Flipping it changes where THIS admin's test upload goes. Students
     and professors keep uploading to Cloudinary exactly as before.
   • Only the test uploader inside the card uses the selected backend.
     Nothing on the student submit path, the professor review path or
     the avatar uploader reads this value.
   • The card only renders for is_super_admin accounts. The page itself
     is already guarded in pPage(); this is a second belt.

   Why a card and not a bare button: a toggle alone proves nothing to
   an audience — the file just uploads somewhere. The card shows the
   returned URL, the host serving it, and the media rendering, which is
   the actual evidence that B2 accepts the same images and videos.

   B2 upload flow (secrets never reach the browser):
     browser → sb.functions.invoke('b2-upload-url')
             → Edge Function holds B2_KEY_ID / B2_APPLICATION_KEY,
               calls b2_authorize_account + b2_get_upload_url
             → returns a one-shot uploadUrl + token
     browser → POSTs the raw file straight to Backblaze, with live
               progress. Large videos never pass through the function.

   Requirements on the B2 side (one-time, in the Backblaze dashboard):
     • bucket CORS rule allowing this site's origin
     • bucket made Public, so <img>/<video> previews can render
   Without the public bucket the URL is returned but the preview 401s.
   ══════════════════════════════════════════════════════════════ */

const SD_STORE_KEY = 'artfolio.storageBackend'; // per browser, not per account
const SD_FUNCTION  = 'b2-upload-url';

let _sdLast = null;   // last successful upload, kept across re-renders
let _sdBusy = false;

// ── the selected backend (this browser only) ──
function storageBackend(){
  try{ return localStorage.getItem(SD_STORE_KEY) === 'b2' ? 'b2' : 'cloudinary'; }
  catch(_){ return 'cloudinary'; }
}

function setStorageBackend(name){
  const next = (name === 'b2') ? 'b2' : 'cloudinary';
  try{ localStorage.setItem(SD_STORE_KEY, next); }catch(_){}
  _sdLast = null;
  renderStorageCard();
}

// ── the card ──
function renderStorageCard(){
  const card = document.getElementById('storage-card');
  if(!card) return;

  const allowed = (typeof isSuperAdmin === 'function') && isSuperAdmin();
  card.style.display = allowed ? '' : 'none';
  if(!allowed) return;

  const backend = storageBackend();
  const cTab = document.getElementById('storage-tab-cloudinary');
  const bTab = document.getElementById('storage-tab-b2');
  if(cTab) cTab.classList.toggle('active', backend === 'cloudinary');
  if(bTab) bTab.classList.toggle('active', backend === 'b2');

  const body = document.getElementById('storage-demo-body');
  if(!body) return;
  const isB2 = backend === 'b2';

  body.innerHTML = `
    <div class="sd-row">
      <div class="sd-target">
        <span class="sd-pill ${isB2 ? 'sd-pill-b2' : 'sd-pill-cld'}">${isB2 ? 'Backblaze B2' : 'Cloudinary'}</span>
        <span class="sd-note">${isB2
          ? 'Test uploads go to the B2 demo bucket. The API key stays in the Edge Function — never in this page.'
          : 'The backend every real submission uses today.'}</span>
      </div>
      <div class="sd-actions">
        <input type="file" id="sd-file" accept="image/*,video/*" style="display:none" onchange="handleStorageDemoFile(event)"/>
        <button class="sd-btn" id="sd-pick" onclick="document.getElementById('sd-file').click()"${_sdBusy ? ' disabled' : ''}>▲ Choose image or video</button>
      </div>
    </div>
    <div class="sd-progress" id="sd-progress" style="display:none;"></div>
    <div id="sd-result">${storageDemoResultHtml()}</div>`;
}

function sdProgressHtml(pct, backend){
  const p = Math.max(0, Math.min(100, pct | 0));
  return `<div class="sd-bar"><span style="width:${p}%"></span></div>
    <div class="sd-bar-label">Uploading to ${backend === 'b2' ? 'Backblaze B2' : 'Cloudinary'}… ${p}%</div>`;
}

function sdBytes(n){
  if(!n && n !== 0) return '—';
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function storageDemoResultHtml(){
  if(!_sdLast) return '';
  const r = _sdLast;
  const isVideo = (r.type || '').startsWith('video/');
  const isB2 = r.provider === 'b2';

  let host = '—';
  try{ host = new URL(r.url).host; }catch(_){}

  const preview = r.url
    ? (isVideo
        ? `<video class="sd-preview" src="${esc(r.url)}" controls playsinline preload="metadata"></video>`
        : `<img class="sd-preview" src="${esc(r.url)}" alt="Uploaded test file"/>`)
    : `<div class="sd-preview sd-preview-none">This bucket returned no public URL — its files are private.</div>`;

  return `<div class="sd-result">
    <div class="sd-result-head">
      <span class="sd-ok">✅ Accepted</span>
      <span class="sd-pill ${isB2 ? 'sd-pill-b2' : 'sd-pill-cld'}">${isB2 ? 'Backblaze B2' : 'Cloudinary'}</span>
      <span class="sd-meta">${esc(r.name || 'file')} · ${sdBytes(r.size)} · ${r.ms} ms · served from ${esc(host)}</span>
    </div>
    ${preview}
    <div class="sd-url"><code>${esc(r.url || '—')}</code></div>
    ${r.signed ? `<div class="sd-note" style="margin-top:6px;">Signed link — valid for about an hour, so the bucket stays private.</div>` : ''}
    <div class="sd-result-foot">
      <button class="sd-btn sd-btn-ghost" onclick="storageDemoReset()">Clear</button>
    </div>
  </div>`;
}

function storageDemoReset(){
  _sdLast = null;
  renderStorageCard();
}

// ── the test upload ──
async function handleStorageDemoFile(ev){
  const input = ev && ev.target;
  const file = input && input.files && input.files[0];
  if(!file) return;

  const backend = storageBackend();
  const prog = document.getElementById('sd-progress');
  const res  = document.getElementById('sd-result');
  const btn  = document.getElementById('sd-pick');

  _sdBusy = true;
  if(btn) btn.disabled = true;
  if(res) res.innerHTML = '';
  if(prog){ prog.style.display = ''; prog.innerHTML = sdProgressHtml(0, backend); }
  const paint = (pct)=>{ if(prog) prog.innerHTML = sdProgressHtml(pct, backend); };

  const started = Date.now();
  try{
    const out = backend === 'b2'
      ? await uploadToB2(file, paint)
      : await uploadToCloudinary(file, paint);

    _sdLast = {
      provider: backend,
      url:      out && out.url,
      signed:   !!(out && out.signed),
      type:     file.type,
      name:     file.name,
      size:     file.size,
      ms:       Date.now() - started
    };
    if(prog) prog.style.display = 'none';
    if(res) res.innerHTML = storageDemoResultHtml();
    showToast(backend === 'b2' ? '✅ B2 accepted the file.' : '✅ Cloudinary accepted the file.');
  }catch(err){
    console.error('[storage demo] upload failed:', err);
    if(prog) prog.style.display = 'none';
    if(res) res.innerHTML = sdErrorHtml(err, backend);
  }finally{
    _sdBusy = false;
    if(input) input.value = '';
    if(btn) btn.disabled = false;
  }
}

function sdErrorHtml(err, backend){
  if(backend === 'b2' && err && err.code === 'not-configured'){
    return `<div class="sd-setup">
      <div class="sd-setup-title">B2 isn’t wired up yet</div>
      <div class="sd-setup-sub">Three one-time steps in the Supabase dashboard, then this button uploads straight to Backblaze:</div>
      <ol class="sd-setup-list">
        <li>Deploy the <code>b2-upload-url</code> Edge Function (it lives in <code>supabase/functions/b2-upload-url/</code>).</li>
        <li>Add Edge Function secrets <code>B2_KEY_ID</code> and <code>B2_APPLICATION_KEY</code>.</li>
        <li>Allow this site in the bucket’s <strong>CORS Rules</strong>.</li>
      </ol>
    </div>`;
  }
  return `<div class="sd-error">⚠️ ${esc((err && err.message) || 'Upload failed.')}</div>`;
}

// ── B2 ──
// Asks the Edge Function for a one-shot upload target. Any failure that
// means "the function isn't there / isn't configured" is normalised to a
// not-configured error, so the card can show setup steps instead of a
// raw Supabase error.
async function b2UploadTarget(){
  let res;
  try{
    res = await sb.functions.invoke(SD_FUNCTION, { body: {} });
  }catch(err){
    throw sdNotConfigured(err);
  }

  if(res && res.error){
    const status = res.error.context && res.error.context.status;
    const msg = String(res.error.message || '');
    if(status === 404 || /not found|failed to send/i.test(msg)) throw sdNotConfigured(res.error);
    throw new Error(msg || 'B2 upload target could not be created.');
  }

  const d = res && res.data;
  if(!d || !d.uploadUrl || !d.uploadToken) throw sdNotConfigured();
  return d;
}

function sdNotConfigured(cause){
  const e = new Error('B2 is not configured yet.');
  e.code = 'not-configured';
  e.cause = cause;
  return e;
}

// Uploads the raw file straight to Backblaze with live progress. XHR is
// used deliberately: fetch cannot report upload progress.
function uploadToB2(file, onProgress){
  return b2UploadTarget().then(target => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', target.uploadUrl);
    xhr.setRequestHeader('Authorization', target.uploadToken);
    // B2 wants the name percent-encoded, with '/' left as a path separator.
    xhr.setRequestHeader('X-Bz-File-Name', encodeURIComponent(target.fileName).replace(/%2F/gi, '/'));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    // The bucket has no Object Lock, so B2 accepts this instead of the
    // real SHA-1. Computing a SHA-1 over a 200 MB video would freeze the
    // tab for no benefit here.
    xhr.setRequestHeader('X-Bz-Content-Sha1', 'do_not_verify');

    xhr.upload.onprogress = (e)=>{
      if(e.lengthComputable && typeof onProgress === 'function'){
        try{ onProgress(Math.round(e.loaded / e.total * 100)); }catch(_){}
      }
    };

    xhr.onload = ()=>{
      let data = {};
      try{ data = JSON.parse(xhr.responseText); }catch(_){}
      if(xhr.status < 200 || xhr.status >= 300){
        reject(new Error(data.message || ('B2 refused the upload (HTTP ' + xhr.status + ').')));
        return;
      }
      // Public bucket → plain URL. Private bucket (the default, and safer)
      // → a signed link that expires in about an hour, so previews render
      // without exposing the bucket.
      let url = null;
      let signed = false;
      if(target.publicBaseUrl){
        url = String(target.publicBaseUrl).replace(/\/+$/, '') + '/' + target.fileName;
      } else if(target.downloadUrl && target.downloadToken && target.bucketName){
        url = String(target.downloadUrl).replace(/\/+$/, '')
            + '/file/' + target.bucketName + '/' + target.fileName
            + '?Authorization=' + encodeURIComponent(target.downloadToken);
        signed = true;
      }
      resolve({
        url,
        signed,
        provider: 'b2',
        fileId:   data.fileId || null,
        bytes:    data.contentLength || file.size
      });
    };
    // A CORS rejection surfaces here with no status — the usual cause is a
    // missing bucket CORS rule, so say that rather than "network error".
    xhr.onerror   = ()=>reject(new Error('Upload blocked — the demo bucket needs a CORS rule allowing this site.'));
    xhr.ontimeout = ()=>reject(new Error('Upload timed out — try a smaller file.'));
    xhr.send(file);
  }));
}
