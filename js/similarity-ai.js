// ══════════════════════════════════════════════════════
//  Artfolio — AI Image Similarity
//  Compares WHAT an image shows (via a small MobileNet model running in
//  the browser) instead of only its raw brightness pattern, so the same
//  subject on a different background still scores as very similar, while
//  two unrelated pictures score low.
//
//  Each image is described from three views (whole picture, centre 70%,
//  centre 50%). Two works are compared view-against-view using ONLY
//  same-fraction pairs (whole-vs-whole, 70%-vs-70%, 50%-vs-50%), and the
//  three scores are averaged — not maxed across every cross-fraction
//  combination — so a single fluke view can't dominate the result.
//
//  IMPORTANT CAVEAT (read before tuning EMB_FLOOR/EMB_CEIL further):
//  MobileNet was trained on photographs, not flat-color/cartoon/vector art.
//  Stylized character art sits far outside its training distribution, so its
//  embeddings can collapse — two unrelated cartoon images can score a
//  deceptively "high" cosine similarity purely from generic "flat colors +
//  thick outlines" activations, regardless of actual subject. Because of
//  this, similarityBetween() below BLENDS the AI score with the pixel-level
//  dHash score rather than trusting the AI score alone — a spurious AI spike
//  gets pulled back down when the raw pixels don't actually agree.
//
//  Loaded after js/app.js. Reuses its globals (sb, fileIsImage,
//  phashSimilarity). Everything here degrades gracefully: if the model
//  can't load, or the `embedding` column doesn't exist yet, app.js simply
//  keeps using the basic image-hash comparison — nothing breaks.
//
//  TensorFlow.js + MobileNet are NOT loaded with the page. They are
//  fetched the first time they are needed (a student's upload, or a
//  professor logging in), so the landing page stays fast.
//
//  Professors never wait on this: older works are analysed silently in
//  the background right after a professor logs in (embWarmUp), and each
//  work's fingerprint is saved so it only ever has to be done once.
// ══════════════════════════════════════════════════════

const EMB_TFJS_URL      = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const EMB_MOBILENET_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js';

// ── CALIBRATION (tune these if the percentages feel off) ──
// The model's raw "cosine similarity" is not a percentage. Measured on real
// data: the same character on a different background scored ~0.61 with a
// single whole-image view. These two numbers stretch the raw range into a
// 0–100% score:  cosine <= FLOOR → 0%,  cosine >= CEIL → 99%.
// The Review Panel shows the raw score next to the percentage, and the browser
// console (F12) lists the closest matches with their raw scores (rawAI and
// imageHash separately) — check those numbers before re-tuning these.
const EMB_FLOOR         = 0.38;
const EMB_CEIL          = 0.62;
const EMB_MAX_SCORE     = 0.99;  // never show 100% from "similar content" alone
const EMB_CROPS         = [1, 0.7, 0.5]; // views per image: whole picture, centre 70%, centre 50%
const EMB_MAX_SIDE      = 448;   // views are shrunk to this many pixels before analysis (speed)
const EMB_BACKFILL_MAX  = 200;   // max older works analysed per background run

// How much weight the raw AI score gets vs. the pixel-level dHash score when
// blending (see similarityBetween below). AI catches "same subject, different
// background"; hash keeps a false AI spike honest by requiring the raw pixels
// to actually agree at least somewhat. Only used when both sides have a phash.
//
// IMPORTANT — why this is 0.85, not lower:
// Two genuinely UNRELATED images naturally score ~50% on the raw dHash purely
// by chance (each of the 64 gradient bits differs roughly at random for
// uncorrelated content) — dHash is not a 0%=different/100%=same linear scale.
// That means dh essentially NEVER goes much above ~50% unless the pixels are
// truly near-identical. At the old weight (0.6 AI / 0.4 hash), the maximum
// possible blended score was:
//     0.6 * 0.99 (near-perfect AI match) + 0.4 * 0.50 (typical unrelated-ish dh)
//   = 0.794  →  79.4%
// That is BELOW SIMILARITY_BLOCK_THRESHOLD (0.90) — so a "same artwork on a
// different background" match that the AI was 99% sure about could NEVER
// reach the block threshold, no matter how confident the AI was. The upload
// would sail through unblocked every single time this scenario occurred.
// At 0.85 AI / 0.15 hash, the same near-perfect AI match maxes out at:
//     0.85 * 0.99 + 0.15 * 0.50 = 0.9165  →  91.65%
// which CAN cross the 90% block threshold when the AI is genuinely confident,
// while a low/near-zero dh score still meaningfully drags a merely-mediocre
// AI score back down (protects against the MobileNet flat-color/cartoon-art
// false-spike problem described in the file header above).
const EMB_BLEND_AI_WEIGHT = 0.85;

