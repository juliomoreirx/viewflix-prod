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
  type: z.enum(['movie', 'series', 'livetv', 'live']).optional().default('movie')
});

const liveManifestSchema = z.object({
  relay_secret: z.string().optional(),
  videoId: z.string().min(1)
});

const liveSegmentSchema = z.object({
  relay_secret: z.string().optional(),
  u: z.string().url()
});

// Proxy apenas para autenticação rápida (não consome dados)
const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
const residentialProxyAgent = new HttpProxyAgent(proxyUrl);

const LIVE_SEGMENT_CACHE_TTL_MS = 45 * 1000;
const LIVE_SEGMENT_CACHE_MAX_ENTRIES = 180;
const LIVE_SEGMENT_FETCH_TIMEOUT_MS = 15000;

const liveSegmentCache = new Map();
const liveSegmentInFlight = new Map();

function cleanupLiveSegmentCache(now = Date.now()) {
  for (const [key, entry] of liveSegmentCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      liveSegmentCache.delete(key);
    }
  }

  while (liveSegmentCache.size > LIVE_SEGMENT_CACHE_MAX_ENTRIES) {
    const oldestKey = liveSegmentCache.keys().next().value;
    if (!oldestKey) break;
    liveSegmentCache.delete(oldestKey);
  }
}

function storeLiveSegmentCache(cacheKey, payload) {
  liveSegmentCache.set(cacheKey, {
    ...payload,
    expiresAt: Date.now() + LIVE_SEGMENT_CACHE_TTL_MS,
    lastAccessAt: Date.now()
  });

  cleanupLiveSegmentCache();
}

function getLiveSegmentCache(cacheKey) {
  const entry = liveSegmentCache.get(cacheKey);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    liveSegmentCache.delete(cacheKey);
    return null;
  }

  entry.lastAccessAt = Date.now();
  return entry;
}

async function fetchLiveSegment(absoluteUrl) {
  const response = await axios.get(absoluteUrl, {
    httpAgent: residentialProxyAgent,
    httpsAgent: residentialProxyAgent,
    headers: getRelayRequestHeaders(),
    timeout: LIVE_SEGMENT_FETCH_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxRedirects: 3,
    validateStatus: (status) => status >= 200 && status < 400
  });

  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] || 'video/mp2t',
    contentLength: response.headers['content-length'] ? Number(response.headers['content-length']) : undefined,
    cacheControl: response.headers['cache-control'] || 'public, max-age=30'
  };
}

async function getLiveSegmentPayload(absoluteUrl) {
  const cacheKey = absoluteUrl;
  const cached = getLiveSegmentCache(cacheKey);
  if (cached) {
    return { ...cached, source: 'cache' };
  }

  if (liveSegmentInFlight.has(cacheKey)) {
    return liveSegmentInFlight.get(cacheKey);
  }

  const inFlightPromise = (async () => {
    const payload = await fetchLiveSegment(absoluteUrl);
    storeLiveSegmentCache(cacheKey, payload);
    return { ...payload, source: 'origin' };
  })();

  liveSegmentInFlight.set(cacheKey, inFlightPromise);

  try {
    return await inFlightPromise;
  } finally {
    liveSegmentInFlight.delete(cacheKey);
  }
}

function getRelayRequestHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3',
    Referer: 'http://vouver.me/',
    Origin: 'http://vouver.me'
  };
}

async function resolveLiveTvFinalUrl(videoId) {
  const login = env.LOGIN_USER || '';
  const senha = env.LOGIN_PASS || '';
  const liveUrl = `http://goplay.icu/live/${login}/${senha}/${encodeURIComponent(videoId)}.m3u8`;

  const response = await axios.get(liveUrl, {
    httpAgent: residentialProxyAgent,
    httpsAgent: residentialProxyAgent,
    headers: getRelayRequestHeaders(),
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status <= 302
  });

  return response.headers.location || null;
}

