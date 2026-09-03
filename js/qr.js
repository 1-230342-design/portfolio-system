// ══════════════════════════════════════════════════════
//  Artfolio — QR Code: Public Work Description
//  Lets a student generate a QR code for any of their
//  PUBLIC approved works. Scanning it opens a no-login
//  page (index.html?work=<item_id>) showing that work's
//  title, image, and description — meant to be printed
//  next to the physical artwork at an exhibit/defense.
//  Loaded after js/app.js — reuses its globals (sb, go,
//  esc, showToast).
// ══════════════════════════════════════════════════════

// ── Build the shareable URL a QR code should encode ──
function buildWorkPublicUrl(itemId){
  // location.pathname already includes /portfolio-system/ on GitHub Pages,
  // and just / on Live Server — this works in both without hardcoding either.
  return `${location.origin}${location.pathname}?work=${itemId}`;
}

// ── Build a goqr.me QR image URL for a given link ──
// goqr.me just renders a PNG from URL params — no library/CDN dependency,
// so this can't fail the way the old QRCode.js CDN load could.
function buildGoQrImageUrl(dataUrl, size){
  const s = size || 300;
  return `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&margin=10&data=${encodeURIComponent(dataUrl)}`;
}

// ── OPEN: render a QR code for one work into the shared modal ──
let currentQrItemId = null;
function showWorkQr(itemId){
  currentQrItemId = itemId;
  const url = buildWorkPublicUrl(itemId);
  document.getElementById('qr-link-text').textContent = url;

  const img = document.getElementById('qr-canvas');
  const loadingMsg = document.getElementById('qr-loading');
  if(loadingMsg) loadingMsg.style.display = 'block';
  img.style.display = 'none';
  img.onload = () => { if(loadingMsg) loadingMsg.style.display = 'none'; img.style.display = 'block'; };
  img.onerror = () => {
    if(loadingMsg) loadingMsg.style.display = 'none';
    showToast('❌ Could not generate QR code — check your internet connection.');
  };
  img.src = buildGoQrImageUrl(url, 300);

  document.getElementById('qrCodeOverlay').classList.add('open');
}
function closeQrModal(){
  document.getElementById('qrCodeOverlay').classList.remove('open');
  currentQrItemId = null;
}
function copyQrLink(){
  const url = document.getElementById('qr-link-text').textContent;
  navigator.clipboard.writeText(url).then(
    ()=>showToast('🔗 Link copied!'),
    ()=>showToast('⚠️ Could not copy — copy it manually.')
  );
}
// Download the QR as a PNG so it can be printed full-size next to the artwork.
// goqr.me serves the PNG directly, so this just triggers a download of that image.
async function downloadQrImage(){
  const url = document.getElementById('qr-link-text').textContent;
  if(!url || url === '—') return;
  try{
    const imgUrl = buildGoQrImageUrl(url, 600); // larger size for printing
    const res = await fetch(imgUrl);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'artfolio-work-qr.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }catch(err){
    console.error('QR download error:', err);
    showToast('❌ Could not download QR code.');
  }
}

// ══════════════════════════════════════════════════════
//  PUBLIC WORK PAGE — what opens when the QR is scanned
//  No login required. Only shows the work if it is BOTH
//  is_public = true on portfolio_items AND the parent
//  portfolio's status = 'approved' — same rule as the
//  public search/profile pages, so nothing pending or
//  private ever leaks through a shared QR/link.
// ══════════════════════════════════════════════════════
async function loadPublicWorkFromQR(itemId){
  const el = document.getElementById('qw-body');
  go('s-public-work');
  el.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:40px 0;text-align:center;">Loading…</div>`;

  try{
    const { data: item, error: ie } = await sb
      .from('portfolio_items')
      .select('id, portfolio_id, title, description, file_url, file_type, is_public')
      .eq('id', itemId)
      .eq('is_public', true)
      .maybeSingle();
    if(ie) throw ie;
    if(!item){ renderPublicWorkNotFound(); return; }

    const { data: portfolio, error: pe } = await sb
      .from('portfolios')
      .select('id, status, student_id, subjects(name,code)')
      .eq('id', item.portfolio_id)
      .eq('status', 'approved')
      .maybeSingle();
    if(pe) throw pe;
    if(!portfolio){ renderPublicWorkNotFound(); return; }

    const { data: profile } = await sb
      .from('user_profiles')
      .select('full_name, section, year_level')
      .eq('user_id', portfolio.student_id)
      .maybeSingle();

    const isImg = item.file_type && item.file_type.startsWith('image/');
    el.innerHTML = `
      ${isImg
        ? `<img src="${esc(item.file_url)}" alt="${esc(item.title)}" style="width:100%;max-height:480px;object-fit:contain;border-radius:14px;background:var(--surface2);margin-bottom:20px;"/>`
        : `<div class="upload-thumb-placeholder" style="height:240px;border-radius:14px;margin-bottom:20px;">🖼️</div>`}
      <h2 style="font-family:'DM Serif Display',serif;font-size:26px;color:var(--dark);margin-bottom:14px;">${esc(item.title)}</h2>
      <p style="font-size:14px;color:var(--text2);line-height:1.7;">${esc(item.description || 'No description provided.')}</p>
    `;
  }catch(err){
    console.error('loadPublicWorkFromQR error:', err);
    renderPublicWorkNotFound();
  }
}
function renderPublicWorkNotFound(){
  document.getElementById('qw-body').innerHTML = `
    <div class="empty-state">
      <p>This work isn't available. It may have been removed, unpublished, or the link is incorrect.</p>
    </div>`;
}

// ── On page load, check the URL for ?work=<id> and jump straight to the
//    public work view — bypassing login entirely, since that's exactly
//    what a stranger scanning a QR at an exhibit needs. ──
function checkForQrLink(){
  const params = new URLSearchParams(location.search);
  const workId = params.get('work');
  if(workId){ loadPublicWorkFromQR(workId); return true; }
  return false;
}