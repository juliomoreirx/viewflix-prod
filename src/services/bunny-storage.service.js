const crypto = require('crypto');
const axios = require('axios');
const { spawn } = require('child_process');
const { PassThrough, Readable } = require('stream');
const env = require('../config/env');

const BASE_URL = 'https://storage.bunnycdn.com';

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizePath(path = '') {
  const trimmed = String(path || '').replace(/^\/+/, '');
  return trimmed;
}

function normalizePullzoneHost(hostname = '') {
  const trimmed = String(hostname || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function splitPath(path = '') {
  const normalized = normalizePath(path);
  if (!normalized) return { dir: '', name: '' };
  const parts = normalized.split('/');
  const name = parts.pop() || '';
  const dir = parts.join('/');
  return { dir, name };
}

class BunnyStorageService {
  constructor(config = {}) {
    this.storageKey = config.storageKey || env.BUNNY_STORAGE_KEY || '';
    this.storageName = config.storageName || env.BUNNY_STORAGE_NAME || '';
    this.pullZoneUrl = normalizePullzoneHost(config.pullZoneUrl || env.BUNNY_PULL_ZONE_URL || '');
    this.pullZoneKey = config.pullZoneKey || env.BUNNY_PULL_ZONE_KEY || '';
    this.baseUrl = config.baseUrl || BASE_URL;
    this.logger = config.logger || console;
  }

  isConfigured() {
    return !!(this.storageKey && this.storageName && this.pullZoneUrl && this.pullZoneKey);
  }

  getStorageUrl(remotePath) {
    const path = normalizePath(remotePath);
    return `${this.baseUrl}/${this.storageName}/${path}`;
  }

  async exists(remotePath) {
    if (!this.storageKey || !this.storageName) return false;
    const url = this.getStorageUrl(remotePath);
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { AccessKey: this.storageKey }
      });

      // Only consider the file present if HEAD succeeds and there's a non-empty content-length.
      if (response.ok) {
        const contentLength = Number(response.headers.get('content-length') || '0');
        if (contentLength > 0) return true;
        // If content-length is missing or zero, fall back to listing to be safer.
      }
      if (response.status === 404) return false;
    } catch (error) {
      this.logger.warn({ msg: 'bunny-exists-head-failed', error: error.message, remotePath });
    }

    try {
      const { dir, name } = splitPath(remotePath);
      if (!name) return false;
      const items = await this.list(dir);
      return items.some((item) => String(item?.ObjectName || item?.objectName || '') === name);
    } catch (error) {
      this.logger.warn({ msg: 'bunny-exists-list-failed', error: error.message, remotePath });
      return false;
    }
  }

  async list(path = '') {
    if (!this.storageKey || !this.storageName) return [];
    const normalized = normalizePath(path);
    const url = `${this.baseUrl}/${this.storageName}/${normalized}/`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { AccessKey: this.storageKey, Accept: 'application/json' }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Bunny list failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  async delete(remotePath) {
    if (!this.storageKey || !this.storageName) return false;
    const url = this.getStorageUrl(remotePath);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { AccessKey: this.storageKey }
    });
    return response.ok;
  }

  async uploadStream(remotePath, stream, contentLength, onProgress) {
    if (!this.storageKey || !this.storageName) {
      throw new Error('Bunny Storage não configurado');
    }

    const debug = String(env.BUNNY_CACHE_DEBUG || 'false').toLowerCase() === 'true';
    const logDebug = (payload) => {
      if (!debug) return;
      this.logger.info({ msg: 'bunny-upload-debug', ...payload });
    };

    const url = this.getStorageUrl(remotePath);
    const pass = new PassThrough();

    let uploaded = 0;
    const total = contentLength ? Number(contentLength) : 0;

    pass.on('error', (err) => {
      logDebug({ stage: 'upload-pass-error', error: err.message });
    });

    pass.on('close', () => {
      logDebug({ stage: 'upload-pass-close' });
    });

    pass.on('data', (chunk) => {
      uploaded += chunk.length;
      if (typeof onProgress === 'function') {
        const percent = total ? Math.min(100, Math.round((uploaded / total) * 100)) : null;
        onProgress({ uploadedBytes: uploaded, totalBytes: total, percent });
      }
    });

    logDebug({ stage: 'upload-start', remotePath, contentLength: total || null });

    stream.on('error', (err) => {
      logDebug({ stage: 'upload-source-error', error: err.message });
    });

    stream.on('close', () => {
      logDebug({ stage: 'upload-source-close' });
    });

    stream.pipe(pass);

    let response;
    try {
      response = await axios.put(url, pass, {
      headers: {
        AccessKey: this.storageKey,
        'Content-Type': 'application/octet-stream',
        ...(total ? { 'Content-Length': String(total) } : {})
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
      validateStatus: (status) => status >= 200 && status < 300
      });
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      throw new Error(`Bunny upload failed: ${status || 'unknown'} ${detail}`);
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error(`Bunny upload failed: ${response?.status || 'unknown'}`);
    }

    logDebug({ stage: 'upload-complete', remotePath, status: response.status });
    return true;
  }

  async uploadFileFromPath(filePath, remotePath, onProgress) {
    const useCurl = String(env.BUNNY_UPLOAD_USE_CURL || 'false').toLowerCase() === 'true';
    if (!useCurl) {
      const stream = require('fs').createReadStream(filePath);
      const stats = await require('fs/promises').stat(filePath);
      return this.uploadStream(remotePath, stream, stats.size, onProgress);
    }

    if (!this.storageKey || !this.storageName) {
      throw new Error('Bunny Storage não configurado');
    }

    const url = this.getStorageUrl(remotePath);
    const debug = String(env.BUNNY_CACHE_DEBUG || 'false').toLowerCase() === 'true';
    const logDebug = (payload) => {
      if (!debug) return;
      this.logger.info({ msg: 'bunny-upload-debug', ...payload });
    };

    if (typeof onProgress === 'function') {
      onProgress({ percent: null, uploadedBytes: 0, totalBytes: 0 });
    }

    logDebug({ stage: 'upload-curl-start', remotePath });

    await new Promise((resolve, reject) => {
      const args = [
        '-sS',
        '--fail',
        '--progress-bar',
        '-X', 'PUT',
        '-H', `AccessKey: ${this.storageKey}`,
        '-H', 'Content-Type: application/octet-stream',
        '--upload-file', filePath,
        url
      ];

      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      let lastPercent = -1;
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.stderr.on('data', (data) => {
        const text = data.toString();
        const match = text.match(/(\d{1,3})%/);
        if (match) {
          const percent = Math.max(0, Math.min(100, parseInt(match[1], 10)));
          if (!Number.isNaN(percent) && percent !== lastPercent) {
            lastPercent = percent;
            logDebug({ stage: 'upload-curl-progress', percent });
            if (typeof onProgress === 'function') {
              onProgress({ percent, uploadedBytes: 0, totalBytes: 0 });
            }
          }
        }
      });

      child.on('error', (err) => reject(err));

      child.on('close', (code) => {
        if (code === 0) {
          logDebug({ stage: 'upload-curl-complete', remotePath });
          if (typeof onProgress === 'function') {
            onProgress({ percent: 100, uploadedBytes: 0, totalBytes: 0 });
          }
          resolve();
        } else {
          reject(new Error(`curl upload failed (code ${code}): ${stderr}`));
        }
      });
    });
  }

  async uploadFromUrl(sourceUrl, remotePath, onProgress) {
    const response = await fetch(sourceUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`Origin fetch failed: ${response.status} ${text}`);
    }

    const contentLength = response.headers.get('content-length');
    const readable = Readable.fromWeb(response.body);

    return this.uploadStream(remotePath, readable, contentLength, onProgress);
  }

  getSignedPullZoneUrl(filePath, ttlSeconds = 3600) {
    if (!this.pullZoneUrl || !this.pullZoneKey) return null;

    const expiration = Math.floor(Date.now() / 1000) + ttlSeconds;
    const normalizedPath = `/${normalizePath(filePath)}`;
    const hashable = `${this.pullZoneKey}${normalizedPath}${expiration}`;
    const token = toBase64Url(crypto.createHash('md5').update(hashable).digest());

    return `https://${this.pullZoneUrl}${normalizedPath}?token=${token}&expires=${expiration}`;
  }
}

module.exports = new BunnyStorageService();
module.exports.BunnyStorageService = BunnyStorageService;
