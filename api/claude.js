// api/claude.js — Vercel Edge Function
// Proxies requests to the Anthropic API, keeps the API key server-side,
// and enforces rate limits (free: 10 req/day, pro: unlimited).

export const config = { runtime: 'edge' };

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const FREE_DAILY_LIMIT = 10;

// Simple in-memory rate limiting — swap for Upstash Redis in production
// for persistence across edge regions.
const rateLimits = new Map();

function getRateLimitKey(req) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
           || req.headers.get('x-real-ip')
           || 'unknown';
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `${ip}:${today}`;
}

function isRateLimited(key, isPro) {
  if (isPro) return false; // Pro users: unlimited
  const count = rateLimits.get(key) || 0;
  if (count >= FREE_DAILY_LIMIT) return true;
  rateLimits.set(key, count + 1);
  return false;
}

function corsHeaders(origin) {
  // In production, lock this down to ['https://solowandr.app']
  const allowedOrigins = [
    'https://solowandr.app',
    'https://www.solowandr.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ];
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Pro-Token',
    'Access-Control-Max-Age': '86400',
  };
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  try {
    // Parse the incoming request
    const body = await req.json();

    // Check for Pro token (in production, verify against Supabase)
    const proToken = req.headers.get('X-Pro-Token') || '';
    const isPro = proToken.length > 10; // TODO: validate against Supabase JWT

    // Rate limiting check
    const rateLimitKey = getRateLimitKey(req);
    if (isRateLimited(rateLimitKey, isPro)) {
      const remaining = `0/${FREE_DAILY_LIMIT}`;
      return new Response(
        JSON.stringify({
          error: 'Daily limit reached',
          message: `Free tier is limited to ${FREE_DAILY_LIMIT} AI requests per day. Upgrade to SoloWandr Pro for unlimited access.`,
          upgrade_url: 'https://solowandr.app/?screen=home#pro',
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders(origin),
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': String(FREE_DAILY_LIMIT),
            'X-RateLimit-Remaining': remaining,
          },
        }
      );
    }

    // Build the Anthropic request — strip any injected fields from client
    const anthropicPayload = {
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: Math.min(body.max_tokens || 1000, 2000), // cap at 2000
      messages: body.messages,
      // Optional: system prompt can be added here for all SoloWandr requests
    };

    // Optional system prompt for all SoloWandr requests
    if (!anthropicPayload.system) {
      anthropicPayload.system = 'You are SoloWandr\'s AI assistant, specialising in solo travel. Always give specific, honest, actionable advice for solo travelers. Respond in the requested JSON format exactly.';
    }

    // Forward to Anthropic
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY, // set in Vercel env vars
      },
      body: JSON.stringify(anthropicPayload),
    });

    const data = await response.json();

    // Add rate limit headers to response
    const used = (rateLimits.get(rateLimitKey) || 1);
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(FREE_DAILY_LIMIT),
        'X-RateLimit-Remaining': isPro ? 'unlimited' : String(Math.max(0, FREE_DAILY_LIMIT - used)),
        'X-RateLimit-Pro': String(isPro),
      },
    });

  } catch (err) {
    console.error('SoloWandr API proxy error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      }
    );
  }
}