// ── loading scripts on demand ──
const _embScriptPromises = {};
function embLoadScript(src){
  if(_embScriptPromises[src]) return _embScriptPromises[src];
  _embScriptPromises[src] = new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('Could not load '+src));
    document.head.appendChild(s);
  });
  return _embScriptPromises[src];
}

// ── the model (loaded once per page, or null if it can't be loaded) ──
let _embModelPromise = null;
let _embModelError = null; // why the model failed to load (shown to the professor)
let _embTag = null;        // which model produced the embeddings ('mnv2' or 'mnv1'); never mix tags

function ensureEmbeddingModel(){
  if(_embModelPromise) return _embModelPromise;
  _embModelPromise = (async()=>{
    try{
      await embLoadScript(EMB_TFJS_URL);
      await embLoadScript(EMB_MOBILENET_URL);
      if(typeof tf === 'undefined' || typeof mobilenet === 'undefined') throw new Error('TensorFlow.js / MobileNet did not initialise');
      await tf.ready();

      const attempts = [
        { tag:'mnv2', cfg:{ version:2, alpha:1.0 } },
        { tag:'mnv1', cfg:{ version:1, alpha:1.0 } }
      ];
      for(const a of attempts){
        try{
          const m = await mobilenet.load(a.cfg);
          // Sanity check: run one blank image through and make sure a real vector comes out.
          const probe = tf.zeros([224,224,3]);
          const t = m.infer(probe, true);
          const d = await t.data();
          t.dispose(); probe.dispose();
          if(!d || d.length < 100) throw new Error('unexpected embedding size');
          _embTag = a.tag;
          console.log('[AI similarity] model ready:', a.tag, '('+d.length+' dimensions)');
          return m;
        }catch(e){
          console.warn('[AI similarity] '+a.tag+' failed to load:', e);
        }
      }
      throw new Error('no MobileNet variant could be loaded');
    }catch(err){
      console.warn('[AI similarity] unavailable — falling back to the basic image hash:', err);
      _embModelError = (err && err.message) ? err.message : String(err);
      return null;
    }
  })();
  return _embModelPromise;
}

// ── is the database ready? (portfolio_items.embedding column exists) ──
let _embColumnOk = null;
async function embeddingColumnAvailable(){
  if(_embColumnOk !== null) return _embColumnOk;
  try{
    const { error } = await sb.from('portfolio_items').select('embedding').limit(1);
    _embColumnOk = !error;
    if(error) console.info('[AI similarity] portfolio_items.embedding column not found — run the SQL setup. Using the basic image hash for now.', error.message);
  }catch(e){
    _embColumnOk = false;
  }
  return _embColumnOk;
}

