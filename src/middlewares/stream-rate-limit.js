const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const redisClient = require('../lib/redis');

const config = {
  windowMs: 60 * 1000,
  max: 100, // equivalente ao comportamento legado por minuto
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' }
};

if (redisClient) {
  config.store = new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  });
}

const streamRateLimit = rateLimit(config);

module.exports = streamRateLimit;