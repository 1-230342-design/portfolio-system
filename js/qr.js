// ══════════════════════════════════════════════════════
//  Artfolio — QR Code utilities + Public Work page
//  Per-artwork QR generation was removed: the single contact QR in the
//  portfolio header (see renderContactQr/downloadContactQr in app.js) is now
//  the only QR in the system. What remains here: the goqr.me image builder
//  the contact QR uses, plus the no-login ?work=<id> destination page so any
//  already-printed artwork QRs still resolve instead of breaking.
//  Loaded after js/app.js — reuses its globals (sb, go, esc, showToast).
// ══════════════════════════════════════════════════════

// ── Build a goqr.me QR image URL for a given link ──
// goqr.me just renders a PNG from URL params — no library/CDN dependency,
// so this can't fail the way the old QRCode.js CDN load could.
function buildGoQrImageUrl(dataUrl, size){
  const s = size || 300;
  return `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&margin=10&data=${encodeURIComponent(dataUrl)}`;
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

    // Base profile first (columns that always exist), then the QR opt-in
    // columns separately — if supabase-qr-social.sql was never run, that
    // second query fails and we simply fall back to the description instead
    // of losing the whole profile (and the artist's name with it).
    const { data: profile } = await sb
      .from('user_profiles')
      .select('full_name, section, year_level')
      .eq('user_id', portfolio.student_id)
      .maybeSingle();
    try{
      const { data: qrOpt, error: qrErr } = await sb
        .from('user_profiles')
        .select('social_link, show_social_on_qr')
        .eq('user_id', portfolio.student_id)
        .maybeSingle();
      if(!qrErr && qrOpt && profile){
        profile.social_link = qrOpt.social_link;
        profile.show_social_on_qr = qrOpt.show_social_on_qr;
      }
    }catch(optErr){
      console.info('[qr] social opt-in unavailable — showing description. Run supabase-qr-social.sql to enable contact cards.');
    }

    // Reuse the same file-type helpers app.js uses everywhere else, so this
    // page treats images/videos identically to the rest of the app instead
    // of having its own (incomplete) check. Previously this only checked
    // item.file_type.startsWith('image/') and anything else — including
    // video — fell through to the static placeholder, so a scanned video
    // link never actually played.
    const fileObj = { dataUrl: item.file_url, mimeType: item.file_type };
    const isImg = fileIsImage(fileObj);
    const isVid = fileIsVideo(fileObj);
    // Contact card vs description: the artist's social link replaces the
    // description ONLY when they opted in (Edit Profile checkbox,
    // show_social_on_qr). Default/off, or no link set = description as
    // before, so nothing private ever leaks through a shared QR.
    const artistName = (profile && profile.full_name) || 'Student';
    const showSocial = !!(profile && profile.show_social_on_qr && profile.social_link);
    const rawLink = showSocial ? profile.social_link.trim() : '';
    const socialHref = rawLink && (/^https?:\/\//i.test(rawLink) ? rawLink : 'https://' + rawLink);
    const underTitle = showSocial
      ? `<div style="background:var(--surface);border-radius:14px;padding:20px;margin-top:6px;text-align:center;">
          <div style="font-size:11px;letter-spacing:1.5px;font-weight:700;color:var(--text3);margin-bottom:6px;">📱 CONTACT THE ARTIST</div>
          <div style="font-size:16px;font-weight:700;color:var(--dark);margin-bottom:12px;">${esc(artistName)}</div>
          <a href="${esc(socialHref)}" target="_blank" rel="noopener" class="btn-submit-work" style="text-decoration:none;display:inline-flex;max-width:100%;white-space:normal;overflow-wrap:anywhere;word-break:break-all;line-height:1.5;">${esc(rawLink)}</a>
        </div>`
      : `<p style="font-size:14px;color:var(--text2);line-height:1.7;">${esc(item.description || 'No description provided.')}</p>
         <div style="font-size:12px;color:var(--text3);margin-top:14px;">by ${esc(artistName)}</div>`;
    el.innerHTML = `
      ${isImg
        ? `<img src="${esc(item.file_url)}" alt="${esc(item.title)}" style="width:100%;max-height:480px;object-fit:contain;border-radius:14px;background:var(--surface2);margin-bottom:20px;"/>`
        : isVid
          ? `<video src="${esc(item.file_url)}" controls style="width:100%;max-height:480px;border-radius:14px;background:#000;margin-bottom:20px;"></video>`
          : `<div class="upload-thumb-placeholder" style="height:240px;border-radius:14px;margin-bottom:20px;">🖼️</div>`}
      <h2 style="font-family:'Fraunces',serif;font-size:26px;color:var(--dark);margin-bottom:14px;">${esc(item.title)}</h2>
      ${underTitle}
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