// ── compact storage ──
// One image = several views, each a 1280-number vector squeezed to signed
// 8-bit and written as base64 (~1.7 KB per view). Stored as
//   "<model><format>:<view1>|<view2>|<view3>"   e.g. "mnv2c3:AAEC…|…|…"
// where c3 = three views. Cosine similarity ignores scale, so the squeezing
// loses nothing that matters here.
function embPack(floats){
  let maxAbs = 0;
  for(let i=0;i<floats.length;i++){ const a = Math.abs(floats[i]); if(a > maxAbs) maxAbs = a; }
  if(!maxAbs) return null;
  let bin = '';
  for(let i=0;i<floats.length;i++){
    const q = Math.round(floats[i] / maxAbs * 127);
    bin += String.fromCharCode(q < 0 ? q + 256 : q);
  }
  return btoa(bin);
}
function embUnpack(b64){
  const bin = atob(b64);
  const vec = new Float32Array(bin.length);
  for(let j=0;j<bin.length;j++){ let b = bin.charCodeAt(j); if(b > 127) b -= 256; vec[j] = b; }
  return vec;
}
function embFormatTag(){ return _embTag + 'c' + EMB_CROPS.length; }
function embEncodeSet(tag, vectors){
  const parts = vectors.map(embPack);
  if(parts.some(p=>!p)) return null;
  return tag + ':' + parts.join('|');
}
function embDecode(str){
  if(!str || typeof str !== 'string') return null;
  const i = str.indexOf(':');
  if(i < 1) return null;
  try{
    const vecs = str.slice(i+1).split('|').map(embUnpack);
    return vecs.length ? { tag: str.slice(0, i), vecs } : null;
  }catch(e){
    return null;
  }
}
function embCosine(a, b){
  let dot = 0, na = 0, nb = 0;
  for(let i=0;i<a.length;i++){ dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na && nb) ? dot / Math.sqrt(na*nb) : 0;
}
function embScoreFromCosine(cos){
  const s = (cos - EMB_FLOOR) / (EMB_CEIL - EMB_FLOOR);
  return Math.max(0, Math.min(EMB_MAX_SCORE, s));
}

// ── the comparison app.js calls. a / b = { phash, embedding } ──
// Uses the AI score when BOTH sides have an embedding from the same model,
// otherwise falls back to the basic image-hash score.
//
// Each view is compared ONLY to its same-fraction counterpart (whole-vs-
// whole, 70%-vs-70%, 50%-vs-50%) and the three cosine scores are averaged —
// not maxed across all 9 cross-fraction combinations — so one fluke view
// can't be cherry-picked as "the" result.
//
// The averaged AI score is then BLENDED with the pixel-level dHash score
// (when both sides have a phash) instead of being trusted alone. MobileNet
// was trained on photographs, not flat-color/cartoon/vector art — stylized
// character art sits far outside what it knows, so unrelated cartoon images
// can produce a deceptively high cosine similarity purely from generic
// "flat colors + thick outlines" activations. Blending in the hash score
// means a spurious AI spike still gets pulled down somewhat when the actual
// pixels don't agree — but the blend is weighted heavily toward the AI score
// (EMB_BLEND_AI_WEIGHT = 0.85, see its comment above) specifically so that a
// genuinely high-confidence "same subject, different background" AI match
// CAN still reach SIMILARITY_BLOCK_THRESHOLD and actually block the upload,
// instead of being capped below it by dHash's ~50% baseline on unrelated
// content, which is what happened at the old 0.6 weight.
function similarityBetween(a, b){
  const dh = (a.phash && b.phash) ? phashSimilarity(a.phash, b.phash) : 0;
  const ea = embDecode(a.embedding), eb = embDecode(b.embedding);
  if(ea && eb && ea.tag === eb.tag){
    let sum = 0, n = 0;
    const len = Math.min(ea.vecs.length, eb.vecs.length);
    for(let i=0; i<len; i++){
      if(ea.vecs[i].length === eb.vecs[i].length){
        sum += embCosine(ea.vecs[i], eb.vecs[i]);
        n++;
      }
    }
    if(n > 0){
      const cos = sum / n;
      const aiScore = embScoreFromCosine(cos);
      const hasHash = !!(a.phash && b.phash);
      const blended = hasHash ? (aiScore * EMB_BLEND_AI_WEIGHT + dh * (1 - EMB_BLEND_AI_WEIGHT)) : aiScore;
      return { score: blended, cos, dh, method: hasHash ? 'ai+hash' : 'ai' };
    }
  }
  return { score: dh, cos: null, dh, method: 'hash' };
}

