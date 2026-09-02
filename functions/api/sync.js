// Cloudflare Pages Function - cloud sync for debt data, backed by Cloudflare KV.
// File-based route: functions/api/sync.js  ->  /api/sync
// Ported from the Netlify function (netlify/functions/sync.mjs); Netlify Blobs -> KV.
// Requires a KV namespace bound to this Pages project with the variable name: DEBTS

// CORS. No cookies/credentials are used - the secret sync code in the query string is
// the sole access control - so it's safe to reflect whatever Origin the browser sends.
// This lets the app work when opened as a local file (file:// pages send "Origin: null"),
// from the deployed site, or from a local dev server, without an allowlist to maintain.
function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  // Reflect the caller's origin (including the literal "null" that file:// pages send).
  // Fall back to "*" when there's no Origin header (e.g. same-origin GET requests).
  const allowed = origin || '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// 1MB max body size to prevent abuse
const MAX_BODY_SIZE = 1024 * 1024;

function json(body, status = 200, request = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(request ? corsHeaders(request) : {})
    }
  });
}

// Validate state shape on server-side too (defense in depth)
function validateStateShape(data) {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.customers)) return false;
  if (data.customers.length > 1000) return false; // sane limit
  for (const c of data.customers) {
    if (!c || typeof c !== 'object') return false;
    if (typeof c.id !== 'string' || typeof c.name !== 'string') return false;
    if (!Array.isArray(c.transactions)) return false;
    if (c.transactions.length > 10000) return false;
    for (const t of c.transactions) {
      if (!t || typeof t !== 'object') return false;
      if (typeof t.amount !== 'number' || !isFinite(t.amount)) return false;
      if (typeof t.type !== 'string' || !['debt', 'payment', 'discount'].includes(t.type)) return false;
    }
  }
  return true;
}

// Strip dangerous prototype-pollution keys
function sanitize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = sanitize(obj[key]);
  }
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();

  // Validate sync code - 6+ chars alphanumeric for better security
  if (!code || code.length < 6 || code.length > 100 || !/^[a-zA-Z0-9_\-]+$/.test(code)) {
    return json({ error: 'Sync code must be 6-100 characters (letters, numbers, _, -)' }, 400, request);
  }

  // KV namespace binding (set in Cloudflare Pages project settings, variable name: DEBTS)
  const store = env.DEBTS;
  if (!store) {
    return json({ error: 'Storage not configured (missing KV binding "DEBTS")' }, 500, request);
  }

  try {
    if (request.method === 'GET') {
      const data = await store.get(code, { type: 'json' });
      return json(data || null, 200, request);
    }

    if (request.method === 'POST') {
      // Check body size before parsing
      const contentLength = parseInt(request.headers.get('content-length') || '0');
      if (contentLength > MAX_BODY_SIZE) {
        return json({ error: 'Request body too large (max 1MB)' }, 413, request);
      }

      let body;
      try {
        const text = await request.text();
        if (text.length > MAX_BODY_SIZE) {
          return json({ error: 'Request body too large' }, 413, request);
        }
        body = JSON.parse(text);
      } catch (e) {
        return json({ error: 'Invalid JSON body' }, 400, request);
      }

      // Sanitize and validate
      const cleaned = sanitize(body);
      if (!validateStateShape(cleaned)) {
        return json({ error: 'Data structure is invalid' }, 400, request);
      }

      // Stamp upload time
      const dataWithMeta = {
        ...cleaned,
        _syncMeta: {
          uploadedAt: new Date().toISOString(),
          uploadedFrom: (request.headers.get('user-agent') || 'unknown').slice(0, 200)
        }
      };

      await store.put(code, JSON.stringify(dataWithMeta));
      return json({
        success: true,
        uploadedAt: dataWithMeta._syncMeta.uploadedAt
      }, 200, request);
    }

    return json({ error: 'Method not allowed' }, 405, request);
  } catch (err) {
    return json({ error: 'Server error: ' + err.message }, 500, request);
  }
}
