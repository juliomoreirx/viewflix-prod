const crypto = require('crypto');
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
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { AccessKey: this.storageKey }
    });
    return response.ok;
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

    const url = this.getStorageUrl(remotePath);
    const pass = new PassThrough();

    let uploaded = 0;
    const total = contentLength ? Number(contentLength) : 0;

    pass.on('data', (chunk) => {
      uploaded += chunk.length;
      if (typeof onProgress === 'function') {
        const percent = total ? Math.min(100, Math.round((uploaded / total) * 100)) : null;
        onProgress({ uploadedBytes: uploaded, totalBytes: total, percent });
      }
    });

    const responsePromise = fetch(url, {
      method: 'PUT',
      headers: {
        AccessKey: this.storageKey,
        'Content-Type': 'application/octet-stream',
        ...(total ? { 'Content-Length': String(total) } : {})
      },
      body: pass,
      duplex: 'half'
    });

    stream.pipe(pass);

    const response = await responsePromise;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Bunny upload failed: ${response.status} ${text}`);
    }

    return true;
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
