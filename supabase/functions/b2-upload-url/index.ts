// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: b2-upload-url
//
//  POST {}  →  { uploadUrl, uploadToken, fileName, publicBaseUrl }
//
//  Mints a ONE-SHOT Backblaze B2 upload target for the Storage card on
//  the Super Admin page. The application key never leaves this function:
//  the browser receives a short-lived upload URL + token and POSTs the
//  raw file straight to Backblaze, so large videos never pass through a
//  Supabase function (no body-size limit, no memory pressure).
//
//  WHO CAN CALL IT
//    Signed-in users only, and only accounts whose user_profiles row has
//    is_super_admin = true. Checked here with the service role, because
//    RLS alone is not enough for a token-minting endpoint.
//
//  SECRETS — Supabase Dashboard → Edge Functions → Secrets
//    B2_KEY_ID                  application key ID
//    B2_APPLICATION_KEY         application key (the secret, shown once)
//    B2_BUCKET_ID               only needed if the key isn't bucket-scoped
//    B2_PUBLIC_BASE_URL         optional, only for a PUBLIC bucket, e.g.
//                               https://f005.backblazeb2.com/file/artfolio
//
//  BUCKET REQUIREMENTS (Backblaze dashboard)
//    1. CORS Rules — allow the site origin(s), methods POST, headers
//       Authorization, Content-Type, X-Bz-File-Name, X-Bz-Content-Sha1.
//       Without this the browser upload fails with a CORS error.
//    2. Nothing else. The bucket can stay PRIVATE: this function also mints
//       a short-lived download token (needs the 'shareFiles' capability) so
//       the preview renders without making the bucket public.
//
//  DEPLOY: supabase functions deploy b2-upload-url
// ═══════════════════════════════════════════════════════════════════
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── super admins only ──
  try {
    const url     = Deno.env.get('SUPABASE_URL')!;
    const anon    = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const auth    = req.headers.get('Authorization') || '';

    if (!auth) return json({ error: 'not signed in' }, 401);

    // Identify the caller with their own JWT…
    const asUser = createClient(url, anon, {
      global: { headers: { Authorization: auth } },
    });
    const { data: who, error: whoErr } = await asUser.auth.getUser();
    if (whoErr || !who?.user) return json({ error: 'not signed in' }, 401);

    // …then confirm the super-admin flag with the service role, so a
    // professor cannot mint upload credentials for the demo bucket.
    const admin = createClient(url, service);
    const { data: prof, error: profErr } = await admin
      .from('user_profiles')
      .select('is_super_admin')
      .eq('user_id', who.user.id)
      .maybeSingle();

    if (profErr) {
      console.error('[b2-upload-url] profile lookup failed:', profErr);
      return json({ error: 'could not verify access' }, 500);
    }
    if (!prof?.is_super_admin) return json({ error: 'super admin only' }, 403);
  } catch (e) {
    console.error('[b2-upload-url] auth check failed:', e);
    return json({ error: 'auth check failed' }, 500);
  }

  // ── mint the upload target ──
  try {
    const keyId  = Deno.env.get('B2_KEY_ID');
    const appKey = Deno.env.get('B2_APPLICATION_KEY');
    if (!keyId || !appKey) {
      console.error('[b2-upload-url] B2_KEY_ID / B2_APPLICATION_KEY missing.');
      return json({ error: 'missing-keys', message: 'Set B2_KEY_ID and B2_APPLICATION_KEY.' }, 500);
    }

    const basic = btoa(`${keyId}:${appKey}`);
    const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: { Authorization: `Basic ${basic}` },
    });
    const authJson: any = await authRes.json();
    if (!authRes.ok) {
      console.error('[b2-upload-url] authorize failed:', authJson);
      return json({ error: 'authorize-failed', message: authJson?.message || 'B2 rejected the key.' }, 502);
    }

    const storage    = authJson?.apiInfo?.storageApi || {};
    const apiUrl     = storage.apiUrl;
    const downloadUrl = storage.downloadUrl;
    const bucketName = storage.bucketName;
    const token      = authJson?.authorizationToken;
    // A bucket-scoped key already knows its bucket; otherwise require the secret.
    const bucketId   = Deno.env.get('B2_BUCKET_ID') || storage.bucketId;

    if (!apiUrl || !token) return json({ error: 'authorize-incomplete' }, 502);
    if (!bucketId) {
      return json({
        error: 'no-bucket',
        message: 'Set B2_BUCKET_ID, or create the application key scoped to one bucket.',
      }, 500);
    }

    const upRes = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketId }),
    });
    const upJson: any = await upRes.json();
    if (!upRes.ok) {
      console.error('[b2-upload-url] get_upload_url failed:', upJson);
      return json({ error: 'upload-url-failed', message: upJson?.message || 'Could not create an upload URL.' }, 502);
    }

    // Demo files get a namespaced, collision-free name. No user input is
    // used here on purpose — the original filename never touches B2.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const rand  = Math.random().toString(36).slice(2, 8);
    const fileName = `demo/${stamp}-${rand}`;

    // Only an explicit env value counts as a public base. Deriving one from
    // the API's download host would hand the browser a plain URL even for a
    // PRIVATE bucket — which 401s in an <img>/<video> and hides the signed
    // link that actually works.
    const publicBase = Deno.env.get('B2_PUBLIC_BASE_URL') || null;

    // Private buckets would 401 in an <img>/<video>. Mint a short-lived
    // download token instead of asking the owner to make the bucket public.
    // Requires the 'shareFiles' capability; if the key lacks it we simply
    // return no token and the card says the file is private.
    let downloadToken: string | null = null;
    try {
      const dlRes = await fetch(`${apiUrl}/b2api/v3/b2_get_download_authorization`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucketId,
          fileNamePrefix: 'demo/',
          validDurationInSeconds: 3600,
        }),
      });
      const dlJson: any = await dlRes.json();
      if (dlRes.ok) downloadToken = dlJson.authorizationToken || null;
      else console.warn('[b2-upload-url] download authorization failed:', dlJson);
    } catch (e) {
      console.warn('[b2-upload-url] download authorization error:', e);
    }

    return json({
      uploadUrl:   upJson.uploadUrl,
      uploadToken: upJson.authorizationToken,
      fileName,
      bucketName:  bucketName || null,
      downloadUrl: downloadUrl || null,
      downloadToken,
      publicBaseUrl: publicBase,
    });
  } catch (e) {
    console.error('[b2-upload-url] unexpected failure:', e);
    return json({ error: 'unexpected', message: 'Could not create an upload target.' }, 500);
  }
});
