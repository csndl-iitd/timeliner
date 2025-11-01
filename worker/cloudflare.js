// worker.js
// Cloudflare Worker to proxy GitHub Device Flow endpoints with CORS.
// Deploy on Cloudflare Workers and set env var "GITHUB_CLIENT_ID" to your OAuth App Client ID.

addEventListener('fetch', event => {
  event.respondWith(handle(event));
});

async function handle(event) {
  const url = new URL(event.request.url);
  // allow OPTIONS CORS preflight
  if (event.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  // route: /device/code  -> POST to https://github.com/login/device/code
  // route: /device/token -> POST to https://github.com/login/oauth/access_token
  if (url.pathname === '/device/code' && event.request.method === 'POST') {
    return proxyDeviceCode(event);
  }
  if (url.pathname === '/device/token' && event.request.method === 'POST') {
    return proxyDeviceToken(event);
  }

  return new Response('Not found', { status: 404, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // if you prefer restrict to your GitHub Pages origin, change this
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Accept'
  };
}

async function proxyDeviceCode(event) {
  try {
    const body = await event.request.json().catch(() => ({}));
    const scope = body.scope || 'repo read:org';
    const clientId = GITHUB_CLIENT_ID || (typeof GITHUB_CLIENT_ID === 'string' ? GITHUB_CLIENT_ID : null);

    if (!clientId) {
      return new Response(JSON.stringify({ error: 'GITHUB_CLIENT_ID not configured in worker' }), {
        status: 500,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
      });
    }

    const resp = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope })
    });
    const j = await resp.json();
    return new Response(JSON.stringify(j), { status: resp.status, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()) });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()) });
  }
}

async function proxyDeviceToken(event) {
  try {
    const body = await event.request.json().catch(() => ({}));
    const device_code = body.device_code;
    if (!device_code) {
      return new Response(JSON.stringify({ error: 'device_code required' }), { status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()) });
    }
    const clientId = GITHUB_CLIENT_ID || (typeof GITHUB_CLIENT_ID === 'string' ? GITHUB_CLIENT_ID : null);
    if (!clientId) {
      return new Response(JSON.stringify({ error: 'GITHUB_CLIENT_ID not configured in worker' }), {
        status: 500,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
      });
    }

    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    });
    const j = await resp.json();
    return new Response(JSON.stringify(j), { status: resp.status, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()) });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()) });
  }
}
