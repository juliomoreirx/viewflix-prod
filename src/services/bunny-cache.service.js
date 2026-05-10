const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { HttpProxyAgent } = require('http-proxy-agent');
const env = require('../config/env');
const bunnyStorage = require('./bunny-storage.service');
const hlsPipeline = require('./hls-pipeline.service');
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

// Valida se o arquivo é um vídeo válido checando magic bytes
async function isValidVideoFile(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(16);
    await fd.read(buffer, 0, 16, 0);
    await fd.close();

    // MP4 magic bytes: 00 00 00 XX 66 74 79 70 (ftyp box)
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
      return true;
    }
    // MPEG-TS magic byte: 47
    if (buffer[0] === 0x47) {
      return true;
    }
    // Matroska (MKV) magic: 1A 45 DF A3
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
      return true;
    }
    // FLV magic: 46 4C 56 01
    if (buffer[0] === 0x46 && buffer[1] === 0x4c && buffer[2] === 0x56) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
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
          const remoteSize = await bunnyStorage.getContentLength(storagePath).catch(() => null);
          if (remoteSize && remoteSize < 1024 * 100) {
            logDebug({ stage: 'exists-but-small', storagePath, remoteSize, willRetry: true });
            // continua para re-download
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

        // ============================================================
        // STALL TIMER — detecta stream travada
        // ============================================================
        let lastProgressAt = Date.now();
        const stallTimeoutMs = parseInt(env.BUNNY_CACHE_STALL_MS || '90000', 10);

        stallTimer = setInterval(() => {
          if (Date.now() - lastProgressAt > stallTimeoutMs) {
            logDebug({ stage: 'stall-detected', attempt, stallTimeoutMs });
            downloadResponse.data?.destroy?.(new Error('Download stalled'));
          }
        }, 10000);

        // ============================================================
        // PREPARAR ARQUIVO TEMPORÁRIO
        // ============================================================
        tempFile = buildTempFilePath(purchase);
        await ensureDir(path.dirname(tempFile));

        logDebug({ stage: 'temp-download-start', tempFile, method: useCurlDownload ? 'curl' : 'stream' });

        if (useCurlDownload) {
          // ---- Download via curl ----
          await downloadWithCurl(finalUrl, tempFile, logDebug);
        } else {
          // ---- Download via stream axios ----
          // IMPORTANTE: todos os listeners ANTES do .pipe()
          // O stream Node começa a fluir assim que há listeners 'data',
          // então adicionar depois do pipe pode perder chunks → trava em 99%
          const fileWriteStream = fs.createWriteStream(tempFile);
          let downloadedBytes = 0;
          let lastDownloadPercent = 0;

          await new Promise((resolve, reject) => {
            // 1. Listener de erro do source stream
            downloadResponse.data.on('error', (err) => {
              logDebug({ stage: 'download-stream-error', attempt, error: err.message });
              reject(err);
            });

            // 2. Listener de progresso — atualiza lastProgressAt para o stall timer
            downloadResponse.data.on('data', (chunk) => {
              lastProgressAt = Date.now();
              downloadedBytes += chunk.length;

              if (contentLength && typeof onProgress === 'function') {
                // Capeado em 95% durante download; os 5% finais ficam para o upload
                const percent = Math.min(Math.round((downloadedBytes / contentLength) * 100), 95);
                if (percent >= lastDownloadPercent + 5) {
                  lastDownloadPercent = percent;
                  onProgress({
                    percent,
                    downloadedBytes,
                    totalBytes: contentLength,
                    stage: 'downloading'
                  });
                  logDebug({ stage: 'download-progress', percent, downloadedBytes, contentLength });
                }
              }
            });

            // 3. Listeners do arquivo de destino
            fileWriteStream.on('error', reject);
            fileWriteStream.on('finish', resolve);

            // 4. pipe por último — só depois de todos os listeners registrados
            downloadResponse.data.pipe(fileWriteStream);
          });
        }

        // Para o stall timer após download completo
        if (stallTimer) {
          clearInterval(stallTimer);
          stallTimer = null;
        }

        logDebug({ stage: 'temp-download-complete', tempFile });

        // ============================================================
        // VERIFICAR TAMANHO LOCAL
        // ============================================================
        try {
          const st = await fsp.stat(tempFile);
          localSize = Number(st.size || 0);
        } catch (e) {
          localSize = 0;
        }

        // Se download menor que esperado, tenta novamente com curl
        let curlRetries = 0;
        const maxCurlRetries = 3;
        while (
          contentLength &&
          localSize &&
          localSize < Math.max(1024 * 100, Math.round(contentLength * 0.95)) &&
          curlRetries < maxCurlRetries
        ) {
          curlRetries += 1;
          logDebug({ stage: 'download-size-small-curl-retry', expected: contentLength, actual: localSize, attempt: curlRetries });
          try {
            await fsp.unlink(tempFile).catch(() => {});
            await downloadWithCurl(finalUrl, tempFile, logDebug);
            try {
              const st2 = await fsp.stat(tempFile);
              localSize = Number(st2.size || 0);
              logDebug({ stage: 'download-size-after-curl', newSize: localSize, attempt: curlRetries });
            } catch (e) {
              localSize = 0;
            }
          } catch (curlErr) {
            logDebug({ stage: 'curl-retry-failed', error: curlErr.message, attempt: curlRetries });
            if (curlRetries < maxCurlRetries) {
              await new Promise((resolve) => setTimeout(resolve, 2000 * curlRetries));
            }
          }
        }

        if (localSize && localSize < 1024 * 100) {
          throw new Error(`download_incomplete_after_retries size=${localSize}`);
        }

        if (contentLength && localSize && localSize < Math.max(1024 * 100, Math.round(contentLength * 0.95))) {
          throw new Error(`download_incomplete_after_retries expected=${contentLength} actual=${localSize}`);
        }

        // Validar formato do vídeo via magic bytes
        const isValid = await isValidVideoFile(tempFile);
        if (!isValid) {
          logDebug({ stage: 'invalid-video-format', tempFile, size: localSize });
          throw new Error('download_invalid_video_format');
        }

        // ============================================================
        // UPLOAD PARA O BUNNY
        // ============================================================
        // Notifica que está iniciando o upload (96% = limiar entre download e upload)
        if (typeof onProgress === 'function') {
          onProgress({ percent: 96, stage: 'uploading' });
        }

        await purchase.updateOne({
          $set: {
            cacheStatus: 'uploading',
            cacheProgress: 96,
            cacheUpdatedAt: new Date()
          }
        });

        let lastUploadPercent = 0;

        await bunnyStorage.uploadFileFromPath(tempFile, storagePath, async (progress) => {
          // Mapeia 0-100% do upload para 96-99% do progresso total
          // (100% só é marcado após confirmar que o arquivo existe no Bunny)
          const rawPercent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
          const mappedPercent = 96 + Math.round(rawPercent * 3 / 100); // 96..99

          if (mappedPercent >= lastUploadPercent + 1) {
            lastUploadPercent = mappedPercent;

            await purchase.updateOne({
              $set: {
                cacheProgress: mappedPercent,
                cacheUpdatedAt: new Date(),
                cacheStatus: 'uploading'
              }
            });

            if (typeof onProgress === 'function') {
              onProgress({
                percent: mappedPercent,
                uploadedBytes: progress.uploadedBytes,
                totalBytes: progress.totalBytes,
                stage: 'uploading'
              });
            }

            logDebug({ stage: 'upload-progress', rawPercent, mappedPercent });
          }
        });

        // ============================================================
        // CAPTURAR TAMANHO LOCAL ANTES DE REMOVER O ARQUIVO TEMPORÁRIO
        // ============================================================
        localSize = 0;
        try {
          const s = await fsp.stat(tempFile);
          localSize = Number(s.size || 0);
        } catch (e) {
          localSize = 0;
        }

        // Remover arquivo temporário
        await fsp.unlink(tempFile).catch(() => {});
        tempFile = undefined;

        // ============================================================
        // CONFIRMAR QUE O ARQUIVO EXISTE NO BUNNY
        // ============================================================
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

        // Verificar tamanho remoto vs local
        try {
          const remoteSize = await bunnyStorage.getContentLength(storagePath).catch(() => null);
          if (remoteSize && localSize && Math.abs(remoteSize - localSize) > Math.max(100, Math.round(localSize * 0.05))) {
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
          logDebug({ stage: 'size-check-error', error: e.message });
        }

        // ============================================================
        // TRANSCODE MP4 TO HLS (Optional)
        // ============================================================
        const enableHLSTranscode = String(process.env.ENABLE_HLS_TRANSCODE || 'true').toLowerCase() === 'true';
        let manifestUrl = null;

        if (enableHLSTranscode) {
          try {
            await purchase.updateOne({
              $set: {
                cacheStatus: 'transcoding',
                cacheProgress: 99,
                cacheUpdatedAt: new Date()
              }
            });

            if (typeof onProgress === 'function') {
              onProgress({ percent: 99, stage: 'transcoding' });
            }

            logDebug({ stage: 'transcode-start', videoId: purchase.videoId, tempFile });

            const transcodeResult = await hlsPipeline.processVODToHLS(purchase, tempFile);
            
            if (transcodeResult.success) {
              manifestUrl = transcodeResult.manifestUrl;
              logDebug({
                stage: 'transcode-complete',
                videoId: purchase.videoId,
                manifestUrl,
                segmentCount: transcodeResult.segmentCount
              });
            }
          } catch (transcodeError) {
            logDebug({ stage: 'transcode-error', videoId: purchase.videoId, error: transcodeError.message });
            logger.warn(`[Bunny Cache] HLS transcode failed for ${purchase.videoId}: ${transcodeError.message}`);
            // Continue anyway - MP4 is already uploaded, just skip HLS
          }
        }

        // ============================================================
        // MARCAR COMO PRONTO — 100%
        // ============================================================
        const readyAt = new Date();
        await purchase.updateOne({
          $set: {
            cacheStatus: 'ready',
            cacheProgress: 100,
            cacheReadyAt: readyAt,
            cacheUpdatedAt: readyAt,
            storagePath,
            hlsManifestUrl: manifestUrl  // Store HLS manifest URL if available
          }
        });

        if (typeof onProgress === 'function') {
          onProgress({ percent: 100, stage: 'ready' });
        }

        if (typeof onReady === 'function') onReady({ storagePath, manifestUrl });
        logDebug({ stage: 'ready', storagePath, manifestUrl });
        return;

      } catch (error) {
        logDebug({ stage: 'error', attempt, error: error.message });

        if (stallTimer) {
          clearInterval(stallTimer);
          stallTimer = null;
        }

        // Limpar arquivo temporário se existir
        try {
          if (typeof tempFile !== 'undefined' && tempFile) {
            await fsp.unlink(tempFile).catch(() => {});
            tempFile = undefined;
          }
        } catch (_) {}

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