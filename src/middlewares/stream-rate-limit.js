const rateLimit = require('express-rate-limit');

const streamRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // equivalente ao comportamento legado por minuto
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' }
});

module.exports = streamRateLimit;