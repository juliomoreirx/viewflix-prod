// src/middlewares/request-context.js
const crypto = require('crypto');

function requestContext(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

module.exports = requestContext;