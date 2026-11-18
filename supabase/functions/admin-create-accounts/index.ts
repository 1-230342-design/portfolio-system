// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: admin-create-accounts
//  POST (Authorization: Bearer <super-admin JWT>)
//  Body: { accounts: [{ role, student_id, full_name, section, department, password? }] }
//
//  Creates auth + user_profiles rows in one shot (bulk roster enrolment).
//  Each account is created with:
//    email        : {student_id}@asiatech.edu.ph
//    password     : (supplied) or {student_id}  (i.e. their student ID)
//    is_active    : true
//    email confirmed (auto) — no confirmation email goes to a shared password
//    role         : 'student' | 'professor'
//
//  Errors on individual accounts are collected and returned; the rest proceed.
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
  if(req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const auth = req.headers.get('Authorization');
    if(!auth) return json({ error: 'unauthorized' }, 401);

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { global: { headers: { Authorization: auth } } }
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if(userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

    const sr = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: me } = await sr
      .from('user_profiles')
      .select('is_super_admin, role')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if(!me || (me.role !== 'professor' && me.role !== 'admin') || !me.is_super_admin){
      return json({ error: 'super admin only' }, 403);
    }

    const body = await req.json().catch(() => null);
    const accounts: Array<{
      role?: string;
      student_id?: string;
      full_name?: string;
      section?: string | null;
      department?: string | null;
      password?: string;
    }> = Array.isArray(body?.accounts) ? body.accounts : [];

    if(!accounts.length) return json({ error: 'accounts[] required' }, 400);
    if(accounts.length > 200)  return json({ error: 'max 200 accounts per call' }, 400);

    const created: Array<{ student_id: string; user_id: string }> = [];
    const errors : Array<{ student_id: string; error: string }>    = [];

    for(const a of accounts){
      const student_id = (a.student_id || '').trim();
      if(!student_id){ errors.push({ student_id: '(missing)', error: 'student_id required' }); continue; }
      const email    = student_id.includes('@') ? student_id : `${student_id}@asiatech.edu.ph`;
      const password = (a.password && a.password.length >= 6) ? a.password : student_id;
      const role     = a.role === 'professor' ? 'professor' : 'student';
      const full_name = (a.full_name || '').trim() || role === 'professor' ? (a.full_name || '').trim() || 'Professor' : (a.full_name || '').trim() || 'Student';

      try {
        // Create auth account
        const { data: ad, error: aerr } = await sr.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name, role },
        });
        if(aerr){
          if(/already been registered|already exists/i.test(aerr.message || '')) {
            errors.push({ student_id, error: 'email already exists' });
          } else {
            errors.push({ student_id, error: aerr.message });
          }
          continue;
        }
        const user_id = ad.user?.id;
        if(!user_id){ errors.push({ student_id, error: 'no user_id returned' }); continue; }

        // Upsert the profile row
        const { error: profErr } = await sr.from('user_profiles').upsert([{
          user_id,
          full_name: full_name || student_id,
          student_id,
          email,
          section:   a.section   || null,
          department: a.department || null,
          role,
          is_active: true,
        }], { onConflict: 'user_id' });

        if(profErr){ errors.push({ student_id, error: 'profile: ' + profErr.message }); continue; }
        created.push({ student_id, user_id });
      } catch (err: any) {
        errors.push({ student_id, error: String(err?.message || err) });
      }
    }

    return json({ created, errors, total: created.length, failed: errors.length });
  } catch (err) {
    console.error('[admin-create-accounts] unexpected:', err);
    return json({ error: String(err) }, 500);
  }
});
