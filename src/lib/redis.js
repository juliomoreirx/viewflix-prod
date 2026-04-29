const Redis = require('ioredis');
const env = require('../config/env');
const logger = require('./logger');

let redisClient = null;

if (env.REDIS_URI) {
  try {
    redisClient = new Redis(env.REDIS_URI, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) {
          logger.warn({ msg: 'Redis timeout/disconnect, fallback to memory' });
          return null; // stop retrying
        }
        return Math.min(times * 50, 2000);
      }
    });

    redisClient.on('error', (err) => {
      logger.error({ msg: 'Redis connection error', error: err.message });
    });

    redisClient.on('connect', () => {
      logger.info({ msg: 'Redis connected successfully' });
    });
  } catch (error) {
    logger.error({ msg: 'Failed to initialize Redis', error: error.message });
  }
}

module.exports = redisClient;
