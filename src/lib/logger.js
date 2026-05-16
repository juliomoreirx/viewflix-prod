// src/lib/logger.js
const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.LOG_LEVEL || (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'LOGIN_PASS',
      'SIGNED_URL_SECRET',
      'JWT_SECRET',
      'RELAY_SECRET',
      'BOT_TOKEN',           
      'MP_ACCESS_TOKEN',     
      'ADMIN_API_TOKEN',     
      'BUNNY_STORAGE_KEY',   
      'BUNNY_PULL_ZONE_KEY', 
      '*.relay_secret',
      '*.token'
    ],
    censor: '[REDACTED]'
  },
  transport: env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
});

module.exports = logger;