// src/services/hls-proxy.service.js
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../lib/logger');

/**
 * HLS Proxy Service — Versão Titanium Edge Ultra v2
 * Proxies HLS manifest and segments from Bunny CDN to bypass CORS issues
 * Protege contra bloqueios 403 e corrige falhas de quebras de linha (\r\n) em nível sênior.
 */

class HLSProxyService {
  constructor() {
    this.manifestCache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutos
    
    this.encryptionKey = this._getEncryptionKey();
    this.bunnyTokenKey = process.env.BUNNY_TOKEN_KEY;
    this.bunnyPullZoneUrl = process.env.BUNNY_PULL_ZONE_URL || 'viewflix.b-cdn.net';
  }

  /**
   * Get encryption key (32 bytes for AES-256)
   * @private
   */
  _getEncryptionKey() {
    const key = process.env.HLS_PROXY_ENCRYPTION_KEY;
    if (key && key.length === 64) {
      return Buffer.from(key, 'hex');
    }
    const generated = crypto.randomBytes(32);
    return generated;
  }

  /**
   * Encrypt a URL using AES-256-GCM (Mantido para retrocompatibilidade)
   */
  encryptUrl(url) {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + authTag.toString('hex');
    } catch (error) {
      logger.error('[HLS Proxy] Encryption failed:', error.message);
      throw error;
    }
  }

  /**
   * Decrypt a URL token
   */
  decryptUrl(token) {
    try {
      const parts = token.split(':');
      if (parts.length !== 3) return null;

      const [ivHex, encryptedHex, authTagHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
    } catch (error) {
      return null;
    }
  }

  /**
   * 🚀 GERADOR DE ASSINATURA CRIPTOGRÁFICA DA BUNNY CDN
   * Cria os parâmetros de autenticação MD5 Token sem conversão de strings binárias
   */
  signBunnyPath(videoPath, expiryWindow = 7200) {
    if (!this.bunnyTokenKey) {
      logger.warn('[HLS Proxy] ⚠️ Chave BUNNY_TOKEN_KEY ausente no .env.');
      return videoPath;
    }

    let cleanPath = String(videoPath).trim();
    if (!cleanPath.startsWith('/')) {
      cleanPath = '/' + cleanPath;
    }

    const expires = Math.floor(Date.now() / 1000) + expiryWindow;
    const hashableString = this.bunnyTokenKey + cleanPath + expires;
    
    // Executa o digest direto para base64 em nível de buffer de memória nativo
    const token = crypto.createHash('md5')
      .update(hashableString)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return `${cleanPath}?token=${token}&expires=${expires}`;
  }

  /**
   * Obtém e reescreve o manifesto index.m3u8
   * @param {string} manifestUrl - URL crua do manifesto
   */
  async getManifest(manifestUrl, proxyPrefix = '/api/hls-proxy') {
    if (!manifestUrl) {
      throw new Error('Manifest URL is required');
    }

    const cacheKey = manifestUrl;
    const cached = this.manifestCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.content;
    }

    try {
      const urlParsed = new URL(manifestUrl);
      
      // Auto-assinatura de segurança de 5 minutos para permissão de leitura da VPS
      const signedPathForFetch = this.signBunnyPath(urlParsed.pathname, 300);
      const secureFetchUrl = `https://${urlParsed.host}${signedPathForFetch}`;

      logger.info(`[HLS Proxy] Solicitando manifesto autenticado à CDN: ${secureFetchUrl.substring(0, 90)}...`);

      const response = await axios.get(secureFetchUrl, {
        timeout: 10000,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Referer': 'https://watch.viewflix.space/'
        }
      });

      let manifestContent = response.data;
      const pathnameBase = urlParsed.pathname.substring(0, urlParsed.pathname.lastIndexOf('/'));

      // ⚔️ CORREÇÃO CIRÚRGICA: Captura os segmentos tratando de forma segura o \r opcional no fim da linha
      manifestContent = manifestContent.replace(
        /^(?!#|http)([^\r\n]+\.ts)\r?$/gm,
        (match, segment) => {
          // Limpa qualquer resíduo de espaço ou quebra de bloco
          const segmentLimpo = String(segment).trim();
          const pathSegmentoFisico = `${pathnameBase}/${segmentLimpo}`;
          
          const segmentoAssinadoComQuery = this.signBunnyPath(pathSegmentoFisico, 7200);
          return `https://${this.bunnyPullZoneUrl}${segmentoAssinadoComQuery}`;
        }
      );

      this.manifestCache.set(cacheKey, {
        content: manifestContent,
        timestamp: Date.now()
      });

      return manifestContent;
    } catch (error) {
      logger.error(`[HLS Proxy] Falha crítica ao processar manifesto: ${manifestUrl}`, error.message);
      throw error;
    }
  }

  async getSegment(encryptedToken) {
    throw new Error('Endpoint desativado — Os fragmentos rodam direto na Edge CDN.');
  }

  clearCache() {
    this.manifestCache.clear();
    logger.info('[HLS Proxy] Manifest cache cleared');
  }

  cleanOldCache() {
    const now = Date.now();
    for (const [key, value] of this.manifestCache.entries()) {
      if (now - value.timestamp > this.cacheTTL) {
        this.manifestCache.delete(key);
      }
    }
  }
}

module.exports = new HLSProxyService();