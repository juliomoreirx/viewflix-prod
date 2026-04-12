const logger = require('../lib/logger');

function detectSuspiciousClient(req, res, next) {
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();

  const suspiciousAgents = [
    'wget', 'curl', 'python-requests', 'java', 'go-http-client',
    'download', 'bot', 'spider', 'crawler', 'scraper', 'axios',
    'node-fetch', 'okhttp', 'apache-httpclient', 'downloader'
  ];

  const isSuspicious = suspiciousAgents.some(a => userAgent.includes(a));
  if (isSuspicious) {
    logger.warn({
      msg: 'cliente suspeito detectado',
      requestId: req.requestId,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || ''
    });
    return res.status(403).json({ error: 'Access denied' });
  }

  next();
}

module.exports = detectSuspiciousClient;