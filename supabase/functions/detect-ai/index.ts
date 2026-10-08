// ═══════════════════════════════════════════════════════════════════
//  Artfolio — Supabase Edge Function: detect-ai
//  POST { imageUrl } → { aiScore: 0..1 | null, generator: string | null }
//
//  Relays the image URL to Sightengine's FREE 'genai' model (AI-generated
//  image detection). The api_user/api_secret NEVER live in browser JS —
//  they're Edge Function secrets (SIGHTENGINE_API_USER /
//  SIGHTENGINE_API_SECRET), set via Dashboard → Edge Functions → Secrets,
//  same pattern as the existing 'imagga-tags' function.
//
//  HOW TO DEPLOY (once, ~3 minutes):
//    1. Supabase Dashboard → Edge Functions → Create function → name it
//       exactly: detect-ai
//    2. Delete the sample code, paste this entire file, Deploy.
//    3. Edge Functions → Secrets → add SIGHTENGINE_API_USER and
//       SIGHTENGINE_API_SECRET (from dashboard.sightengine.com → API keys).
//    4. Run supabase-ai-score.sql in the SQL Editor (adds the ai_score col).
//    5. Done — the app (v82+) calls this at upload and shows an ADVISORY
//       badge in the professor review panel. It never blocks uploads:
//       detectors can misflag real digital art, so the professor decides.
// ═══════════════════════════════════════════════════════════════════
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

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
    const { imageUrl } = await req.json();
    if (!imageUrl || typeof imageUrl !== 'string') {
      return json({ aiScore: null });
    }
    const user = Deno.env.get('SIGHTENGINE_API_USER');
    const secret = Deno.env.get('SIGHTENGINE_API_SECRET');
    if (!user || !secret) {
      console.error('[detect-ai] secrets missing — set SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET.');
      return json({ aiScore: null, error: 'missing-keys' });
    }
    const apiUrl =
      'https://api.sightengine.com/1.0/check.json?url=' + encodeURIComponent(imageUrl) +
      '&models=genai&api_user=' + encodeURIComponent(user) +
      '&api_secret=' + encodeURIComponent(secret);
    const r = await fetch(apiUrl);
    const j = await r.json();
    if (!j || j.status !== 'success') {
      console.error('[detect-ai] sightengine error:', JSON.stringify(j).slice(0, 300));
      return json({ aiScore: null }); // quota spent / bad URL — upload must never fail because of this
    }
    const score = j?.type?.ai_generated;
    // top-scoring generator, for the review badge footnote (may be null)
    let generator: string | null = null;
    try {
      const gens = j?.type?.ai_generators;
      if (gens && typeof gens === 'object') {
        let best = -1;
        for (const [name, v] of Object.entries(gens)) {
          if (typeof v === 'number' && v > best) { best = v; generator = name; }
        }
        if (best < 0.05) generator = null;
      }
    } catch { generator = null; }
    return json({
      aiScore: typeof score === 'number' ? score : null,
      generator,
    });
  } catch (err) {
    console.error('[detect-ai] unexpected error:', err);
    return json({ aiScore: null });
  }
});
