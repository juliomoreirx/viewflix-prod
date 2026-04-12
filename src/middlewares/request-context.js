const { v4: uuidv4 } = require('uuid');

function requestContext(req, res, next) {
  const requestId = req.headers['x-request-id'] || uuidv4();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

module.exports = requestContext;