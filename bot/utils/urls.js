const config = require('../config');

function toAbsoluteUrl(url = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(config.dynamic.DOMINIO_PUBLICO || '').replace(/\/$/, '');
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

function toTelegramUrl(url = '') {
  if (!url) return '';
  let normalized = String(url);
  if (/\.ngrok-free\.app\b/i.test(normalized)) {
    normalized = normalized.includes('?')
      ? `${normalized}&ngrok-skip-browser-warning=1`
      : `${normalized}?ngrok-skip-browser-warning=1`;
  }
  return encodeURI(normalized);
}

module.exports = {
  toAbsoluteUrl,
  toTelegramUrl
};