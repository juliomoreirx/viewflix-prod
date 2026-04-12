// worker.js — Versão segura: credenciais nunca saem da VPS
// Worker conhece apenas: videoId, type, relay_secret
// VPS é quem monta a URL com login/senha do goplay internamente

async function verificarHmac(videoPath, sig, exp, uid, secret) {
  const now = Math.floor(Date.now() / 1000);
  if (now > parseInt(exp, 10) + 5) return { ok: false, reason: 'expired' };

  const payload = `${videoPath}:${exp}:${uid}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected.length !== sig.length) return { ok: false, reason: 'invalid' };

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: 'invalid' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // esperado: /stream/<videoId>.mp4?type=movie&uid=...&exp=...&sig=...
    const sig = url.searchParams.get('sig');
    const exp = url.searchParams.get('exp');
    const uid = url.searchParams.get('uid');
    const type = url.searchParams.get('type') || 'movie';

    if (!sig || !exp || !uid) {
      return new Response('Forbidden', { status: 403 });
    }

    const videoPath = url.pathname; // /stream/62339.mp4
    const check = await verificarHmac(videoPath, sig, exp, uid, env.SIGNED_SECRET);

    if (!check.ok) {
      return new Response(check.reason === 'expired' ? 'Link expirado' : 'Forbidden', {
        status: check.reason === 'expired' ? 410 : 403
      });
    }

    const m = videoPath.match(/^\/stream\/([A-Za-z0-9_-]+)\.mp4$/);
    if (!m) return new Response('Not found', { status: 404 });

    const videoId = m[1];

    const relayUrl = new URL(`${env.SERVER_BASE_URL}/relay-stream`);
    relayUrl.searchParams.set('videoId', videoId);
    relayUrl.searchParams.set('type', type);
    relayUrl.searchParams.set('relay_secret', env.RELAY_SECRET);

    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) relayUrl.searchParams.set('range', rangeHeader);

    const relayResponse = await fetch(relayUrl.toString(), {
      method: 'GET',
      cf: { cacheEverything: false }
    });

    const responseHeaders = new Headers(relayResponse.headers);
    responseHeaders.set('Cache-Control', 'no-store, private');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    responseHeaders.delete('Location');
    responseHeaders.delete('X-Origin-URL');

    return new Response(relayResponse.body, {
      status: relayResponse.status,
      headers: responseHeaders
    });
  }
};