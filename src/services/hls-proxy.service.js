const axios = require('axios');
const crypto = require('crypto');
const logger = require('../lib/logger');

/**
 * HLS Proxy Service
 * Proxies HLS manifest and segments from Bunny CDN to bypass CORS issues
 * Uses AES-256-GCM encryption to hide actual Bunny URLs from client
 * This prevents URL leakage in network inspection tools
 */

class HLSProxyService {
  constructor() {
    this.manifestCache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
    
    // Encryption key from environment or generate one
    this.encryptionKey = this._getEncryptionKey();
  }

  /**
   * Get encryption key (32 bytes for AES-256)
   * @private
   */
  _getEncryptionKey() {
    const key = process.env.HLS_PROXY_ENCRYPTION_KEY;
    if (key && key.length === 64) {
      logger.info('[HLS Proxy] Using HLS_PROXY_ENCRYPTION_KEY from environment');
      return Buffer.from(key, 'hex');
    }

    if (key) {
      logger.warn('[HLS Proxy] HLS_PROXY_ENCRYPTION_KEY has invalid length (expected 64 hex chars), generating new one');
    }

    // Generate and log warning in production
    const generated = crypto.randomBytes(32);
    logger.warn('[HLS Proxy] ⚠️ IMPORTANT: No encryption key set. Set HLS_PROXY_ENCRYPTION_KEY to persist key across restarts:');
    logger.warn('[HLS Proxy] HLS_PROXY_ENCRYPTION_KEY=' + generated.toString('hex'));
    logger.warn('[HLS Proxy] Without this, previously encrypted URLs will become invalid after restart!');
    return generated;
  }

  /**
   * Encrypt a URL using AES-256-GCM
   * Returns encrypted data in format: IV:ENCRYPTED:AUTH_TAG (all hex)
   * This format is safe for URLs and includes authentication to prevent tampering
   * @param {string} url - URL to encrypt
   * @returns {string} - Encrypted token
   */
  encryptUrl(url) {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      
      const encrypted = Buffer.concat([
        cipher.update(url, 'utf8'),
        cipher.final()
      ]);
      
      const authTag = cipher.getAuthTag();
      
      // Format: IV:ENCRYPTED:AUTH_TAG (all hex, URL-safe)
      const token = iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + authTag.toString('hex');
      return token;
    } catch (error) {
      logger.error('[HLS Proxy] Encryption failed:', error.message);
      throw error;
    }
  }

  /**
   * Decrypt a URL token
   * Uses authentication tag to verify token hasn't been tampered with
   * @param {string} token - Encrypted token from encryptUrl()
   * @returns {string|null} - Original URL or null if decryption/auth fails
   */
  decryptUrl(token) {
    try {
      const parts = token.split(':');
      if (parts.length !== 3) {
        logger.warn('[HLS Proxy] Token has invalid format (expected 3 parts)');
        return null;
      }

      const [ivHex, encryptedHex, authTagHex] = parts;
      
      const iv = Buffer.from(ivHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      const url = decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
      return url;
    } catch (error) {
      logger.warn('[HLS Proxy] Decryption/authentication failed (possible token tampering):', error.message);
      return null;
    }
  }

  /**
   * Get HLS manifest from Bunny, with manifest rewriting for segment URLs
   * Rewrites segment paths to use encrypted tokens instead of exposing full URLs
   * @param {string} manifestUrl - Original manifest URL from Bunny CDN
   * @param {string} proxyPrefix - Proxy prefix path (e.g., /api/hls-proxy)
   * @returns {Promise<string>} - Rewritten manifest with encrypted segment URLs
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': 'https://watch.viewflix.space/'
        }
      });

      let manifestContent = response.data;

      // Rewrite manifest to proxy segment URLs with encryption
      // Before: 0000.ts, 0001.ts, ...
      // After: /api/hls-proxy/segment?token=<encrypted>
      const basePath = manifestUrl.substring(0, manifestUrl.lastIndexOf('/'));
      
      manifestContent = manifestContent.replace(
        /^(?!#|http)([^\n]+\.ts)$/gm,
        (match, segment) => {
          const segmentUrl = `${basePath}/${segment}`;
          const encryptedToken = this.encryptUrl(segmentUrl);
          return `${proxyPrefix}/segment?token=${encodeURIComponent(encryptedToken)}`;
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
   * Get HLS segment from Bunny CDN using encrypted token
   * @param {string} encryptedToken - Encrypted segment URL token
   * @returns {Promise<Buffer>} - Segment data
   */
  async getSegment(encryptedToken) {
    if (!encryptedToken) {
      throw new Error('Encrypted token is required');
    }

    // Decrypt the URL
    const segmentUrl = this.decryptUrl(encryptedToken);
    if (!segmentUrl) {
      logger.warn('[HLS Proxy] Security: Invalid/tampered token rejected');
      throw new Error('Invalid or tampered token');
    }

    // Security: Validate URL points to Bunny CDN
    if (!segmentUrl.includes('b-cdn.net') && !segmentUrl.includes('bunny')) {
      logger.error('[HLS Proxy] Security: Attempted unauthorized access to non-Bunny URL');
      throw new Error('Invalid segment URL - must be from Bunny CDN');
    }

    try {
      logger.debug(`[HLS Proxy] Fetching segment (${encryptedToken.substring(0, 20)}...)`);

      const response = await axios.get(segmentUrl, {
        timeout: 30000,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Referer': 'https://watch.viewflix.space/'
        }
      });

      logger.debug(`[HLS Proxy] Segment fetched: ${response.data.length} bytes`);
      return response.data;
    } catch (error) {
      logger.error('[HLS Proxy] Failed to fetch segment', error.message);
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
