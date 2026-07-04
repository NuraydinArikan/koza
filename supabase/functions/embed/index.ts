// Supabase Edge Function: server-side proxy for OpenAI's embeddings API.
//
// src/lib/embeddings.ts posts { text } here instead of calling OpenAI
// directly, because the OpenAI key can never live in the browser bundle
// (VITE_ env vars are public, unlike this function's server-side secret).
//
// Deploy:  supabase functions deploy embed
// Secret:  supabase secrets set OPENAI_API_KEY=sk-...
//
// Known gap: Supabase's default JWT verification only proves the caller
// has *a* valid anon/user key, which is public in the client bundle by
// design - it does not rate-limit per device (anon_hash). A leaked or
// widely-distributed anon key could still be used to run up the OpenAI
// bill. Add per-device or per-IP rate limiting before this sees real
// production traffic.

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const MAX_TEXT_LENGTH = 4000; // bounds cost/latency per request

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return jsonResponse({ error: '"text" must be a non-empty string' }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `"text" must be at most ${MAX_TEXT_LENGTH} characters` }, 400);
  }

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'Server misconfigured: OPENAI_API_KEY not set' }, 500);
  }

  let openaiResponse: Response;
  try {
    openaiResponse = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to reach OpenAI: ${(err as Error).message}` }, 502);
  }

  if (!openaiResponse.ok) {
    const detail = await openaiResponse.text().catch(() => '');
    return jsonResponse({ error: `OpenAI request failed (${openaiResponse.status})`, detail }, 502);
  }

  const openaiBody = (await openaiResponse.json()) as {
    data?: Array<{ embedding?: unknown }>;
  };
  const embedding = openaiBody.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    return jsonResponse({ error: 'OpenAI returned an unexpected embedding shape' }, 502);
  }

  return jsonResponse({ embedding }, 200);
});
