// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: admin-wipe-storage
//  POST (Authorization: Bearer <super-admin JWT>)
//    { userIds: ["…"], scope: "uploads" | "everything" }
//
//  Deletes all Cloudinary assets referenced by portfolio_items for the
//  chosen students, then deletes those rows. \"uploads\" deletes every item
//  every chosen student owns; the roster itself (user_profiles, sections,
//  memberships) is untouched — the admin can then decide whether to also
//  remove the students entirely.
// ═══════════════════════════════════════════════════════════════════
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) return json({ error: 'unauthorized' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { global: { headers: { Authorization: auth } } }
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const sr = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: me } = await sr
      .from('user_profiles')
      .select('is_super_admin, role')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (!me || (me.role !== 'professor' && me.role !== 'admin') || !me.is_super_admin) {
      return json({ error: 'super admin only' }, 403);
    }

    const body = await req.json().catch(() => null);
    const userIds = Array.isArray(body?.userIds) ? body.userIds.filter((x: unknown) => typeof x === 'string') : [];
    if (!userIds.length) return json({ error: 'userIds[] required' }, 400);
    if (userIds.length > 500) return json({ error: 'too many targets (max 500)' }, 400);

    const apiKey    = Deno.env.get('CLOUDINARY_API_KEY')!;
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET')!;
    const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME') || 'drrel1ee7';

    // Find portfolios for these students
    const { data: ports, error: pe } = await sr
      .from('portfolios')
      .select('id')
      .in('student_id', userIds);
    if (pe) return json({ error: 'portfolios lookup failed: ' + pe.message }, 500);
    const portIds = (ports || []).map(p => p.id);
    if (!portIds.length) return json({ deleted: 0, assets: [], message: 'No portfolios found for those students.' });

    const { data: items, error: ie } = await sr
      .from('portfolio_items')
      .select('id, cloudinary_public_id, file_type')
      .in('portfolio_id', portIds);
    if (ie) return json({ error: 'items lookup failed: ' + ie.message }, 500);

    // Cloudinary destroy (signed) using public_id for each asset
    const ts  = Math.floor(Date.now() / 1000);
    const sha1 = async (input: string) => {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    };
    // Cloudinary signs with `public_id=<id>&timestamp=<ts>` + secret (no delimiter).
    const signDestroy = async (publicId: string, timestamp: number, apiSecret: string) => {
      const toSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
      return sha1(toSign);
    };

    let destroyed = 0;
    const errors: string[] = [];
    for (const item of items || []) {
      if (!item.cloudinary_public_id) continue;
      const publicId = item.cloudinary_public_id;
      const ts = Math.floor(Date.now() / 1000);
      // Try image, then video, then raw
      for (const rt of ['image', 'video', 'raw']) {
        try {
          const sig = await signDestroy(publicId, ts, apiSecret);
          const form = new URLSearchParams();
          form.set('public_id', publicId);
          form.set('timestamp', String(ts));
          form.set('api_key', apiKey);
          form.set('signature', sig);
          const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${rt}/destroy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
          });
          const j = await res.json();
          if (j?.result === 'ok' || j?.result === 'not_found') { destroyed++; break; }
        } catch (e) {
          errors.push(`${publicId}: ${String(e)}`);
        }
      }
    }

    // Delete dependent DB rows (items then portfolios) — only rows owned by the requested students
    const itemIds = (items || []).map(i => i.id);
    if (itemIds.length) {
      const { error: de } = await sr.from('portfolio_items').delete().in('id', itemIds);
      if (de) return json({ error: 'failed to delete items: ' + de.message }, 500);
    }
    if (portIds.length) {
      const { error: dp } = await sr.from('portfolios').delete().in('id', portIds);
      if (dp) return json({ error: 'failed to delete portfolios: ' + dp.message }, 500);
    }

    return json({ destroyed, total: (items||[]).length, errors, students: userIds.length });
  } catch (err) {
    console.error('[admin-wipe-storage] unexpected:', err);
    return json({ error: String(err) }, 500);
  }
});
