// Rate limit: 15 requests per IP per minute
const RATE_LIMIT = 15;
const RATE_WINDOW = 60_000;
const ipHits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    ipHits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

function corsHeaders(origin, allowed) {
  const isAllowed = origin === allowed || origin === 'http://localhost:5500' || origin?.startsWith('http://127.0.0.1');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || 'https://poomxchapon.github.io';
    const headers = corsHeaders(origin, allowed);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // Only POST /api/chat
    const url = new URL(request.url);
    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return Response.json({ error: 'Not found' }, { status: 404, headers });
    }

    // Rate limit
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
      return Response.json(
        { error: 'Too many requests. Please wait a moment.' },
        { status: 429, headers }
      );
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400, headers });
    }

    const { messages, systemPrompt } = body;
    if (!messages || !systemPrompt) {
      return Response.json({ error: 'Missing messages or systemPrompt' }, { status: 400, headers });
    }

    // Call Gemini
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500, headers });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: messages,
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        }),
      });

      if (!geminiRes.ok) {
        const err = await geminiRes.json().catch(() => ({}));
        return Response.json(
          { error: err.error?.message || `Gemini API error ${geminiRes.status}` },
          { status: geminiRes.status, headers }
        );
      }

      const data = await geminiRes.json();
      const candidate = data.candidates?.[0];

      if (candidate?.finishReason === 'SAFETY') {
        return Response.json({ error: 'Response filtered for safety' }, { status: 400, headers });
      }

      const reply = candidate?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
      return Response.json({ reply }, { headers });

    } catch (err) {
      return Response.json(
        { error: 'Failed to reach Gemini API' },
        { status: 502, headers }
      );
    }
  },
};
