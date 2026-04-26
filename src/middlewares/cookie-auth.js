// src/middlewares/cookie-auth.js
// Middleware para proteger rotas de gerenciamento de cookies

const logger = require('../lib/logger');

function cookieAuthMiddleware(req, res, next) {
  // Permitir requests locais (localhost, 127.0.0.1)
  const clientIp = req.ip || req.connection.remoteAddress;
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp?.includes('127.0.0.1');

  if (isLocal) {
    return next();
  }

  // Verificar header Authorization
  const authHeader = req.headers['authorization'];
  const apiKey = process.env.COOKIE_REFRESH_API_KEY;

  if (!apiKey) {
    logger.warn('[CookieAuth] COOKIE_REFRESH_API_KEY não configurado');
    return res.status(500).json({ error: 'Autenticação não configurada' });
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('[CookieAuth] Tentativa de acesso sem autenticação', { ip: clientIp });
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const token = authHeader.substring(7);

  if (token !== apiKey) {
    logger.warn('[CookieAuth] Token inválido', { ip: clientIp });
    return res.status(403).json({ error: 'Token inválido' });
  }

  next();
}

module.exports = cookieAuthMiddleware;
