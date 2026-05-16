// src/services/hls-bunny-upload.service.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const logger = require('../lib/logger');

/**
 * HLS Bunny Upload Service
 * Uploads transcoded HLS files to Bunny CDN with organized structure:
 * /content/{contentId}/index.m3u8
 * /content/{contentId}/{segmentNumber}.ts
 */

class HLSBunnyUploadService {
  constructor() {
    this.bunnyStorageKey = process.env.BUNNY_STORAGE_KEY;
    this.bunnyStorageName = process.env.BUNNY_STORAGE_NAME;
    this.bunnyApiUrl = 'https://storage.bunnycdn.com';
    this.bunnyPullZoneUrl = process.env.BUNNY_PULL_ZONE_URL;
    this.maxRetries = process.env.BUNNY_CACHE_RETRIES || 2;
  }

  /**
   * Upload HLS files to Bunny
   * @param {string} hlsDir - Local directory with index.m3u8 + segments
   * @param {string} contentId - Content ID (videoId for episode or movieId)
   * @param {string} contentType - 'movie' or 'series'
   * @param {Object} seriesInfo - Optional: {season, episodeName} for series organization
   * @param {string} mp4FileName - Optional: MP4 filename for movies (without .mp4)
   * @returns {Promise<{success: boolean, manifestUrl: string, uploadedFiles: number, error?: string}>}
   */
  async uploadHLSToBundle(hlsDir, contentId, contentType = 'movie', seriesInfo = null, mp4FileName = null) {
    try {
      logger.info(`[HLS Bunny Upload] Starting: ${contentId} (${hlsDir})`);

      const files = await fs.readdir(hlsDir);
      if (!files.includes('index.m3u8')) {
        throw new Error('index.m3u8 not found in transcoded directory');
      }

      // Bunny path structure:
      // Movies: /movies/{titleSlug}-{videoId}/ (e.g., a-abelha-maya-o-filme-2014-60003/)
      // Series: /series/{titleSlug}/season-{N}/s##e##-{videoId}/ (e.g., series/os-cavaleiros-do-zodiaco-1986/season-1/s01e02-385659/)
      let bunnyPath;
      if (contentType === 'series' && seriesInfo && seriesInfo.season && seriesInfo.episodeName) {
        const seriesName = this._slugify(seriesInfo.seriesTitle || 'series');
        bunnyPath = `series/${seriesName}/season-${seriesInfo.season}/${this._slugify(seriesInfo.episodeName)}-${contentId}`;
      } else if (contentType === 'movie' && mp4FileName) {
        bunnyPath = `movies/${mp4FileName}`;
      } else {
        bunnyPath = `content/${contentType}/${contentId}`;
      }

      // ==========================================
      // 🚀 PROGRAMAÇÃO DE ELITE: POOL DE CONCORRÊNCIA PARALELA
      // ==========================================
      let uploadedCount = 0;
      const errors = [];
      
      // Lemos o limite do .env ou aplicamos 10 uploads simultâneos por padrão para não saturar
      const CONCURRENCY_LIMIT = parseInt(process.env.BUNNY_UPLOAD_CONCURRENCY, 10) || 10;

      // Filtramos apenas os arquivos válidos em disco antes de abrir a fila paralela
      const filesToUpload = [];
      for (const file of files) {
        const localFilePath = path.join(hlsDir, file);
        const stats = await fs.stat(localFilePath);
        if (stats.isFile()) {
          filesToUpload.push({ file, localFilePath });
        }
      }

      logger.info(`[HLS Bunny Upload] Mapeados ${filesToUpload.length} ficheiros para processamento. Pool de Concorrência: ${CONCURRENCY_LIMIT}`);

      let pointer = 0;

      // Função worker que consome a fila dinamicamente de forma síncrona/atómica
      const worker = async () => {
        while (pointer < filesToUpload.length) {
          const currentIdx = pointer++;
          if (currentIdx >= filesToUpload.length) break;

          const { file, localFilePath } = filesToUpload[currentIdx];

          try {
            await this._uploadFileToBunny(localFilePath, file, bunnyPath);
            uploadedCount++;
          } catch (err) {
            logger.error(`[HLS Bunny Upload] Failed to upload ${file}:`, err);
            errors.push({ file, error: err.message });
          }
        }
      };

      // Dispara os workers em paralelo respeitando o limite máximo definido
      const workersPool = [];
      const activeWorkersCount = Math.min(CONCURRENCY_LIMIT, filesToUpload.length);
      
      for (let i = 0; i < activeWorkersCount; i++) {
        workersPool.push(worker());
      }

      // Aguarda que todos os workers terminem de esvaziar a fila de segmentos
      await Promise.all(workersPool);

      if (errors.length > 0) {
        logger.warn(`[HLS Bunny Upload] ${errors.length} files failed to upload`);
      }

      const manifestUrl = this._constructManifestUrl(bunnyPath);

      logger.info(
        `[HLS Bunny Upload] Complete: ${uploadedCount}/${files.length} files, manifest: ${manifestUrl}`
      );

      return {
        success: uploadedCount > 0,
        manifestUrl,
        uploadedFiles: uploadedCount,
        totalFiles: files.length,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      logger.error('[HLS Bunny Upload] Error:', error);
      throw error;
    }
  }

  /**
   * Upload single file to Bunny storage
   * @private
   */
  async _uploadFileToBunny(filePath, fileName, bunnyPath, attempt = 1) {
    try {
      const fileContent = await fs.readFile(filePath);
      const uploadUrl = `${this.bunnyApiUrl}/${this.bunnyStorageName}/${bunnyPath}/${fileName}`;

      const response = await axios.put(uploadUrl, fileContent, {
        headers: {
          'AccessKey': this.bunnyStorageKey,
          'Content-Type': this._getContentType(fileName)
        },
        timeout: 30000
      });

      logger.debug(`[HLS Bunny Upload] Uploaded: ${fileName} (${fileContent.length} bytes)`);
      return response.status === 201 || response.status === 200;
    } catch (error) {
      if (attempt < this.maxRetries) {
        logger.warn(
          `[HLS Bunny Upload] Retry ${attempt}/${this.maxRetries} for ${fileName}`
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Backoff
        return this._uploadFileToBunny(filePath, fileName, bunnyPath, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Delete HLS content from Bunny
   * @param {string} contentId - Content ID to delete
   * @param {string} contentType - 'movie' or 'series'
   * @param {Object} seriesInfo - Optional: {season, episodeName} for series
   * @returns {Promise<boolean>}
   */
  async deleteHLSFromBunny(contentId, contentType = 'movie', seriesInfo = null) {
    try {
      let bunnyPath;
      if (contentType === 'series' && seriesInfo && seriesInfo.season && seriesInfo.episodeName) {
        bunnyPath = `content/series/season-${seriesInfo.season}/${this._slugify(seriesInfo.episodeName)}-${contentId}`;
      } else {
        bunnyPath = `content/${contentType}/${contentId}`;
      }

      const deleteUrl = `${this.bunnyApiUrl}/${this.bunnyStorageName}/${bunnyPath}/`;

      const response = await axios.delete(deleteUrl, {
        headers: {
          'AccessKey': this.bunnyStorageKey
        },
        timeout: 10000
      });

      logger.info(`[HLS Bunny Upload] Deleted: ${bunnyPath}`);
      return response.status === 200 || response.status === 204;
    } catch (error) {
      logger.error('[HLS Bunny Upload] Delete error:', error);
      throw error;
    }
  }

  /**
   * Get manifest URL for playback
   * @private
   */
  _constructManifestUrl(bunnyPath) {
    return `https://${this.bunnyPullZoneUrl}/${bunnyPath}/index.m3u8`;
  }

  /**
   * Get content type from file extension
   * @private
   */
  _getContentType(fileName) {
    if (fileName.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (fileName.endsWith('.ts')) return 'video/mp2t';
    return 'application/octet-stream';
  }

  /**
   * Slugify helper
   * @private
   */
  _slugify(value = '') {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 120);
  }

  /**
   * Get manifest URL for content ID
   * @param {string} contentId - Content ID
   * @param {string} contentType - 'movie' or 'series'
   * @param {Object} seriesInfo - Optional: {season, episodeName} for series
   * @returns {string} Manifest URL
   */
  getManifestUrl(contentId, contentType = 'movie', seriesInfo = null) {
    let bunnyPath;
    if (contentType === 'series' && seriesInfo && seriesInfo.season && seriesInfo.episodeName) {
      const seriesName = this._slugify(seriesInfo.seriesTitle || 'series');
      bunnyPath = `series/${seriesName}/season-${seriesInfo.season}/${this._slugify(seriesInfo.episodeName)}-${contentId}`;
    } else {
      bunnyPath = `content/${contentType}/${contentId}`;
    }
    return this._constructManifestUrl(bunnyPath);
  }
}

module.exports = new HLSBunnyUploadService();