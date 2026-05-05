const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const env = require('../config/env');
const bunnyStorage = require('./bunny-storage.service');
const logger = require('../lib/logger');

const RES_PROXY_HOST = (env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = env.RES_PROXY_USER || '';
const RES_PROXY_PASS = env.RES_PROXY_PASS || '';

let residentialProxyAgent = null;
if (RES_PROXY_HOST && RES_PROXY_PORT) {
  const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 120);
}

function buildStoragePath(purchase) {
  const titleSlug = slugify(purchase.title || 'titulo');
  const videoId = String(purchase.videoId || '').trim();

  if (purchase.mediaType === 'series') {
    const seasonSlug = slugify(`season-${purchase.season || '1'}`);
    const episodeSlug = slugify(purchase.episodeName || `episodio-${videoId}`);
    return `series/${titleSlug}/${seasonSlug}/${episodeSlug}-${videoId}.mp4`;
  }

  return `movies/${titleSlug}-${videoId}.mp4`;
}

function getRelayRequestHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3',
    Referer: 'http://vouver.me/',
    Origin: 'http://vouver.me'
  };
}

async function resolveFinalUrl(mediaType, videoId) {
  const login = env.LOGIN_USER || '';
  const senha = env.LOGIN_PASS || '';
  const typePath = mediaType === 'series' ? 'series' : 'movie';
  const streamUrl = `http://goplay.icu/${typePath}/${login}/${senha}/${encodeURIComponent(videoId)}.mp4`;

  const response = await axios.get(streamUrl, {
    httpAgent: residentialProxyAgent || undefined,
    httpsAgent: residentialProxyAgent || undefined,
    headers: getRelayRequestHeaders(),
    maxRedirects: 0,
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status <= 302
  });

  return response.headers.location || streamUrl;
}

function getExpirationHours(mediaType) {
  return mediaType === 'series' ? 7 * 24 : 24;
}

class BunnyCacheService {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  enqueue(purchase, options = {}) {
    if (!purchase || !purchase.videoId) return;
    const task = { purchaseId: purchase._id, purchase, options };
    this.queue.push(task);
    this.processNext();
  }

  async processNext() {
    if (this.processing) return;
    const task = this.queue.shift();
    if (!task) return;

    this.processing = true;
    try {
      await this.processTask(task);
    } catch (error) {
      logger.error({ msg: 'Bunny cache falhou', err: error.message });
    } finally {
      this.processing = false;
      setImmediate(() => this.processNext());
    }
  }

  async processTask({ purchase, options }) {
    const { onProgress, onReady, onError } = options;

    if (!bunnyStorage.isConfigured()) {
      if (typeof onError === 'function') {
        onError(new Error('Bunny Storage não configurado'));
      }
      return;
    }

    const storagePath = purchase.storagePath || buildStoragePath(purchase);

    await purchase.updateOne({
      $set: {
        storagePath,
        cacheStatus: 'pending',
        cacheProgress: 0,
        cacheUpdatedAt: new Date()
      }
    });

    try {
      const exists = await bunnyStorage.exists(storagePath);
      if (exists) {
        const readyAt = new Date();
        const expiresAt = new Date(readyAt.getTime() + getExpirationHours(purchase.mediaType) * 3600 * 1000);
        await purchase.updateOne({
          $set: {
            cacheStatus: 'ready',
            cacheProgress: 100,
            cacheReadyAt: readyAt,
            cacheUpdatedAt: readyAt,
            expiresAt
          }
        });
        if (typeof onReady === 'function') onReady({ storagePath });
        return;
      }

      const finalUrl = await resolveFinalUrl(purchase.mediaType, purchase.videoId);

      await purchase.updateOne({
        $set: {
          cacheStatus: 'uploading',
          cacheProgress: 0,
          cacheUpdatedAt: new Date()
        }
      });

      await bunnyStorage.uploadFromUrl(finalUrl, storagePath, async (progress) => {
        const percent = progress.percent || 0;
        await purchase.updateOne({
          $set: {
            cacheProgress: percent,
            cacheUpdatedAt: new Date()
          }
        });

        if (typeof onProgress === 'function') {
          onProgress(progress);
        }
      });

      const readyAt = new Date();
      const expiresAt = new Date(readyAt.getTime() + getExpirationHours(purchase.mediaType) * 3600 * 1000);
      await purchase.updateOne({
        $set: {
          cacheStatus: 'ready',
          cacheProgress: 100,
          cacheReadyAt: readyAt,
          cacheUpdatedAt: readyAt,
          expiresAt
        }
      });

      if (typeof onReady === 'function') onReady({ storagePath });
    } catch (error) {
      await purchase.updateOne({
        $set: {
          cacheStatus: 'failed',
          cacheError: error.message,
          cacheUpdatedAt: new Date()
        }
      });

      if (typeof onError === 'function') onError(error);
    }
  }
}

module.exports = new BunnyCacheService();
module.exports.buildStoragePath = buildStoragePath;
