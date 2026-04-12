const express = require('express');
const axios = require('axios');
const { z } = require('zod');
const { HttpProxyAgent } = require('http-proxy-agent');
const env = require('../config/env');
const logger = require('../lib/logger');

const router = express.Router();

const querySchema = z.object({
  relay_secret: z.string().optional(),
  videoId: z.string().min(1),
  type: z.enum(['movie', 'series']).optional().default('movie')
});

// ===== PROXY RESIDENCIAL =====
const RES_PROXY_ENABLED = String(env.RES_PROXY_ENABLED || 'false')
  .replace(/['"]/g, '').trim().toLowerCase() === 'true';

const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

let residentialProxyAgent = null;
if (RES_PROXY_ENABLED && RES_PROXY_HOST && RES_PROXY_PORT && RES_PROXY_USER && RES_PROXY_PASS) {
  const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
  logger.info({ msg: 'relay: proxy residencial ativo', host: RES_PROXY_HOST, port: RES_PROXY_PORT });
} else {
  logger.info({ msg: 'relay: sem proxy residencial' });
}

// URL com credenciais — nunca exposta ao usuário, só usada internamente pelo relay
function resolveStreamUrl(videoId, type) {
  const login = env.LOGIN_USER || '';
  const senha = env.LOGIN_PASS || '';

  const base = type === 'series'
    ? (env.VIDEO_BASE_URL || env.VIDEO_BASE || 'http://goplay.icu/series')
    : (env.MOVIE_BASE_URL || env.MOVIE_BASE || 'http://goplay.icu/movie');

  if (login && senha) {
    return `${base}/${login}/${senha}/${encodeURIComponent(videoId)}.mp4`;
  }

  return `${base}/${encodeURIComponent(videoId)}.mp4`;
}

// Headers que podem vazar URL interna — nunca repassar ao cliente
const BLOCKED_RESPONSE_HEADERS = new Set([
  'location',
  'x-origin-url',
  'x-real-url',
  'x-upstream-url',
  'x-forwarded-for',
  'x-forwarded-host',
  'link'
]);

// Headers seguros para repassar ao cliente
const SAFE_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified'
];

router.get('/relay-stream', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse({
      relay_secret: req.query.relay_secret,
      videoId: req.query.videoId,
      type: req.query.type || 'movie'
    });

    if (!parsed.success) {
      return res.status(400).send('Invalid query');
    }

    const { relay_secret, videoId, type } = parsed.data;
    const range = req.headers.range;
    const requestId = req.requestId;

    if (!relay_secret || relay_secret !== env.RELAY_SECRET) {
      logger.warn({ msg: 'relay_secret invalido', requestId, ip: req.ip });
      return res.status(403).send('Forbidden');
    }

    const streamUrl = resolveStreamUrl(videoId, type);

    // Log sem expor credenciais — mostra só o videoId e tipo
    logger.info({
      msg: 'relay request iniciada',
      requestId,
      videoId,
      type,
      range: range || 'none',
      usingProxy: !!residentialProxyAgent
    });

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Referer': 'http://goplay.icu/',
      'Origin': 'http://goplay.icu',
      'Connection': 'keep-alive',
      ...(range ? { Range: range } : {})
    };

    if (env.SESSION_COOKIES) {
      headers.Cookie = env.SESSION_COOKIES;
    }

    const upstream = await axios.get(streamUrl, {
      responseType: 'stream',
      timeout: 60000,
      // Segue redirects automaticamente no servidor — cliente nunca vê as URLs intermediárias
      maxRedirects: 10,
      validateStatus: () => true,
      headers,
      proxy: true,
      httpAgent: residentialProxyAgent || undefined,
      httpsAgent: residentialProxyAgent || undefined
    });

    logger.info({
      msg: 'relay upstream status',
      requestId,
      status: upstream.status,
      contentType: upstream.headers['content-type'],
      contentLength: upstream.headers['content-length']
      // finalUrl omitido intencionalmente para não logar URL com token do goplay
    });

    if (upstream.status >= 400) {
      const chunks = [];
      upstream.data.on('data', (chunk) => chunks.push(chunk));
      upstream.data.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').substring(0, 200);
        logger.warn({ msg: 'upstream blocked', requestId, status: upstream.status, body });
      });
      return res.status(upstream.status).send('Upstream blocked');
    }

    // Repassa apenas headers seguros — bloqueia qualquer header que possa vazar URL interna
    SAFE_RESPONSE_HEADERS.forEach((h) => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    // Garante que o player consegue fazer range requests
    if (!upstream.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    // Remove explicitamente qualquer header sensível que possa ter escapado
    BLOCKED_RESPONSE_HEADERS.forEach((h) => res.removeHeader(h));

    res.status(upstream.status === 206 ? 206 : 200);
    upstream.data.pipe(res);

    upstream.data.on('error', (err) => {
      logger.error({ msg: 'relay pipe error', requestId, error: err.message });
      if (!res.headersSent) res.status(500).end();
    });

  } catch (error) {
    logger.error({
      msg: 'erro no /relay-stream',
      requestId: req.requestId,
      error: error.message
    });
    next(error);
  }
});

module.exports = router;