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
   * @param {string} contentId - Content ID for organizing in Bunny
   * @param {string} contentType - 'movie' or 'series'
   * @returns {Promise<{success: boolean, manifestUrl: string, uploadedFiles: number, error?: string}>}
   */
  async uploadHLSToBundle(hlsDir, contentId, contentType = 'movie') {
    try {
      logger.info(`[HLS Bunny Upload] Starting: ${contentId} (${hlsDir})`);

      const files = await fs.readdir(hlsDir);
      if (!files.includes('index.m3u8')) {
        throw new Error('index.m3u8 not found in transcoded directory');
      }

      // Bunny path structure: /content/{contentType}/{contentId}/
      const bunnyPath = `content/${contentType}/${contentId}`;

      // Upload all files
      let uploadedCount = 0;
      const errors = [];

      for (const file of files) {
        const localFilePath = path.join(hlsDir, file);
        const stats = await fs.stat(localFilePath);

        if (!stats.isFile()) continue;

        try {
          await this._uploadFileToBunny(localFilePath, file, bunnyPath);
          uploadedCount++;
        } catch (err) {
          logger.error(`[HLS Bunny Upload] Failed to upload ${file}:`, err);
          errors.push({ file, error: err.message });
        }
      }

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
   * @returns {Promise<boolean>}
   */
  async deleteHLSFromBunny(contentId, contentType = 'movie') {
    try {
      const bunnyPath = `content/${contentType}/${contentId}`;
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
   * Get manifest URL for content ID
   * @param {string} contentId - Content ID
   * @param {string} contentType - 'movie' or 'series'
   * @returns {string} Manifest URL
   */
  getManifestUrl(contentId, contentType = 'movie') {
    const bunnyPath = `content/${contentType}/${contentId}`;
    return this._constructManifestUrl(bunnyPath);
  }
}

module.exports = new HLSBunnyUploadService();
