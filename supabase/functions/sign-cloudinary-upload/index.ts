// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: sign-cloudinary-upload
//  POST (Authorization: Bearer <session JWT>) →
//    { apiKey, signature, timestamp }
//
//  WHY: the browser used to POST straight to Cloudinary with only the
//  public upload-preset name — meaning ANYONE could upload to our
//  account (quota burn, storage bloat, abusive content under our name).
//  This function requires a logged-in user and returns a one-time
//  HMAC-SHA1 upload signature; the browser sends it alongside the POST.
//  Combined with the upload preset being set to "Signed" in the
//  Cloudinary dashboard, unsigned abuse posts are rejected by Cloudinary.
//
//  SECRETS (Dashboard → Edge Functions → Secrets):
//    CLOUDINARY_API_KEY    — from Cloudinary dashboard (public, but kept here)
//    CLOUDINARY_API_SECRET — from Cloudinary dashboard (NEVER in browser JS)
//    CLOUDINARY_CLOUD      — optional, defaults to drrel1ee7
//    CLOUDINARY_PRESET     — optional, defaults to portfolio_upload
//
//  DEPLOY: Dashboard → Edge Functions → create "sign-cloudinary-upload" →
//  paste this file → Deploy → add the two secrets above.
//  ORDER OF OPERATIONS (no downtime):
//    1. Deploy this function.
//    2. Ship the updated js/app.js (it asks for a signature; an unsigned
//       preset still accepts a correctly-signed POST, so nothing breaks).
//    3. Cloudinary → Settings → Upload → edit preset "portfolio_upload" →
//       change Preset type to SIGNED → Save. Now unsigned posts are dead.
//  ═══════════════════════════════════════════════════════════════════
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Cloudinary's upload-signature algorithm: HMAC-SHA1 (hex) over the
// alphabetically-sorted "name=value" pairs, joined by "&".
async function hmacSha1Hex(secret: string, msg: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    // 1. Only a signed-in user may get an upload signature.
    //    functions.invoke() attaches the session JWT automatically.
    const auth = req.headers.get('Authorization');
    if (!auth) return json({ error: 'unauthorized' }, 401);
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { global: { headers: { Authorization: auth } } }
    );
    const { data: { user }, error } = await admin.auth.getUser();
    if (error || !user) return json({ error: 'unauthorized' }, 401);

    // 2. Secrets. The API key can travel to the browser (it's public);
    //    the secret stays here and only the signature leaves.
    const apiKey  = Deno.env.get('CLOUDINARY_API_KEY');
    const secret  = Deno.env.get('CLOUDINARY_API_SECRET');
    if (!apiKey || !secret) {
      console.error('[sign-cloudinary-upload] secrets missing — set CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET.');
      return json({ error: 'missing-keys' }, 500);
    }

    // 3. Sign EXACTLY the params the browser will send (besides the file).
    //    Add nothing, remove nothing — Cloudinary re-computes the same
    //    string and any mismatch fails the upload.
    const preset = Deno.env.get('CLOUDINARY_PRESET') || 'portfolio_upload';
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      folder: 'artfolio',
      timestamp: String(timestamp),
      upload_preset: preset,
    };
    const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const signature = await hmacSha1Hex(secret, toSign);

    return json({ apiKey, signature, timestamp });
  } catch (err) {
    console.error('[sign-cloudinary-upload] unexpected error:', err);
    return json({ error: 'internal' }, 500);
  }
});
