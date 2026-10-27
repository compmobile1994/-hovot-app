// Cloudflare Pages Function - Google Sign-In -> session token.
// File-based route: functions/api/auth.js  ->  /api/auth
//
// Flow: the browser signs in with Google Identity Services and gets an ID token
// (a JWT). It POSTs { credential: "<id token>" } here. We verify the token against
// Google's public keys (so it can't be forged), check it was issued for THIS app,
// then mint a long-lived opaque session token stored in KV (sess:<token> -> {sub,email}).
// /api/sync accepts that session token and stores the user's data under u:<sub>.
//
// Requires: KV binding "DEBTS" and env var GOOGLE_CLIENT_ID (the OAuth client ID).

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const allowed = origin || '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(body, status = 200, request = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(request ? corsHeaders(request) : {}) }
  });
}

// Decode a base64url segment to a Uint8Array.
function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function b64urlToString(b64url) {
  return new TextDecoder().decode(b64urlToBytes(b64url));
}

// Cache Google's signing certs in module scope (they rotate; re-fetch hourly).
let _certs = null;
let _certsExpiry = 0;
async function getGoogleCerts() {
  const now = Date.now();
  if (_certs && now < _certsExpiry) return _certs;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('could not fetch Google certs');
  const data = await res.json();
  const map = {};
  for (const k of (data.keys || [])) map[k.kid] = k;
  _certs = map;
  _certsExpiry = now + 60 * 60 * 1000; // 1 hour
  return map;
}

// Verify a Google ID token and return its payload (throws on any failure).
async function verifyGoogleIdToken(idToken, clientId) {
  const parts = (idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlToString(headerB64));
  const payload = JSON.parse(b64urlToString(payloadB64));
  if (header.alg !== 'RS256') throw new Error('unexpected alg');

  const certs = await getGoogleCerts();
  const jwk = certs[header.kid];
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signed = new TextEncoder().encode(headerB64 + '.' + payloadB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sigB64), signed);
  if (!ok) throw new Error('bad signature');

  // Claim checks
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('bad issuer');
  }
  if (payload.aud !== clientId) throw new Error('token not issued for this app');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (!payload.sub) throw new Error('no subject');

  return payload;
}

function randomToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, request);
  }

  // The OAuth client ID is public (it is embedded in the page anyway), so we fall
  // back to the known value when no env var is set - no Cloudflare config needed.
  const clientId = env.GOOGLE_CLIENT_ID || '689453096519-no96bv5e6h8rd0kchb79kt3ggdsi1vga.apps.googleusercontent.com';
  if (!clientId) {
    return json({ error: 'Google sign-in not configured (missing GOOGLE_CLIENT_ID)' }, 500, request);
  }
  const store = env.DEBTS;
  if (!store) {
    return json({ error: 'Storage not configured (missing KV binding "DEBTS")' }, 500, request);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400, request);
  }
  const credential = body && body.credential;
  if (!credential || typeof credential !== 'string') {
    return json({ error: 'Missing Google credential' }, 400, request);
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential, clientId);
  } catch (e) {
    return json({ error: 'Invalid Google token: ' + e.message }, 401, request);
  }

  const token = randomToken();
  const session = { sub: payload.sub, email: payload.email || '', createdAt: new Date().toISOString() };
  try {
    await store.put('sess:' + token, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  } catch (e) {
    return json({ error: 'Server error: ' + e.message }, 500, request);
  }

  return json({ token, email: session.email }, 200, request);
}
