// src/routes/stream.routes.js
const express = require('express');
const axios = require('axios');
const { z } = require('zod');
const { HttpProxyAgent } = require('http-proxy-agent');
const env = require('../config/env');
const logger = require('../lib/logger');
const hlsProxyService = require('../services/hls-proxy.service'); // <-- INJETADO: Necessário para a assinatura com Node v24

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

const liveTvBufferStatusSchema = z.object({
  channelId: z.string().trim().min(1).max(200)
});

// Proxy Residencial via Zod Env
let residentialProxyAgent = null;
if (env.RES_PROXY_ENABLED && env.RES_PROXY_HOST && env.RES_PROXY_PORT) {
  const proxyUrl = `http://${encodeURIComponent(env.RES_PROXY_USER)}:${encodeURIComponent(env.RES_PROXY_PASS)}@${env.RES_PROXY_HOST}:${env.RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
}

const LIVE_SEGMENT_CACHE_TTL_MS = 600 * 1000; // 10 minutos (em vez de 45 segundos)
const LIVE_SEGMENT_CACHE_MAX_ENTRIES = 600; // 600 segmentos (em vez de 180) = 6.000 segundos com 10s por segmento
const LIVE_SEGMENT_FETCH_TIMEOUT_MS = 15000;
const LIVE_SEGMENT_RETRY_DELAY_MS = 250;
const LIVE_SEGMENT_RETRY_ATTEMPTS = 2;

const VOD_RESOLVE_TTL_MS = 2 * 60 * 1000;
const VOD_RESOLVE_STALE_TTL_MS = 10 * 60 * 1000;
const vodResolveCache = new Map();

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
  let lastError = null;

  for (let attempt = 0; attempt <= LIVE_SEGMENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      logger.warn({
        msg: '[LiveTV Segment Fetch Failed]',
        attempt: attempt + 1,
        maxAttempts: LIVE_SEGMENT_RETRY_ATTEMPTS + 1,
        status,
        url: absoluteUrl,
        error: error.message
      });

      if (attempt < LIVE_SEGMENT_RETRY_ATTEMPTS && (status === 404 || status >= 500 || !status)) {
        await new Promise((resolve) => setTimeout(resolve, LIVE_SEGMENT_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Falha ao buscar segmento LiveTV');
}

async function getLiveSegmentPayload(absoluteUrl) {
  const cacheKey = absoluteUrl;
  const cached = getLiveSegmentCache(cacheKey);
  if (cached) {
    logger.debug({ msg: '[LiveTV Cache HIT]', url: absoluteUrl.substring(0, 80), cacheSize: liveSegmentCache.size });
    return { ...cached, source: 'cache' };
  }
  logger.debug({ msg: '[LiveTV Cache MISS]', url: absoluteUrl.substring(0, 80), cacheSize: liveSegmentCache.size });

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

function getVodCacheKey(videoId, type) {
  return `${type}:${videoId}`;
}

function getCachedVodFinalUrl(cacheKey, now = Date.now()) {
  const entry = vodResolveCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt > now) return entry;
  return entry;
}

function storeVodFinalUrl(cacheKey, finalUrl) {
  const now = Date.now();
  vodResolveCache.set(cacheKey, {
    url: finalUrl,
    createdAt: now,
    expiresAt: now + VOD_RESOLVE_TTL_MS,
    staleUntil: now + VOD_RESOLVE_STALE_TTL_MS
  });
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

function formatLiveTvBufferStatus(profile = {}, fallback = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const f = fallback && typeof fallback === 'object' ? fallback : {};
  const segmentDurationSec = Number(p.segmentDurationSec || f.segmentDurationSec || 6);
  const segmentCount = Number(p.segmentCount || f.segmentCount || 30);
  const isEnabled = !!p.enabled || !!f.enabled;
  const status = String(p.status || f.status || (isEnabled ? 'idle' : 'disabled'));

  return {
    channelId: String(p.channelId || f.channelId || ''),
    channelTitle: String(p.channelTitle || f.channelTitle || ''),
    enabled: isEnabled,
    warmupMode: String(p.warmupMode || f.warmupMode || 'on-demand'),
    segmentDurationSec,
    segmentCount,
    targetBufferSec: segmentDurationSec * segmentCount,
    status,
    statusNote: p.statusNote || f.statusNote || null,
    lastWarmupAt: p.lastWarmupAt || f.lastWarmupAt || null,
    lastReadyAt: p.lastReadyAt || f.lastReadyAt || null,
    lastError: p.lastError || f.lastError || null,
    updatedAt: p.updatedAt || f.updatedAt || null,
    createdAt: p.createdAt || f.createdAt || null,
    shouldDelayPlayback: isEnabled && status === 'warming'
  };
}

function getLiveTvBufferProfileModel(req) {
  return req.app.locals.models?.LiveTvBufferProfile || require('../models/livetv-buffer-profile.model');
}

router.get('/api/livetv-buffer/:channelId/status', async (req, res) => {
  try {
    const parsed = liveTvBufferStatusSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parâmetros inválidos' });
    }

    const channelId = parsed.data.channelId;
    const LiveTvBufferProfile = getLiveTvBufferProfileModel(req);

    if (!LiveTvBufferProfile) {
      return res.json({
        ok: true,
        data: formatLiveTvBufferStatus({ channelId, enabled: false, status: 'disabled' })
      });
    }

    const profile = await LiveTvBufferProfile.findOne({ channelId }).lean();
    return res.json({
      ok: true,
      data: formatLiveTvBufferStatus(profile || { channelId, enabled: false, status: 'disabled' })
    });
  } catch (error) {
    logger.warn({ msg: 'erro ao consultar status do livetv buffer', error: error.message });
    return res.status(500).json({ error: 'Falha ao consultar status' });
  }
});

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
    const cacheKey = getVodCacheKey(videoId, type);
    const cached = getCachedVodFinalUrl(cacheKey);

    let finalUrl = cached && cached.expiresAt > Date.now() ? cached.url : null;

    if (!finalUrl) {
      const response = await axios.get(streamUrl, {
        httpAgent: residentialProxyAgent || undefined,
        httpsAgent: residentialProxyAgent || undefined,
        headers: getRelayRequestHeaders(),
        maxRedirects: 0,
        timeout: 12000,
        validateStatus: (status) => status >= 200 && status <= 302
      });

      finalUrl = response.headers.location;

      if (finalUrl) {
        storeVodFinalUrl(cacheKey, finalUrl);
      }
    }

    if (!finalUrl) {
      if (cached && cached.url && cached.staleUntil > Date.now()) {
        finalUrl = cached.url;
      } else {
        return res.status(404).send('Falha ao capturar IP do video.');
      }
    }

    const urlLimpa = finalUrl.replace(/^https?:\/\//, '');

    logger.info({ msg: 'Delegando IP bruto para o Nginx', videoId, urlLimpa });

    if (req.headers.range) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Accel-Buffering', 'no');
    }

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

// ==========================================
// 🚀 INJEÇÃO DO PROXY DE MANIFESTO DE ALTA PERFORMANCE
// ==========================================
router.get('/api/hls-proxy/manifest', async (req, res, next) => {
  try {
    const tokenUrl = req.query.token;
    if (!tokenUrl) return res.status(400).send('Missing token parameter');

    let manifestUrl;
    try {
      manifestUrl = Buffer.from(tokenUrl, 'base64').toString('utf-8');
    } catch (e) {
      manifestUrl = hlsProxyService.decryptUrl(tokenUrl) || tokenUrl;
    }

    if (!manifestUrl.includes('b-cdn.net') && !manifestUrl.includes('bunny')) {
      logger.error(`[Segurança] Bloqueio preventivo: Origem não reconhecida: ${manifestUrl}`);
      return res.status(403).send('Unauthorized manifest source');
    }

    const rewrittenManifest = await hlsProxyService.getManifest(manifestUrl, '/api/hls-proxy');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, private, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    return res.status(200).send(rewrittenManifest);
  } catch (error) {
    logger.error({ msg: 'Falha fatal na entrega de manifesto assinado', error: error.message });
    return res.status(500).send('Internal streaming error');
  }
});

module.exports = router;