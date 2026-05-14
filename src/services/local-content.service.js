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
  return String(title || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\[\]\(\){}'"“”‘’,:;.!?@#$%^&*_+=|\\/<>~`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLooseTitle(title) {
  return normalizeTitle(title).replace(/[^a-z0-9]/g, '');
}

function levenshteinDistance(left = '', right = '') {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, (_, row) => [row]);
  for (let col = 1; col <= b.length; col += 1) matrix[0][col] = col;

  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
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

      map.set(key, { title, meta, coverUrl, raw, looseKey: normalizeLooseTitle(title) });
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
  let local = map.get(key) || null;

  if (!local) {
    const looseKey = normalizeLooseTitle(title);
    let bestMatch = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const entry of map.values()) {
      const distance = levenshteinDistance(looseKey, entry.looseKey || '');
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = entry;
        if (distance === 0) break;
      }
    }

    if (bestMatch && bestDistance <= 2) {
      local = bestMatch;
      logger.info({
        msg: 'Local content fuzzy hit',
        type,
        title,
        key,
        looseKey,
        matchedTitle: bestMatch.title,
        distance: bestDistance,
        coverUrl: local.coverUrl || null
      });
    }
  }

  logger.info({
    msg: 'Local content lookup',
    type,
    title,
    key,
    hit: Boolean(local),
    coverUrl: local?.coverUrl || null
  });

  if (!local) {
    logger.warn({
      msg: 'Local content miss',
      type,
      title,
      key
    });
  }

  return local;
}

module.exports = {
  getLocalContentByTitle
};

