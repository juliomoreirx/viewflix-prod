// src/services/bunny-cache.service.js
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { HttpProxyAgent } = require('http-proxy-agent');
const { Queue, Worker } = require('bullmq'); // 🚀 Motores do BullMQ
const Redis = require('ioredis'); // 🚀 Driver de Conexão Redis
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

function buildHLSPath(purchase) {
  const videoId = String(purchase.videoId || '').trim();

  if (purchase.mediaType === 'series') {
    const titleSlug = slugify(purchase.title || 'titulo');
    const seasonNum = String(purchase.season || '1').padStart(2, '0');
    const episodeNum = String(purchase.episodeIndex || 1).padStart(2, '0');
    
    return `series/${titleSlug}/season-${purchase.season || '1'}/s${seasonNum}e${episodeNum}-${videoId}`;
  }

  const titleSlug = slugify(purchase.title || 'titulo');
  return `movies/${titleSlug}-${videoId}`;
}

function constructHLSManifestUrl(hlsPath) {
  const bunnyPullZoneUrl = process.env.BUNNY_PULL_ZONE_URL || '';
  return `https://${bunnyPullZoneUrl}/${hlsPath}/index.m3u8`;
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
  let lastReportedPercent = -1;
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

    child.stderr.on('data', (data) => {
      const percent = parseCurlPercent(data);
      if (percent !== null && (percent === 0 || percent === 100 || percent % 25 === 0) && percent !== lastReportedPercent) {
        lastReportedPercent = percent;
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

async function isValidVideoFile(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(16);
    await fd.read(buffer, 0, 16, 0);
    await fd.close();

    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return true;
    if (buffer[0] === 0x47) return true;
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return true;
    if (buffer[0] === 0x46 && buffer[1] === 0x4c && buffer[2] === 0x56) return true;
    return false;
  } catch (error) {
    return false;
  }
}

class BunnyCacheService {
  constructor() {
    this.redisConfig = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.redisConnection = new Redis(this.redisConfig, { maxRetriesPerRequest: null });

    // Instanciação da fila do BullMQ gerenciada via Redis
    this.queue = new Queue('bunny-cache-stream', { connection: this.redisConnection });

    // Prática Recomendada para 2GB RAM: Limitar concorrência local para 1 por instância ativada
    this.maxConcurrent = parseInt(env.BUNNY_CACHE_CONCURRENCY || '1', 10);
    this.maxRetries = parseInt(env.BUNNY_CACHE_RETRIES || '2', 10);
    
    this.worker = null;
    // 🚀 EVOLUÇÃO DE ISOLAMENTO: O Worker não liga mais sozinho no constructor!
  }

  /**
   * Ativador explícito do Consumidor Worker (Garante controle de concorrência centralizado)
   */
  startWorker() {
    if (this.worker) return;
    this._initWorker();
    console.log(`⚙️ [BullMQ Worker] Escuta de downloads ativa. Capacidade máxima: ${this.maxConcurrent} job(s) por instância.`);
  }

  /**
   * Enfileira a tarefa de processamento aplicando regras estratégicas de prioridade
   */
  async enqueue(purchase, telegramMetadata = {}) {
    if (!purchase || !purchase.videoId) return;

    // 🚀 EVOLUÇÃO FILA DE PRIORIDADE JUSTA (Fair-Share):
    // Se for download de temporada em massa (bulk), joga a prioridade para 10 (baixa).
    // Se for clique avulso de um filme ou episódio, ganha prioridade 1 (máxima)!
    const isBulk = !!telegramMetadata.bulkStateId;
    const jobPriority = isBulk ? 10 : 1;

    await this.queue.add('process-cache-job', {
      purchaseId: String(purchase._id),
      telegramMetadata: {
        chatId: telegramMetadata.chatId || null,
        statusMessageId: telegramMetadata.statusMessageId || null,
        caption: telegramMetadata.caption || null,
        mediaType: telegramMetadata.mediaType || purchase.mediaType,
        token: purchase.token || null,
        bulkStateId: telegramMetadata.bulkStateId || null,
        episodeName: purchase.episodeName || null
      }
    }, {
      attempts: this.maxRetries + 1,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
      priority: jobPriority // ← INJETADO AQUI
    });
  }

  /**
   * Inicializa o consumidor Worker isolado com concorrência paralela controlada
   * @private
   */
  _initWorker() {
    this.worker = new Worker('bunny-cache-stream', async (job) => {
      const { purchaseId, telegramMetadata } = job.data;

      const db = require('../../bot/services/db.service');
      const PurchasedContentModel = db.getPurchasedContentModel();
      const purchase = await PurchasedContentModel.findById(purchaseId);

      if (!purchase) {
        throw new Error(`[BullMQ Worker] Registro de compra ${purchaseId} não localizado no MongoDB.`);
      }

      await this._executeTaskProcessing(job, purchase, telegramMetadata);

    }, {
      connection: this.redisConnection,
      concurrency: this.maxConcurrent
    });

    this.worker.on('failed', (job, err) => {
      logger.error(`[BullMQ Worker Error] Job ${job?.id} falhou definitivamente: ${err.message}`);
    });
  }

  /**
   * Processador lógico centralizado do faturamento de mídias (Engine Refatorada)
   * @private
   */
  async _executeTaskProcessing(job, purchase, telegramMetadata) {
    const debug = String(env.BUNNY_CACHE_DEBUG || 'false').toLowerCase() === 'true';
    const logDebug = (payload) => {
      if (!debug) return;
      logger.info({ msg: 'bunny-cache-debug', ...payload });
    };

    const emitProgress = async (percent) => {
      await job.updateProgress(percent);
      if (telegramMetadata.chatId && telegramMetadata.statusMessageId && !telegramMetadata.bulkStateId) {
        const bot = require('../../bot/instance');
        await bot.editMessageText(`⏳ *Processando cache:* ${percent}%`, {
          chat_id: telegramMetadata.chatId,
          message_id: telegramMetadata.statusMessageId,
          parse_mode: 'Markdown'
        }).catch(() => {});
      }
    };

    const emitReady = async (manifestUrl) => {
      const bot = require('../../bot/instance');
      
      if (telegramMetadata.bulkStateId && telegramMetadata.statusMessageId && telegramMetadata.chatId) {
        const currentReady = await this.redisConnection.incr(`bulk:${telegramMetadata.bulkStateId}:ready`);
        const totalEpisodes = await this.redisConnection.get(`bulk:${telegramMetadata.bulkStateId}:total`) || 1;
        
        if (Number(currentReady) >= Number(totalEpisodes)) {
          await bot.editMessageText(`✅ *Temporada 100% Liberada!*\n\nTodos os episódios estão salvos em "Meu Conteúdo".`, {
            chat_id: telegramMetadata.chatId,
            message_id: telegramMetadata.statusMessageId,
            parse_mode: 'Markdown'
          }).catch(() => {});
          await this.redisConnection.del(`bulk:${telegramMetadata.bulkStateId}:ready`);
          await this.redisConnection.del(`bulk:${telegramMetadata.bulkStateId}:total`);
        } else {
          await bot.editMessageText(`⏳ *Liberando Temporada...*\n\nProgresso: ${currentReady}/${totalEpisodes} concluídos.\n\n🆕 Último pronto: ${telegramMetadata.episodeName || 'Episódio'}`, {
            chat_id: telegramMetadata.chatId,
            message_id: telegramMetadata.statusMessageId,
            parse_mode: 'Markdown'
          }).catch(() => {});
        }
        return;
      }

      if (telegramMetadata.chatId) {
        if (telegramMetadata.statusMessageId) {
          await bot.deleteMessage(telegramMetadata.chatId, telegramMetadata.statusMessageId).catch(() => {});
        }
        const playerUrl = `${process.env.DOMINIO_PUBLICO}/player/${telegramMetadata.token}`;
        await bot.sendMessage(telegramMetadata.chatId, `✅ *Liberado! Clique no player para assistir:*\n\n${telegramMetadata.caption || ''}`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '▶️ Assistir Agora', url: playerUrl }], [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }]] }
        });
      }
    };

    if (!bunnyStorage.isConfigured()) {
      throw new Error('Bunny Storage não configurado no ecossistema.');
    }

    const storagePath = purchase.storagePath || buildStoragePath(purchase);
    logDebug({ stage: 'start', purchaseId: String(purchase._id), mediaType: purchase.mediaType, videoId: purchase.videoId, storagePath });
    
    logger.info(`[Bunny Cache] Processing ${purchase.mediaType} - ${purchase.title || purchase.videoId}`);

    await purchase.updateOne({
      $set: { storagePath, cacheStatus: 'pending', cacheProgress: 0, cacheUpdatedAt: new Date() }
    });

    const hlsPath = buildHLSPath(purchase);
    const hlsManifestPath = `${hlsPath}/index.m3u8`;

    try {
      const hlsExists = await bunnyStorage.exists(hlsManifestPath);
      if (hlsExists) {
        logDebug({ stage: 'hls-exists', hlsPath, hlsManifestPath });
        const hlsManifestUrl = constructHLSManifestUrl(hlsPath);

        await purchase.updateOne({
          $set: { cacheStatus: 'ready', cacheProgress: 100, cacheReadyAt: new Date(), cacheUpdatedAt: new Date(), hlsManifestUrl }
        });

        await emitReady(hlsManifestUrl);
        return;
      }
    } catch (err) {
      logDebug({ stage: 'hls-check-error', error: err.message });
    }

    let tempFile;
    let stallTimer;
    let localSize = 0;

    const exists = await bunnyStorage.exists(storagePath);
    logDebug({ stage: 'exists-check', storagePath, exists });

    if (exists) {
      const remoteSize = await bunnyStorage.getContentLength(storagePath).catch(() => null);
      if (!(remoteSize && remoteSize < 1024 * 100)) {
        const enableHLSTranscode = String(process.env.ENABLE_HLS_TRANSCODE || 'true').toLowerCase() === 'true';
        let manifestUrl = null;

        if (enableHLSTranscode && !purchase.hlsManifestUrl) {
          try {
            logDebug({ stage: 'transcode-existing-mp4-start', videoId: purchase.videoId });
            await purchase.updateOne({ $set: { cacheStatus: 'transcoding', cacheProgress: 99, cacheUpdatedAt: new Date() } });
            await emitProgress(99);

            const tempTranscodeFile = path.join(env.BUNNY_TEMP_DIR || os.tmpdir(), `transcode-${purchase.videoId}-${Date.now()}.mp4`);
            const mp4Stream = await axios.get(storagePath, {
              responseType: 'stream',
              timeout: 0,
              headers: { 'AccessKey': bunnyStorage.bunnyStorageKey }
            });

            await new Promise((resolve, reject) => {
              const writeStream = fs.createWriteStream(tempTranscodeFile);
              mp4Stream.data.pipe(writeStream);
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
            });

            let mp4FileName = null;
            if (purchase.mediaType === 'movie' && storagePath.includes('/')) {
              const filename = storagePath.split('/').pop();
              mp4FileName = filename.replace(/\.mp4$/i, '');
            }

            const transcodeResult = await hlsPipeline.processVODToHLS(purchase, tempTranscodeFile, mp4FileName);
            if (transcodeResult.success) {
              manifestUrl = transcodeResult.manifestUrl;
            }

            await fsp.unlink(tempTranscodeFile).catch(() => {});
          } catch (transcodeError) {
            logger.warn(`[Bunny Cache] HLS transcode of existing MP4 failed: ${transcodeError.message}`);
          }
        }

        const readyAt = new Date();
        await purchase.updateOne({
          $set: { cacheStatus: 'ready', cacheProgress: 100, cacheReadyAt: readyAt, cacheUpdatedAt: readyAt, storagePath, hlsManifestUrl: manifestUrl }
        });
        await emitReady(manifestUrl);
        return;
      }
    }

    const finalUrl = await resolveFinalUrl(purchase.mediaType, purchase.videoId);
    logDebug({ stage: 'resolve-final-url', finalUrl });

    await purchase.updateOne({ $set: { cacheStatus: 'uploading', cacheProgress: 0, cacheUpdatedAt: new Date() } });

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

    const contentLength = Number(downloadResponse.headers['content-length']) || undefined;
    let lastProgressAt = Date.now();
    const stallTimeoutMs = parseInt(env.BUNNY_CACHE_STALL_MS || '90000', 10);

    stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        downloadResponse.data?.destroy?.(new Error('Download stalled'));
      }
    }, 10000);

    tempFile = buildTempFilePath(purchase);
    await ensureDir(path.dirname(tempFile));

    if (useCurlDownload) {
      await downloadWithCurl(finalUrl, tempFile, logDebug);
    } else {
      const fileWriteStream = fs.createWriteStream(tempFile);
      let downloadedBytes = 0;
      let lastDownloadPercent = 0;

      await new Promise((resolve, reject) => {
        downloadResponse.data.on('error', reject);
        downloadResponse.data.on('data', (chunk) => {
          lastProgressAt = Date.now();
          downloadedBytes += chunk.length;

          if (contentLength) {
            const percent = Math.min(Math.round((downloadedBytes / contentLength) * 100), 95);
            if (percent >= lastDownloadPercent + 5) {
              lastDownloadPercent = percent;
              emitProgress(percent).catch(() => {});
            }
          }
        });

        fileWriteStream.on('error', reject);
        fileWriteStream.on('finish', resolve);
        downloadResponse.data.pipe(fileWriteStream);
      });
    }

    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }

    try {
      const st = await fsp.stat(tempFile);
      localSize = Number(st.size || 0);
    } catch (e) { localSize = 0; }

    if (contentLength && localSize && localSize < Math.max(1024 * 100, Math.round(contentLength * 0.95))) {
      throw new Error(`download_incomplete_after_retries expected=${contentLength} actual=${localSize}`);
    }

    const isValid = await isValidVideoFile(tempFile);
    if (!isValid) throw new Error('download_invalid_video_format');

    const enableHLSTranscode = String(process.env.ENABLE_HLS_TRANSCODE || 'true').toLowerCase() === 'true';
    let manifestUrl = null;

    if (enableHLSTranscode) {
      await purchase.updateOne({ $set: { cacheStatus: 'transcoding', cacheProgress: 97, cacheUpdatedAt: new Date() } });
      await emitProgress(97);

      let mp4FileName = null;
      if (purchase.mediaType === 'movie' && storagePath.includes('/')) {
        const filename = storagePath.split('/').pop();
        mp4FileName = filename.replace(/\.mp4$/i, '');
      }

      const transcodeResult = await hlsPipeline.processVODToHLS(purchase, tempFile, mp4FileName);
      if (transcodeResult.success) {
        manifestUrl = transcodeResult.manifestUrl;
      }
      await fsp.unlink(tempFile).catch(() => {});
    } else {
      await purchase.updateOne({ $set: { cacheStatus: 'uploading', cacheProgress: 96, cacheUpdatedAt: new Date() } });
      await bunnyStorage.uploadFileFromPath(tempFile, storagePath, async (progress) => {
        const rawPercent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
        const mappedPercent = 96 + Math.round(rawPercent * 3 / 100);
        await emitProgress(mappedPercent);
      });
      await fsp.unlink(tempFile).catch(() => {});
    }

    const readyAt = new Date();
    await purchase.updateOne({
      $set: { cacheStatus: 'ready', cacheProgress: 100, cacheReadyAt: readyAt, cacheUpdatedAt: readyAt, storagePath, hlsManifestUrl: manifestUrl }
    });

    await emitProgress(100);
    await emitReady(manifestUrl);
    logger.info(`[Bunny Cache] 🎬 Ready: ${purchase.mediaType} ${purchase.episodeName || purchase.title}`);
  }
}

module.exports = new BunnyCacheService();
module.exports.buildStoragePath = buildStoragePath;