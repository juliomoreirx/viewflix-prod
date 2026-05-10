const path = require('path');
const fs = require('fs').promises;
const logger = require('../lib/logger');
const hlsTranscoder = require('./hls-transcoder.service');
const hlsBunnyUpload = require('./hls-bunny-upload.service');

/**
 * HLS Pipeline Service
 * Orchestrates: MP4 Download → Transcode to HLS → Upload to Bunny
 * Integrates with bunny-cache.service for seamless workflow
 */

class HLSPipelineService {
  constructor() {
    this.tempDir = process.env.BUNNY_TEMP_DIR || '/tmp/viewflix-hls';
  }

  /**
   * Process VOD after MP4 upload to Bunny
   * @param {Object} purchase - Purchase object with videoId, title, mediaType, season, episodeName
   * @param {string} mp4Path - Path to downloaded MP4 file
   * @param {string} mp4FileName - Optional: MP4 filename (without extension) for movies
   * @returns {Promise<{success: boolean, manifestUrl: string, error?: string}>}
   */
  async processVODToHLS(purchase, mp4Path, mp4FileName = null) {
    let transcodeDir = null;

    try {
      logger.info(
        `[HLS Pipeline] Starting VOD processing: ${purchase.videoId} (${purchase.mediaType})`
      );

      // Create temporary directory for transcoding
      transcodeDir = path.join(
        this.tempDir,
        'transcode',
        `${purchase.videoId}-${Date.now()}`
      );

      // Step 1: Transcode MP4 to HLS
      logger.info(`[HLS Pipeline] Transcoding: ${mp4Path} → ${transcodeDir}`);
      const transcodeResult = await hlsTranscoder.transcodeToHLS(mp4Path, transcodeDir);

      if (!transcodeResult.success) {
        throw new Error('Transcode failed');
      }

      logger.info(
        `[HLS Pipeline] Transcode complete: ${transcodeResult.segmentCount} segments`
      );

      // Step 2: Upload HLS to Bunny
      logger.info(`[HLS Pipeline] Uploading to Bunny: ${purchase.videoId}`);
      
      // For series, pass season and episodeName for better organization
      const seriesInfo = purchase.mediaType === 'series' 
        ? { 
            season: purchase.season || '1', 
            episodeIndex: purchase.episodeIndex || 1,
            episodeName: purchase.episodeName || 'episodio',
            seriesTitle: purchase.title || 'series'
          }
        : null;

      const uploadResult = await hlsBunnyUpload.uploadHLSToBundle(
        transcodeDir,
        purchase.videoId,
        purchase.mediaType,
        seriesInfo,
        mp4FileName
      );

      if (!uploadResult.success) {
        throw new Error('Upload to Bunny failed');
      }

      logger.info(`[HLS Pipeline] Complete: ${uploadResult.manifestUrl}`);

      return {
        success: true,
        manifestUrl: uploadResult.manifestUrl,
        segmentCount: transcodeResult.segmentCount,
        totalDuration: transcodeResult.totalDuration,
        uploadedFiles: uploadResult.uploadedFiles
      };
    } catch (error) {
      logger.error('[HLS Pipeline] Error:', error);
      throw error;
    } finally {
      // Clean up temporary transcode directory
      if (transcodeDir) {
        try {
          await hlsTranscoder.cleanup(transcodeDir);
        } catch (err) {
          logger.warn('[HLS Pipeline] Cleanup warning:', err);
        }
      }
    }
  }

  /**
   * Get manifest URL for existing VOD in Bunny
   * @param {string} contentId - Video ID
   * @param {string} contentType - 'movie' or 'series'
   * @param {Object} seriesInfo - Optional: {season, episodeName} for series
   * @returns {string} Manifest URL
   */
  getManifestUrl(contentId, contentType = 'movie', seriesInfo = null) {
    return hlsBunnyUpload.getManifestUrl(contentId, contentType, seriesInfo);
  }

  /**
   * Delete HLS content from Bunny
   * @param {string} contentId - Video ID
   * @param {string} contentType - 'movie' or 'series'
   * @param {Object} seriesInfo - Optional: {season, episodeName} for series
   * @returns {Promise<boolean>}
   */
  async deleteVODFromBunny(contentId, contentType = 'movie', seriesInfo = null) {
    return hlsBunnyUpload.deleteHLSFromBunny(contentId, contentType, seriesInfo);
  }
}

module.exports = new HLSPipelineService();
