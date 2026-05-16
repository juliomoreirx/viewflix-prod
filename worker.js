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

  // Comparação em tempo constante para evitar ataques de temporização (Timing Attacks)
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: 'invalid' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Esperado: /stream/<videoId>.mp4?type=movie&uid=...&exp=...&sig=...
    const sig = url.searchParams.get('sig');
    const exp = url.searchParams.get('exp');
    const uid = url.searchParams.get('uid');
    const type = url.searchParams.get('type') || 'movie';

    if (!sig || !exp || !uid) {
      return new Response('Forbidden', { status: 403 });
    }

    const videoPath = url.pathname; // Ex: /stream/62339.mp4
    const check = await verificarHmac(videoPath, sig, exp, uid, env.SIGNED_SECRET);

    if (!check.ok) {
      return new Response(check.reason === 'expired' ? 'Link expirado' : 'Forbidden', {
        status: check.reason === 'expired' ? 410 : 403
      });
    }

    const m = videoPath.match(/^\/stream\/([A-Za-z0-9_-]+)\.mp4$/);
    if (!m) return new Response('Not found', { status: 404 });

    const videoId = m[1];

    // Montar URL de encaminhamento para a VPS principal
    const relayUrl = new URL(`${env.SERVER_BASE_URL}/relay-stream`);
    relayUrl.searchParams.set('videoId', videoId);
    relayUrl.searchParams.set('type', type);
    relayUrl.searchParams.set('relay_secret', env.RELAY_SECRET);

    // ==========================================
    // 🚀 CORREÇÃO SÊNIOOOOR: ENCAMINHAMENTO DE HEADERS
    // ==========================================
    const forwardHeaders = new Headers();
    
    // Passamos obrigatoriamente o header Range para que a VPS e o Nginx saibam qual pedaço do vídeo entregar
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      forwardHeaders.set('Range', rangeHeader);
    }
    
    // Repassamos o User-Agent original para que o middleware de detecção de bots na VPS funcione perfeitamente
    const userAgent = request.headers.get('user-agent');
    if (userAgent) {
      forwardHeaders.set('user-agent', userAgent);
    }

    // Faz o pedido em background para a VPS injetando os headers corretos
    const relayResponse = await fetch(relayUrl.toString(), {
      method: 'GET',
      headers: forwardHeaders, // <-- INJETADO AQUI CORRETAMENTE
      cf: { cacheEverything: false } // Evita que a Cloudflare armazene em cache tokens privados de streams dinâmicos
    });

    // Clonar cabeçalhos de resposta para limpar informações sensíveis da VPS antes de devolver ao cliente
    const responseHeaders = new Headers(relayResponse.headers);
    responseHeaders.set('Cache-Control', 'no-store, private, must-revalidate');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    
    // Segurança: Deleta headers que exponham caminhos de arquivos locais ou redirecionamentos internos
    responseHeaders.delete('Location');
    responseHeaders.delete('X-Origin-URL');

    return new Response(relayResponse.body, {
      status: relayResponse.status,
      headers: responseHeaders
    });
  }
};