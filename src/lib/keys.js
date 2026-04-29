const crypto = require('crypto');

/**
 * Calcula uma chave determinística para um canal baseada em suas propriedades.
 * Aceita string (raw) ou objeto com campos: url, hls, stream, name, title, id, videoId, key
 */
function computeChannelKey(ch) {
  if (!ch && ch !== '') return null;
  let raw;
  if (typeof ch === 'string') raw = ch;
  else {
    raw = ch.url || ch.hls || ch.stream || ch.name || ch.title || ch.id || ch.videoId || ch.key || JSON.stringify(ch);
  }
  raw = String(raw || '').toLowerCase();
  return crypto.createHash('sha1').update(raw).digest('hex');
}

module.exports = { computeChannelKey };
