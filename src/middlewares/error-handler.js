const logger = require('../lib/logger');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Rota não encontrada' });
}

function errorHandler(err, req, res, _next) {
  logger.error({
    msg: 'Unhandled error',
    requestId: req.requestId,
    path: req.originalUrl,
    method: req.method,
    error: {
      message: err.message,
      stack: err.stack
    }
  });

  if (res.headersSent) return;
  res.status(err.statusCode || 500).json({
    error: 'Erro interno do servidor',
    requestId: req.requestId
  });
}

module.exports = { notFoundHandler, errorHandler };