// src/middlewares/error-handler.js
const logger = require('../lib/logger');
const env = require('../config/env');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Rota não encontrada' });
}

function errorHandler(err, req, res, _next) {
  // Logamos sempre o erro completo no backend
  logger.error({
    msg: 'Unhandled error',
    requestId: req.requestId,
    path: req.originalUrl,
    method: req.method,
    error: { message: err.message, stack: err.stack }
  });

  if (res.headersSent) return;

  // Proteção de Produção: Não vazar detalhes do erro para o cliente
  const isProd = env.NODE_ENV === 'production';
  const statusCode = err.statusCode || 500;
  
  const responsePayload = {
    error: statusCode >= 500 ? 'Erro interno do servidor' : err.message,
    requestId: req.requestId
  };

  if (!isProd && statusCode >= 500) {
    responsePayload.detail = err.message; // Só mostra detalhes em dev
  }

  res.status(statusCode).json(responsePayload);
}

module.exports = { notFoundHandler, errorHandler };