function buildLiveSegmentRelayUrl(req, absoluteSegmentUrl) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/relay-live-segment?u=${encodeURIComponent(absoluteSegmentUrl)}&relay_secret=${encodeURIComponent(env.RELAY_SECRET || '')}`;
}

function rewriteLiveManifest(manifestText, finalManifestUrl, req) {
  const lines = String(manifestText || '').split(/\r?\n/);

  const rewritten = lines.map((line) => {
    const raw = String(line || '').trim();

    if (!raw || raw.startsWith('#')) return line;

    const absolute = /^https?:\/\//i.test(raw)
      ? raw
      : new URL(raw, finalManifestUrl).toString();

    return buildLiveSegmentRelayUrl(req, absolute);
  });

  return rewritten.join('\n');
}

router.get('/relay-stream', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse({
      relay_secret: req.query.relay_secret,
      videoId: req.query.videoId,
      type: req.query.type || 'movie'
    });

    if (!parsed.success) return res.status(400).send('Invalid query');

    const { relay_secret, videoId } = parsed.data;
    const type = parsed.data.type === 'live' ? 'livetv' : parsed.data.type;

    if (!relay_secret || relay_secret !== env.RELAY_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const login = env.LOGIN_USER || '';
    const senha = env.LOGIN_PASS || '';

    if (type === 'livetv') {
      const manifestRelayUrl = `/relay-live-manifest?videoId=${encodeURIComponent(videoId)}&relay_secret=${encodeURIComponent(relay_secret)}`;
      return res.redirect(302, manifestRelayUrl);
    }

    const streamUrl = `http://goplay.icu/${type === 'series' ? 'series' : 'movie'}/${login}/${senha}/${encodeURIComponent(videoId)}.mp4`;

    // 1. Usa o proxy apenas para descobrir a porta do cofre (0 consumo de dados pesados)
    const response = await axios.get(streamUrl, {
      httpAgent: residentialProxyAgent,
      httpsAgent: residentialProxyAgent,
      headers: getRelayRequestHeaders(),
      maxRedirects: 0, 
      validateStatus: (status) => status >= 200 && status <= 302
    });

    const finalUrl = response.headers.location;

    if (!finalUrl) {
      return res.status(404).send('Falha ao capturar IP do video.');
    }

    // 2. Remove o "http://" para que o Nginx consiga ler o caminho corretamente
    const urlLimpa = finalUrl.replace(/^https?:\/\//, '');

    logger.info({ msg: 'Delegando IP bruto para o Nginx', videoId, urlLimpa });

    if (req.headers.range) {
      res.setHeader('Range', req.headers.range);
    }

    // 3. O Node envia o IP dinâmico diretamente na URI do túnel
    res.setHeader('X-Accel-Redirect', `/proxy-stream/${urlLimpa}`);
    res.end();

  } catch (error) {
    logger.error({ msg: 'erro no /relay-stream', error: error.message });
    next(error);
  }
});

router.get('/relay-live-manifest', async (req, res, next) => {
  try {
    const parsed = liveManifestSchema.safeParse({
      relay_secret: req.query.relay_secret,
      videoId: req.query.videoId
    });

    if (!parsed.success) return res.status(400).send('Invalid query');

    const { relay_secret, videoId } = parsed.data;
    if (!relay_secret || relay_secret !== env.RELAY_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const finalManifestUrl = await resolveLiveTvFinalUrl(videoId);
    if (!finalManifestUrl) {
      return res.status(404).send('Manifest não encontrado');
    }

    const manifestResponse = await axios.get(finalManifestUrl, {
      httpAgent: residentialProxyAgent,
      httpsAgent: residentialProxyAgent,
      headers: getRelayRequestHeaders(),
      timeout: 15000,
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 400
    });

    const rewrittenManifest = rewriteLiveManifest(manifestResponse.data, finalManifestUrl, req);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, private, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    return res.status(200).send(rewrittenManifest);
  } catch (error) {
    logger.error({ msg: 'erro no /relay-live-manifest', error: error.message });
    return next(error);
  }
});

router.get('/relay-live-segment', async (req, res, next) => {
  try {
    const parsed = liveSegmentSchema.safeParse({
      relay_secret: req.query.relay_secret,
      u: req.query.u
    });

    if (!parsed.success) return res.status(400).send('Invalid query');

    const { relay_secret, u } = parsed.data;
    if (!relay_secret || relay_secret !== env.RELAY_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const payload = await getLiveSegmentPayload(u);

    res.setHeader('Content-Type', payload.contentType || 'video/mp2t');
    res.setHeader('Cache-Control', payload.cacheControl || `public, max-age=${Math.floor(LIVE_SEGMENT_CACHE_TTL_MS / 1000)}`);
    res.setHeader('Pragma', 'cache');

    if (payload.contentLength) {
      res.setHeader('Content-Length', String(payload.contentLength));
    }

    res.setHeader('X-Live-Segment-Source', payload.source || 'origin');
    return res.status(200).end(payload.buffer);
  } catch (error) {
    logger.error({ msg: 'erro no /relay-live-segment', error: error.message });
    return next(error);
  }
});

module.exports = router;