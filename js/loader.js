// ══════════════════════════════════════════════════════
//  Artfolio — Fragment Loader
//  Pulls in every page from /Pages and /Dashboard so the
//  markup can live in its own file instead of one giant HTML.
//  Must be served over http (e.g. VS Code Live Server) —
//  fetch() of local files is blocked under file://.
// ══════════════════════════════════════════════════════
async function loadIncludes(){
  const placeholders = Array.from(document.querySelectorAll('[data-include]'));

  await Promise.all(placeholders.map(async (el) => {
    const path = el.getAttribute('data-include');
    try{
      const res = await fetch(path, { cache: 'no-store' });
      if(!res.ok) throw new Error('HTTP '+res.status);
      el.outerHTML = await res.text();
    }catch(err){
      console.error('Could not load fragment:', path, err);
      el.outerHTML = `<div style="padding:40px;text-align:center;color:#f44336;font-family:sans-serif;">
        ⚠️ Could not load <code>${path}</code>.<br>
        Make sure Artfolio is running through a local server (e.g. VS Code "Go Live"), not opened directly as a file.
      </div>`;
    }
  }));

  // Every screen is now in the DOM — safe for app.js to look things up by id.
  document.dispatchEvent(new Event('artfolio:ready'));
}

document.addEventListener('DOMContentLoaded', loadIncludes);
