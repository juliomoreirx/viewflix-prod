const axios = require('axios');
const logger = require('../lib/logger');

/**
 * HLS Proxy Service
 * Proxies HLS manifest and segments from Bunny CDN to bypass CORS issues
 * The browser loads from our server (/api/hls-proxy/...) instead of directly from Bunny
 */

class HLSProxyService {
  constructor() {
    this.manifestCache = new Map(); // Cache manifests for 5 minutes
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get HLS manifest from Bunny, with manifest rewriting for segment URLs
   * Rewrites relative segment paths to go through our proxy
   * @param {string} manifestUrl - Original manifest URL from Bunny CDN
   * @param {string} proxyPrefix - Proxy prefix path (e.g., /api/hls-proxy)
   * @returns {Promise<string>} - Rewritten manifest content
   */
  async getManifest(manifestUrl, proxyPrefix = '/api/hls-proxy') {
    if (!manifestUrl) {
      throw new Error('Manifest URL is required');
    }

    // Check cache
    const cacheKey = manifestUrl;
    const cached = this.manifestCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      logger.debug(`[HLS Proxy] Manifest cache hit: ${manifestUrl}`);
      return cached.content;
    }

    try {
      logger.info(`[HLS Proxy] Fetching manifest: ${manifestUrl}`);

      const response = await axios.get(manifestUrl, {
        timeout: 10000,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      let manifestContent = response.data;

      // Rewrite manifest to proxy segment URLs
      // Before: 0000.ts, 0001.ts, ...
      // After: /api/hls-proxy/segment?url=https://bunny.../0000.ts&manifest=https://bunny.../index.m3u8
      const basePath = manifestUrl.substring(0, manifestUrl.lastIndexOf('/'));
      
      manifestContent = manifestContent.replace(
        /^(?!#|http)([^\n]+\.ts)$/gm,
        (match, segment) => {
          const segmentUrl = `${basePath}/${segment}`;
          const encodedUrl = Buffer.from(segmentUrl).toString('base64');
          return `${proxyPrefix}/segment?url=${encodedUrl}`;
        }
      );

      // Cache the rewritten manifest
      this.manifestCache.set(cacheKey, {
        content: manifestContent,
        timestamp: Date.now()
      });

      logger.debug(`[HLS Proxy] Manifest fetched and rewritten: ${manifestUrl}`);
      return manifestContent;
    } catch (error) {
      logger.error(`[HLS Proxy] Failed to fetch manifest: ${manifestUrl}`, error.message);
      throw error;
    }
  }

  /**
   * Get HLS segment from Bunny CDN
   * @param {string} segmentUrl - Full URL to segment (base64 encoded or plain)
   * @returns {Promise<Buffer>} - Segment data
   */
  async getSegment(segmentUrl) {
    if (!segmentUrl) {
      throw new Error('Segment URL is required');
    }

    // Decode if base64
    let decodedUrl = segmentUrl;
    try {
      decodedUrl = Buffer.from(segmentUrl, 'base64').toString('utf-8');
    } catch (e) {
      decodedUrl = segmentUrl;
    }

    try {
      logger.debug(`[HLS Proxy] Fetching segment: ${decodedUrl}`);

      const response = await axios.get(decodedUrl, {
        timeout: 30000,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      logger.debug(`[HLS Proxy] Segment fetched: ${decodedUrl} (${response.data.length} bytes)`);
      return response.data;
    } catch (error) {
      logger.error(`[HLS Proxy] Failed to fetch segment: ${decodedUrl}`, error.message);
      throw error;
    }
  }

  /**
   * Clear manifest cache
   */
  clearCache() {
    this.manifestCache.clear();
    logger.info('[HLS Proxy] Manifest cache cleared');
  }

  /**
   * Clear old cache entries
   */
  cleanOldCache() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.manifestCache.entries()) {
      if (now - value.timestamp > this.cacheTTL) {
        this.manifestCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[HLS Proxy] Cleaned ${cleaned} old manifest cache entries`);
    }
  }
}

module.exports = new HLSProxyService();
