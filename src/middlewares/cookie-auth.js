// src/middlewares/cookie-auth.js
const logger = require('../lib/logger');
const env = require('../config/env');

function cookieAuthMiddleware(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp?.includes('127.0.0.1');

  if (isLocal) return next();

  const apiKey = env.COOKIE_REFRESH_API_KEY;
  if (!apiKey) {
    logger.warn('[CookieAuth] COOKIE_REFRESH_API_KEY não configurado no ambiente.');
    return res.status(500).json({ error: 'Autenticação não configurada' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ msg: '[CookieAuth] Tentativa de acesso sem autenticação', ip: clientIp });
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const token = authHeader.substring(7);
  if (token !== apiKey) {
    logger.warn({ msg: '[CookieAuth] Token inválido', ip: clientIp });
    return res.status(403).json({ error: 'Token inválido' });
  }

  next();
}

module.exports = cookieAuthMiddleware;