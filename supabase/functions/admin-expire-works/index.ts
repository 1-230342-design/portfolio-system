// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: admin-expire-works
//  POST { before: ISO timestamp } — flips is_public=false on every
//  portfolio_item uploaded on or before that date. After that moment,
//  works from that semester stop showing in public portfolios /
//  rankings pages (the user keeps their files; we just unexpose them).
//  Only super admins can call this.
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
    const before = body?.before;
    if (!before || isNaN(new Date(before).getTime()))
      return json({ error: 'before (ISO timestamp) is required' }, 400);

    const isoCutoff = new Date(before).toISOString();

    const { data, error } = await sr
      .from('portfolio_items')
      .update({ is_public: false, expired_at: new Date().toISOString() })
      .eq('is_public', true)
      .lt('uploaded_at', isoCutoff)
      .select('id');
    if (error) return json({ error: error.message }, 500);

    return json({ updated: (data || []).length, before: isoCutoff });
  } catch (err) {
    console.error('[admin-expire-works] unexpected:', err);
    return json({ error: String(err) }, 500);
  }
});
