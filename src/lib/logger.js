const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'LOGIN_PASS',
      'SIGNED_URL_SECRET',
      'JWT_SECRET',
      'RELAY_SECRET',
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