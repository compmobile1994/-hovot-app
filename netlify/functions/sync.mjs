// Cloud sync function - stores debt data by sync code
import { getStore } from "@netlify/blobs";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}

export default async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const code = (url.searchParams.get('code') || '').trim();

  // Validate sync code (alphanumeric, at least 4 chars)
  if (!code || code.length < 4 || code.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(code)) {
    return json({ error: 'Sync code must be 4-50 alphanumeric characters' }, 400);
  }

  const store = getStore('debts');

  try {
    if (req.method === 'GET') {
      const data = await store.get(code, { type: 'json' });
      return json(data || null);
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      // Stamp upload time
      const dataWithMeta = {
        ...body,
        _syncMeta: {
          uploadedAt: new Date().toISOString(),
          uploadedFrom: req.headers.get('user-agent') || 'unknown'
        }
      };

      await store.setJSON(code, dataWithMeta);
      return json({
        success: true,
        uploadedAt: dataWithMeta._syncMeta.uploadedAt
      });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'Server error: ' + err.message }, 500);
  }
};

export const config = {
  path: '/api/sync'
};
