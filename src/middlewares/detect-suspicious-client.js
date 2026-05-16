// src/middlewares/detect-suspicious-client.js
const logger = require('../lib/logger');

function detectSuspiciousClient(req, res, next) {
  const userAgent = req.headers['user-agent'];

  // Bots preguiçosos muitas vezes não enviam header nenhum
  if (!userAgent || userAgent.trim() === '') {
    logger.warn({ msg: 'Cliente suspeito (Sem User-Agent)', requestId: req.requestId, ip: req.ip });
    return res.status(403).json({ error: 'Access denied' });
  }

  const uaLower = userAgent.toLowerCase();
  const suspiciousAgents = [
    'wget', 'curl', 'python-requests', 'java', 'go-http-client',
    'download', 'bot', 'spider', 'crawler', 'scraper', 'axios',
    'node-fetch', 'okhttp', 'apache-httpclient', 'downloader', 'postman'
  ];

  if (suspiciousAgents.some(a => uaLower.includes(a))) {
    logger.warn({
      msg: 'Cliente suspeito detetado (User-Agent banido)',
      requestId: req.requestId,
      ip: req.ip,
      userAgent
    });
    return res.status(403).json({ error: 'Access denied' });
  }

  next();
}

module.exports = detectSuspiciousClient;