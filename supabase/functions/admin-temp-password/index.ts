// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: admin-temp-password
//  POST (Authorization: Bearer <super-admin JWT>) { userId, password }
//  Verifies caller is a super admin via is_super_admin(), then sets a
//  temporary password for the target account using the service role.
//  Intended for locked-out users the super admin chooses to revive.
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

    // 1. Verify the CALLER is a super admin, defense-in-depth (the UI
    //    shouldn't be reachable for anyone else either).
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { global: { headers: { Authorization: auth } } }
    );
    const { data: callerUser, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerUser?.user) return json({ error: 'unauthorized' }, 401);

    // Service-role lookup of the caller's profile, bypassing RLS just for checks.
    const sr = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: me } = await sr
      .from('user_profiles')
      .select('is_super_admin, role')
      .eq('user_id', callerUser.user.id)
      .maybeSingle();
    if (!me || (me.role !== 'professor' && me.role !== 'admin') || !me.is_super_admin) {
      return json({ error: 'super admin only' }, 403);
    }

    const body = await req.json().catch(() => null);
    const userId  = body?.userId;
    const password = body?.password;
    if (!userId || typeof userId !== 'string') return json({ error: 'userId required' }, 400);
    if (!password || typeof password !== 'string' || password.length < 6)
      return json({ error: 'password must be at least 6 characters' }, 400);

    // 2. Set the password. The client sends a plain password; we pass it
    //    straight to the Admin API. The caller is a verified super admin.
    const { error: updErr } = await sr.auth.admin.updateUserById(userId, { password });
    if (updErr) {
      console.error('[admin-temp-password] updateUserById failed:', updErr);
      return json({ error: updErr.message || 'failed to set password' }, 500);
    }
    return json({ ok: true });
  } catch (err) {
    console.error('[admin-temp-password] unexpected:', err);
    return json({ error: 'internal' }, 500);
  }
});