// ── turning an image into an embedding ──
function embLoadImage(src, cors){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    if(cors) img.crossOrigin = 'anonymous'; // Cloudinary allows this; needed so the canvas isn't "tainted"
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}

// A centred crop covering `frac` of the picture, shrunk for speed, on a white
// base so transparent PNGs don't turn black.
function embCropCanvas(img, frac){
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const cw = Math.max(1, Math.round(w * frac)), ch = Math.max(1, Math.round(h * frac));
  const sx = Math.floor((w - cw) / 2),          sy = Math.floor((h - ch) / 2);
  const scale = Math.min(1, EMB_MAX_SIDE / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width  = Math.max(1, Math.round(cw * scale));
  c.height = Math.max(1, Math.round(ch * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, cw, ch, 0, 0, c.width, c.height);
  return c;
}

async function embFromImageElement(img){
  const model = await ensureEmbeddingModel();
  if(!model) return null;
  try{
    const vectors = [];
    for(const frac of EMB_CROPS){
      const t = model.infer(embCropCanvas(img, frac), true);
      vectors.push(await t.data());
      t.dispose();
    }
    return embEncodeSet(embFormatTag(), vectors);
  }catch(err){
    console.warn('[AI similarity] could not analyse image:', err);
    return null;
  }
}

// For a file a student is uploading right now (no network needed for the image).
// Routes by type: images take the crop-views path, videos take the multi-frame
// path below, anything else (PDF/ZIP/…) returns null and relies on SHA-256.
async function embFromFile(file){
  if(!file || !file.type) return null;
  if(file.type.startsWith('video/')) return embFromVideoFile(file);
  if(!file.type.startsWith('image/')) return null;
  if(!(await embeddingColumnAvailable())) return null;
  if(!(await ensureEmbeddingModel())) return null;
  const url = URL.createObjectURL(file);
  try{
    const img = await embLoadImage(url, false);
    return await embFromImageElement(img);
  }catch(err){
    console.warn('[AI similarity] could not read uploaded file:', err);
    return null;
  }finally{
    URL.revokeObjectURL(url);
  }
}

// For an already-uploaded work (loaded from Cloudinary). Asks Cloudinary for a
// 512px-wide copy so the download is small; if that fails, uses the original.
// Pass isVideo=true for video rows (Cloudinary serves them the same way, but
// they need a <video> element with seeking instead of an <img>).
async function embFromUrl(fileUrl, isVideo){
  if(isVideo) return embFromVideoUrl(fileUrl);
  const candidates = [];
  if(fileUrl.indexOf('/image/upload/') > -1) candidates.push(fileUrl.replace('/image/upload/', '/image/upload/c_limit,w_512/'));
  candidates.push(fileUrl);
  for(const u of candidates){
    try{
      const img = await embLoadImage(u, true);
      const e = await embFromImageElement(img);
      if(e) return e;
    }catch(err){
      console.warn('[AI similarity] could not load', u, err.message);
    }
  }
  return null;
}

// ── VIDEO SIMILARITY ──
// A video is fingerprinted as K evenly-spread frames (10%…90% of duration),
// each analysed exactly like a still image. Stored as "<model>v<k>" (e.g.
// "mnv2v5") so video fingerprints NEVER compare against image fingerprints —
// similarityBetween() requires equal tags, and mismatched tags fall back to
// the hash, exactly as before. Two uploads of the same video (even
// re-encoded, trimmed at the edges, or with different posters) score ~99%;
// different videos score low. Frame-vs-frame, same-position average — the
// same math as the image crop views, just across time instead of across crops.
const EMB_VFRAMES = 5;
const EMB_VFRAME_TIMEOUT = 30000; // whole-video budget — never hang an upload or backfill on a bad file

function embVideoTag(){ return _embTag + 'v' + EMB_VFRAMES; }
function embIsCurrentVideo(str){
  return !!(str && _embTag && str.indexOf(embVideoTag() + ':') === 0);
}

function embVideoFrameCanvas(vid){
  const vw = vid.videoWidth, vh = vid.videoHeight;
  const scale = Math.min(1, EMB_MAX_SIDE / Math.max(vw, vh));
  const c = document.createElement('canvas');
  c.width  = Math.max(1, Math.round(vw * scale));
  c.height = Math.max(1, Math.round(vh * scale));
  c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
  return c;
}

function embSeek(vid, t, ms){
  return new Promise((resolve, reject)=>{
    const timer = setTimeout(()=>reject(new Error('seek timeout')), ms || 6000);
    const onSeeked = ()=>{
      clearTimeout(timer);
      vid.removeEventListener('seeked', onSeeked);
      resolve();
    };
    vid.addEventListener('seeked', onSeeked);
    try{ vid.currentTime = t; }
    catch(e){ clearTimeout(timer); vid.removeEventListener('seeked', onSeeked); reject(e); }
  });
}

async function embFramesFromVideoElement(vid){
  const model = await ensureEmbeddingModel();
  if(!model) return null;
  if(!vid.videoWidth) throw new Error('video has no dimensions yet');
  const dur = (vid.duration && isFinite(vid.duration) && vid.duration > 0) ? vid.duration : 0;
  const vectors = [];
  for(let i=0; i<EMB_VFRAMES; i++){
    const frac = EMB_VFRAMES === 1 ? 0.5 : 0.1 + (0.8 * i / (EMB_VFRAMES - 1));
    await embSeek(vid, dur * frac);
    const t = model.infer(embVideoFrameCanvas(vid), true);
    vectors.push(await t.data());
    t.dispose();
  }
  return embEncodeSet(embVideoTag(), vectors);
}

function embLoadVideo(src, cors){
  return new Promise((resolve, reject)=>{
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    if(cors) v.crossOrigin = 'anonymous'; // Cloudinary allows this; needed so the canvas isn't "tainted"
    v.onloadedmetadata = ()=>resolve(v);
    v.onerror = ()=>reject(new Error('video failed to load'));
    v.src = src;
  });
}

function embWithTimeout(promise, ms){
  let timer;
  const timeout = new Promise((_, reject)=>{ timer = setTimeout(()=>reject(new Error('video analysis timeout')), ms); });
  return Promise.race([promise, timeout]).finally(()=>clearTimeout(timer));
}

function embCleanupVideo(vid, url){
  try{
    if(url) URL.revokeObjectURL(url);
    vid.removeAttribute('src'); vid.load();
    vid.remove();
  }catch(e){}
}

// A video file a student is uploading right now.
async function embFromVideoFile(file){
  if(!(await embeddingColumnAvailable())) return null;
  if(!(await ensureEmbeddingModel())) return null;
  const url = URL.createObjectURL(file);
  let vid = null;
  try{
    vid = await embLoadVideo(url, false);
    return await embWithTimeout(embFramesFromVideoElement(vid), EMB_VFRAME_TIMEOUT);
  }catch(err){
    console.warn('[AI similarity] could not analyse video file:', err && err.message);
    return null;
  }finally{
    if(vid) embCleanupVideo(vid, url); else URL.revokeObjectURL(url);
  }
}

// An already-uploaded video (loaded from Cloudinary URL).
async function embFromVideoUrl(fileUrl){
  if(!(await embeddingColumnAvailable())) return null;
  if(!(await ensureEmbeddingModel())) return null;
  let vid = null;
  try{
    vid = await embLoadVideo(fileUrl, true);
    return await embWithTimeout(embFramesFromVideoElement(vid), EMB_VFRAME_TIMEOUT);
  }catch(err){
    console.warn('[AI similarity] could not analyse video URL:', err && err.message);
    return null;
  }finally{
    if(vid) embCleanupVideo(vid, null);
  }
}

// ── back-fill: give older works (uploaded before this feature) an embedding ──
// rows = portfolio_items rows with { id, file_url, file_type, embedding }.
// Fills in row.embedding in place, and saves it so it only ever has to be done
// once per work. Saving needs a professor UPDATE policy (see SQL setup); if
// that's missing, results still work — they're just recomputed next session.
// Completely silent: no toasts, no counters.
const _embMemCache = {};
let _embPersistOk = true;

function embIsCurrent(str){
  return !!(str && _embTag && str.indexOf(embFormatTag() + ':') === 0);
}

async function embEnsureForItems(rows){
  if(!(await embeddingColumnAvailable())) return;
  if(!(await ensureEmbeddingModel())) return;

  const need = [];
  rows.forEach(r=>{
    if(!r || !r.file_url) return;
    const f = { dataUrl: r.file_url, mimeType: r.file_type };
    const isVid = fileIsVideo(f);
    // Videos carry a v-tagged fingerprint, images a c-tagged one — each side
    // is only "current" against its own kind. PDFs/ZIPs still can't be
    // compared (they rely on SHA-256 exact matching instead).
    const isCurrent = isVid ? embIsCurrentVideo : embIsCurrent;
    if(isCurrent(r.embedding)) return;
    if(_embMemCache[r.id] && isCurrent(_embMemCache[r.id])){ r.embedding = _embMemCache[r.id]; return; }
    if(!fileIsImage(f) && !isVid) return;
    need.push(r);
  });
  if(!need.length) return;

  const batch = need.slice(0, EMB_BACKFILL_MAX);
  for(let i=0;i<batch.length;i++){
    const r = batch[i];
    const isVid = fileIsVideo({ dataUrl: r.file_url, mimeType: r.file_type });
    const e = await embFromUrl(r.file_url, isVid);
    if(!e) continue;
    r.embedding = e;
    _embMemCache[r.id] = e;
    if(_embPersistOk){
      try{
        const { data, error } = await sb.from('portfolio_items').update({ embedding: e }).eq('id', r.id).select('id');
        if(error || !data || !data.length){
          _embPersistOk = false;
          console.info('[AI similarity] could not save embeddings to the database (missing professor UPDATE policy?). Works will be re-analysed each session until that is added.');
        }
      }catch(err){
        _embPersistOk = false;
      }
    }
    await new Promise(res => setTimeout(res, 0)); // let the page breathe between images
  }
}

// ── background warm-up (professors) ──
// Called right after a professor signs in. Loads the model and analyses every
// older work that has no fingerprint yet, silently, so opening a review never
// has to wait. Safe to call repeatedly (it won't overlap, and re-checks for
// new works at most every 3 minutes).
let _embWarmPromise = null, _embWarmRunning = false, _embWarmLast = 0;
function embWarmPending(){ return _embWarmRunning; }
function embWarmUp(){
  if(_embWarmPromise && (_embWarmRunning || Date.now() - _embWarmLast < 180000)) return _embWarmPromise;
  _embWarmRunning = true;
  _embWarmPromise = (async()=>{
    try{
      if(!(await embeddingColumnAvailable())) return;
      if(!(await ensureEmbeddingModel())) return;
      const { data, error } = await sb
        .from('portfolio_items')
        .select('id, file_url, file_type, embedding')
        .order('uploaded_at', { ascending: false });
      if(error || !data) return;
      await embEnsureForItems(data);
    }catch(err){
      console.warn('[AI similarity] background analysis stopped:', err);
    }finally{
      _embWarmRunning = false;
      _embWarmLast = Date.now();
    }
  })();
  return _embWarmPromise;
}

// Human-readable explanation of which comparison method is active — shown in the
// Review Panel so a silent fallback to the basic image hash can never go unnoticed.
function embStatus(){
  if(_embColumnOk === false) return 'AI comparison OFF — the "embedding" column is missing in Supabase (run the SQL setup).';
  if(_embModelError)         return 'AI comparison OFF — the model could not be loaded ('+_embModelError+').';
  if(_embTag)                return 'AI comparison ON';
  return 'AI comparison OFF — model not started.';
}