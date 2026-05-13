const fs = require('fs-extra');
const path = require('path');
const logger = require('../lib/logger');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const TYPE_DIRS = {
  movies: 'filmes',
  series: 'series'
};

const cache = {
  movies: new Map(),
  series: new Map(),
  lastLoaded: 0
};

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function sanitizeLocalMeta(raw = {}) {
  const { id, tipo, url, capa_local, ...rest } = raw;
  return rest;
}

function normalizeCoverRelativePath(type, capaLocal) {
  const dirName = TYPE_DIRS[type];
  if (!dirName || !capaLocal) return null;

  let normalized = String(capaLocal).replace(/\\/g, '/').trim();
  if (!normalized) return null;

  normalized = normalized.replace(/^\/+/, '');
  normalized = normalized.replace(/^output\//i, '');

  if (normalized.toLowerCase().startsWith(`${dirName}/`)) {
    normalized = normalized.slice(dirName.length + 1);
  }

  return normalized;
}

function buildCoverUrl(type, capaLocal) {
  const dirName = TYPE_DIRS[type];
  if (!dirName) return null;

  const normalized = normalizeCoverRelativePath(type, capaLocal);
  if (!normalized) return null;

  return encodeURI(`/local-content/${dirName}/${normalized}`);
}

async function loadLocalType(type) {
  const dirName = TYPE_DIRS[type];
  if (!dirName) return;

  const rootDir = path.join(OUTPUT_DIR, dirName);
  if (!(await fs.pathExists(rootDir))) return;

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const map = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(rootDir, entry.name);
    const dataPath = path.join(folderPath, 'dados.json');
    if (!(await fs.pathExists(dataPath))) continue;

    try {
      const raw = await fs.readJson(dataPath);
      const title = String(raw.titulo || raw.title || entry.name).trim();
      if (!title) continue;

      const key = normalizeTitle(title);
      const meta = sanitizeLocalMeta(raw);
      const coverUrl = buildCoverUrl(type, raw.capa_local || null);

      map.set(key, { title, meta, coverUrl, raw });
    } catch (err) {
      logger.warn({ msg: 'Falha ao ler dados.json local', file: dataPath, err: err.message });
    }
  }

  cache[type] = map;
}

async function ensureLoaded() {
  if (cache.movies.size > 0 || cache.series.size > 0) return;
  await loadLocalType('movies');
  await loadLocalType('series');
  cache.lastLoaded = Date.now();
  logger.info({
    msg: 'Local content cache carregado',
    movies: cache.movies.size,
    series: cache.series.size
  });
}

async function getLocalContentByTitle(title, type) {
  if (!title) return null;
  await ensureLoaded();

  const key = normalizeTitle(title);
  const map = cache[type] || new Map();
  return map.get(key) || null;
}

module.exports = {
  getLocalContentByTitle
};
