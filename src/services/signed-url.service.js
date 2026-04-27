const crypto = require('crypto');
const env = require('../config/env');

const SIGNED_URL_TTL = parseInt(env.SIGNED_URL_TTL || '120', 10);
const WORKER_STREAM_BASE = env.CLOUDFLARE_WORKER_URL || '';
const RELAY_SECRET = env.RELAY_SECRET || '';

function normalizeMediaType(mediaType = 'movie') {
  const normalized = String(mediaType || 'movie').toLowerCase();

  if (normalized === 'live') return 'livetv';
  if (normalized === 'movies') return 'movie';
  if (normalized === 'serie') return 'series';
  if (normalized === 'series') return 'series';
  if (normalized === 'livetv') return 'livetv';

  return 'movie';
}

function gerarUrlAssinada(videoId, userId, mediaType = 'movie') {
  const resolvedMediaType = normalizeMediaType(mediaType);

  if (resolvedMediaType === 'livetv') {
    return `/relay-stream?videoId=${encodeURIComponent(videoId)}&type=livetv&relay_secret=${encodeURIComponent(RELAY_SECRET)}`;
  }

  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;
  const uid = String(userId);
  const videoPath = `/stream/${videoId}.mp4`;

  const secret = env.SIGNED_SECRET || env.SIGNED_URL_SECRET || env.JWT_SECRET;
  const payload = `${videoPath}:${exp}:${uid}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // fallback local se worker não estiver configurado
  if (!WORKER_STREAM_BASE) {
    return `/relay-stream?videoId=${encodeURIComponent(videoId)}&type=${encodeURIComponent(resolvedMediaType)}&relay_secret=${encodeURIComponent(RELAY_SECRET)}`;
  }

  return `${WORKER_STREAM_BASE}${videoPath}?type=${encodeURIComponent(resolvedMediaType)}&uid=${encodeURIComponent(uid)}&exp=${exp}&sig=${sig}`;
}

module.exports = {
  gerarUrlAssinada,
  SIGNED_URL_TTL
};