const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
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

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function buildTempFilePath(purchase) {
  const baseDir = env.BUNNY_TEMP_DIR || path.join(os.tmpdir(), 'viewflix-cache');
  const fileName = `${purchase.videoId}-${Date.now()}.mp4`;
  return path.join(baseDir, fileName);
}

function parseCurlPercent(chunk) {
  const text = String(chunk || '');
  const match = text.match(/(\d{1,3})%/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
}

async function downloadWithCurl(url, outputFile, logDebug) {
  await new Promise((resolve, reject) => {
    const args = [
      '-L',
      '--fail',
      '--retry', '3',
      '--retry-delay', '3',
      '--progress-bar',
      '-o', outputFile,
      url
    ];

    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let lastPercent = -1;

    child.stderr.on('data', (data) => {
      const percent = parseCurlPercent(data);
      if (percent !== null && percent !== lastPercent) {
        lastPercent = percent;
        logDebug({ stage: 'curl-download-progress', percent });
      }
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`curl download failed (code ${code})`));
    });
  });
}

function getExpirationHours(mediaType) {
  return mediaType === 'series' ? 7 * 24 : 24;
}

class BunnyCacheService {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.activeCount = 0;
    this.maxConcurrent = parseInt(env.BUNNY_CACHE_CONCURRENCY || '2', 10);
    this.maxRetries = parseInt(env.BUNNY_CACHE_RETRIES || '2', 10);
  }

  enqueue(purchase, options = {}) {
    if (!purchase || !purchase.videoId) return;
    const task = { purchaseId: purchase._id, purchase, options };
    this.queue.push(task);
    this.processNext();
  }

  async processNext() {
    if (this.processing) return;
    this.processing = true;

    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      this.activeCount += 1;
      this.processTask(task)
        .catch((error) => {
          logger.error({ msg: 'Bunny cache falhou', err: error.message });
        })
        .finally(() => {
          this.activeCount -= 1;
          setImmediate(() => this.processNext());
        });
    }

    this.processing = false;
  }

  async processTask({ purchase, options }) {
    const { onProgress, onReady, onError } = options;
    const debug = String(env.BUNNY_CACHE_DEBUG || 'false').toLowerCase() === 'true';
    const logDebug = (payload) => {
      if (!debug) return;
      logger.info({ msg: 'bunny-cache-debug', ...payload });
    };

    if (!bunnyStorage.isConfigured()) {
      if (typeof onError === 'function') {
        onError(new Error('Bunny Storage não configurado'));
      }
      return;
    }

    const storagePath = purchase.storagePath || buildStoragePath(purchase);

    logDebug({ stage: 'start', purchaseId: String(purchase._id), mediaType: purchase.mediaType, videoId: purchase.videoId, storagePath });

    await purchase.updateOne({
      $set: {
        storagePath,
        cacheStatus: 'pending',
        cacheProgress: 0,
        cacheUpdatedAt: new Date()
      }
    });

    let attempt = 0;
    let tempFile;
    let stallTimer;
    let localSize = 0;
    while (attempt <= this.maxRetries) {
      attempt += 1;
      try {
      const exists = await bunnyStorage.exists(storagePath);
      logDebug({ stage: 'exists-check', storagePath, exists });
      if (exists) {
        // Before marking ready, verify the remote file has reasonable size
        // (not a stray 4MB incomplete file from a previous failed attempt)
        const remoteSize = await bunnyStorage.getContentLength(storagePath).catch(() => null);
        if (remoteSize && remoteSize < 1024 * 100) {
          // Remote file is suspiciously small (<100KB), likely incomplete from before
          logDebug({ stage: 'exists-but-small', storagePath, remoteSize, willRetry: true });
          // Continue to re-download instead of marking ready
        } else {
          const readyAt = new Date();
          await purchase.updateOne({
            $set: {
              cacheStatus: 'ready',
              cacheProgress: 100,
              cacheReadyAt: readyAt,
              cacheUpdatedAt: readyAt
            }
          });
          if (typeof onReady === 'function') onReady({ storagePath });
          return;
        }
      }

      const finalUrl = await resolveFinalUrl(purchase.mediaType, purchase.videoId);
      logDebug({ stage: 'resolve-final-url', finalUrl });

      await purchase.updateOne({
        $set: {
          cacheStatus: 'uploading',
          cacheProgress: 0,
          cacheUpdatedAt: new Date()
        }
      });

      // Download via stream (axios) and pipe to Bunny uploadStream to support proxy agents
      logDebug({ stage: 'download-start', url: finalUrl });

      const useCurlDownload = String(env.BUNNY_DOWNLOAD_USE_CURL || 'false').toLowerCase() === 'true';

      const downloadResponse = await axios.get(finalUrl, {
        httpAgent: residentialProxyAgent || undefined,
        httpsAgent: residentialProxyAgent || undefined,
        headers: getRelayRequestHeaders(),
        responseType: 'stream',
        timeout: 0,
        maxRedirects: 3,
        validateStatus: (status) => status >= 200 && status < 400
      });

      logDebug({
        stage: 'download-headers',
        status: downloadResponse.status,
        contentLength: downloadResponse.headers['content-length'] || null,
        contentType: downloadResponse.headers['content-type'] || null
      });

      const contentLength = Number(downloadResponse.headers['content-length']) || undefined;

      let lastProgressAt = Date.now();
      const stallTimeoutMs = parseInt(env.BUNNY_CACHE_STALL_MS || '90000', 10);

      stallTimer = setInterval(() => {
        if (Date.now() - lastProgressAt > stallTimeoutMs) {
          logDebug({ stage: 'stall-detected', attempt, stallTimeoutMs });
          downloadResponse.data?.destroy?.(new Error('Download stalled'));
        }
      }, 10000);

      downloadResponse.data.on('error', (err) => {
        logDebug({ stage: 'download-stream-error', attempt, error: err.message });
      });

      downloadResponse.data.on('data', () => {
        lastProgressAt = Date.now();
      });

      tempFile = buildTempFilePath(purchase);
      await ensureDir(path.dirname(tempFile));

      logDebug({ stage: 'temp-download-start', tempFile, method: useCurlDownload ? 'curl' : 'stream' });

      if (useCurlDownload) {
        await downloadWithCurl(finalUrl, tempFile, logDebug);
      } else {
        const fileWriteStream = fs.createWriteStream(tempFile);

        await new Promise((resolve, reject) => {
          downloadResponse.data.pipe(fileWriteStream);
          downloadResponse.data.on('error', reject);
          fileWriteStream.on('error', reject);
          fileWriteStream.on('finish', resolve);
        });
      }

      if (stallTimer) clearInterval(stallTimer);

      logDebug({ stage: 'temp-download-complete', tempFile });

      // Verify local file size when Content-Length was provided by origin.
      try {
        const st = await fsp.stat(tempFile);
        localSize = Number(st.size || 0);
      } catch (e) {
        localSize = 0;
      }

      // If download is significantly smaller than expected, retry with curl (more robust)
      // Try up to 3 curl retries before giving up
      let curlRetries = 0;
      const maxCurlRetries = 3;
      while (contentLength && localSize && localSize < Math.max(1024 * 100, Math.round(contentLength * 0.95)) && curlRetries < maxCurlRetries) {
        curlRetries += 1;
        logDebug({ stage: 'download-size-small-curl-retry', expected: contentLength, actual: localSize, attempt: curlRetries, maxRetries: maxCurlRetries });
        try {
          // Remove incomplete file and retry with curl
          await fsp.unlink(tempFile).catch(() => {});
          await downloadWithCurl(finalUrl, tempFile, logDebug);
          
          // Recheck size after curl download
          try {
            const st2 = await fsp.stat(tempFile);
            localSize = Number(st2.size || 0);
            logDebug({ stage: 'download-size-after-curl', newSize: localSize, attempt: curlRetries });
          } catch (e) {
            localSize = 0;
          }
        } catch (curlErr) {
          logDebug({ stage: 'curl-retry-failed', error: curlErr.message, attempt: curlRetries });
          // Wait a bit before next retry
          if (curlRetries < maxCurlRetries) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * curlRetries));
          }
        }
      }

      // Final check: if still too small, fail this attempt (will trigger main retry loop)
      // Threshold: reject if < 100MB (typical movie/series is much larger)
      if (localSize && localSize < 1024 * 100) {
        throw new Error(`download_incomplete_after_retries size=${localSize}`);
      }

      if (contentLength && localSize && localSize < Math.max(1024 * 100, Math.round(contentLength * 0.95))) {
        throw new Error(`download_incomplete_after_retries expected=${contentLength} actual=${localSize}`);
      }

      // Perform upload and update DB only after upload callbacks complete.
      let lastPercent = 0;
      await bunnyStorage.uploadFileFromPath(tempFile, storagePath, async (progress) => {
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
        lastPercent = percent;
        await purchase.updateOne({
          $set: {
            cacheProgress: percent,
            cacheUpdatedAt: new Date(),
            cacheStatus: percent >= 1 ? 'uploading' : 'uploading'
          }
        });

        if (debug && percent && percent % 5 === 0) {
          logDebug({ stage: 'upload-progress', percent, uploadedBytes: progress.uploadedBytes, totalBytes: progress.totalBytes });
        }

        if (typeof onProgress === 'function') {
          onProgress(progress);
        }
      });

      // capture local file size before removing
      localSize = 0;
      try {
        const s = await fsp.stat(tempFile);
        localSize = Number(s.size || 0);
      } catch (e) {
        localSize = 0;
      }

      // ensure temp file is removed
      await fsp.unlink(tempFile).catch(() => {});

      // Confirm upload result by checking remote existence and size
      const readyAt = new Date();

      const uploadedExists = await bunnyStorage.exists(storagePath).catch(() => false);
      if (!uploadedExists) {
        await purchase.updateOne({
          $set: {
            cacheStatus: 'failed',
            cacheError: 'upload_not_found_after_transfer',
            cacheUpdatedAt: new Date()
          }
        });
        if (typeof onError === 'function') onError(new Error('Uploaded file not found on Bunny storage'));
        return;
      }

      // verify content-length matches local size when possible
      try {
        const remoteSize = await bunnyStorage.getContentLength(storagePath).catch(() => null);
        if (remoteSize && localSize && Math.abs(remoteSize - localSize) > Math.max(100, Math.round(localSize * 0.05))) {
          // remote size differs significantly from local file -> treat as failed
          await purchase.updateOne({
            $set: {
              cacheStatus: 'failed',
              cacheError: `size_mismatch remote=${remoteSize} local=${localSize}`,
              cacheUpdatedAt: new Date()
            }
          });
          if (typeof onError === 'function') onError(new Error('Uploaded file size mismatch'));
          return;
        }
      } catch (e) {
        // ignore size check errors but keep processing
        logDebug({ stage: 'size-check-error', error: e.message });
      }

      await purchase.updateOne({
        $set: {
          cacheStatus: 'ready',
          cacheProgress: 100,
          cacheReadyAt: readyAt,
          cacheUpdatedAt: readyAt,
          storagePath
        }
      });

      if (typeof onReady === 'function') onReady({ storagePath });
      logDebug({ stage: 'ready', storagePath });
      return;
    } catch (error) {
      logDebug({ stage: 'error', attempt, error: error.message });
      if (stallTimer) clearInterval(stallTimer);
      try {
        if (typeof tempFile !== 'undefined') {
          await fsp.unlink(tempFile).catch(() => {});
        }
      } catch {}
      await purchase.updateOne({
        $set: {
          cacheStatus: attempt > this.maxRetries ? 'failed' : 'uploading',
          cacheError: error.message,
          cacheUpdatedAt: new Date()
        }
      });

      if (attempt > this.maxRetries) {
        if (typeof onError === 'function') onError(error);
        
        // Notificar usuário via Telegram
        try {
          const telegramBot = require('../../telegram-bot');
          if (telegramBot && typeof telegramBot.notificarFalhaCacheAoUsuario === 'function') {
            telegramBot.notificarFalhaCacheAoUsuario(purchase.userId, purchase).catch(() => {});
          }
        } catch (e) {
          logDebug({ stage: 'telegram-notify-error', error: e.message });
        }
        
        return;
      }

      const backoffMs = attempt * 5000;
      logDebug({ stage: 'retrying', attempt, backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    }
  }
}

module.exports = new BunnyCacheService();
module.exports.buildStoragePath = buildStoragePath;
